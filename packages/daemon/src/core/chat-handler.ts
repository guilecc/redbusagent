/**
 * @redbusagent/daemon — Chat Handler
 *
 * Bridges WebSocket incoming chat:request messages to the Cognitive Router,
 * streaming LLM responses and tool events back to the TUI in real-time.
 */

import type { DaemonWsServer } from '../infra/ws-server.js';
import type { ChatRequestMessage } from '@redbusagent/shared';
import { PersonaManager, Vault } from '@redbusagent/shared';
import { askLive, askTier2 } from './cognitive-router.js';
import { getLiveEngineConfig } from '../infra/llm-config.js';
import { resolveSenderRole } from './tool-policy.js';
import { calculateComplexityScore } from './heuristic-router.js';
import { CoreMemory } from './core-memory.js';
import { approvalGate, type ApprovalRequest } from './approval-gate.js';
import { enqueueCommandInLane, CommandLane } from './task-queue.js';
import { processMonitorEmitter } from './tools/process-manager.js';
import { HeavyTaskQueue } from './heavy-task-queue.js';
import type { HeartbeatManager } from './gateway/heartbeat.js';

export class ChatHandler {
    private forceLive = false;
    private heartbeat: HeartbeatManager | null = null;

    constructor(private readonly wsServer: DaemonWsServer) {
        // ─── Generalized Approval Gate ──────────────────────────────────
        approvalGate.on('approval_requested', (request: ApprovalRequest) => {
            const emoji = request.reason === 'destructive' ? '⚠️' : '📱';
            const label = request.reason === 'destructive' ? 'SECURITY ALERT' : 'INTRUSIVE ACTION';
            const detail = request.toolName === 'execute_shell_command'
                ? `execute a system command:\n\`${request.description}\``
                : `use **${request.toolName}**: ${request.description}`;

            console.log(`  [ChatHandler] Relaying approval request to TUI: ${request.toolName}`);
            this.wsServer.broadcast({
                type: 'chat:stream:chunk',
                timestamp: new Date().toISOString(),
                payload: { requestId: request.id, delta: `${emoji} ${label}: The agent wants to ${detail}\n\nApprove? (Y/N)` }
            });
            this.wsServer.broadcast({
                type: 'chat:stream:done',
                timestamp: new Date().toISOString(),
                payload: { requestId: request.id, fullText: '', tier: 'live', model: 'system' }
            });
        });

        // The Watcher: Autonomous Reaction Loop
        processMonitorEmitter.on('process_crashed', async ({ alias, logSnippet }) => {
            console.log(`  🚨 [The Watcher] Process crashed: ${alias}. Triggering autonomous reaction.`);

            const requestId = `sys-${Date.now()}`;
            const alertPrompt = `⚠️ [SYSTEM ALERT]: The background process '${alias}' just crashed or threw an error. Last logs:\n\`\`\`\n${logSnippet}\n\`\`\`\n\nPlease analyze this error, use edit_file_blocks or execute_shell_command to fix the code/environment if necessary, and restart the process safely.`;

            // Notify User visually that the system intervened
            this.wsServer.broadcast({
                type: 'log',
                timestamp: new Date().toISOString(),
                payload: { level: 'error', source: 'The Watcher', message: `Background loop '${alias}' crashed. Engaging auto-recovery (Cloud Engine)...` }
            });

            // Feed the synthetic prompt silently back into the router
            // Note: Since score for "error" and "edit_file_blocks" is +40, it will naturally hit Cloud Engine.
            await this.handleChatRequest('system', {
                type: 'chat:request',
                timestamp: new Date().toISOString(),
                payload: {
                    requestId,
                    content: alertPrompt
                }
            });
        });
    }

    /** Attach the HeartbeatManager so we can signal THINKING state */
    setHeartbeat(hb: HeartbeatManager): void {
        this.heartbeat = hb;
    }

    setForceLive(enabled: boolean): void {
        this.forceLive = enabled;
    }

    async handleChatRequest(
        clientId: string,
        message: ChatRequestMessage,
    ): Promise<void> {
        const { requestId } = message.payload;
        let { content, tier, isOnboarding, messages } = message.payload;

        const vaultConfig = Vault.read();
        let targetTier = this.forceLive ? 'live' : tier;

        // ─── Generalized Approval Gate Interception ──────────────────
        if (approvalGate.hasPendingRequests()) {
            const isAffirmative = /^(yes|y|sure|manda bala|pode|sim|claro|please|yeah|yep)\b/i.test(content.trim());
            const pending = approvalGate.getFirstPending();
            const id = approvalGate.getFirstPendingId()!;
            approvalGate.resolveApproval(id, isAffirmative);

            const toolLabel = pending?.toolName ?? 'unknown tool';
            this.wsServer.broadcast({
                type: 'log',
                timestamp: new Date().toISOString(),
                payload: { level: 'info', source: 'System', message: isAffirmative ? `✅ ${toolLabel} approved.` : `❌ ${toolLabel} denied.` }
            });

            this.wsServer.broadcast({
                type: 'chat:stream:done',
                timestamp: new Date().toISOString(),
                payload: { requestId, fullText: '', tier: 'live', model: 'system' }
            });
            return;
        }

        // Reset flag after use
        this.forceLive = false;

        // Special handling for onboarding
        if (isOnboarding) {
            console.log(`  👤 [onboarding] Parsing persona from user input...`);
            const askFnOnboarding = targetTier === 'live' ? askLive : askTier2;
            const onboardingPrompt = `The user is describing their desired agent persona. 
User response: "${content}"

Extract the following information into a JSON object:
{
  "agent_name": "...",
  "user_context": "...",
  "behavioral_guidelines": "..."
}
Return ONLY the JSON object. Do not explain.`;

            const result = await askFnOnboarding(onboardingPrompt, {
                onChunk: (delta) => {
                    // We don't stream the raw JSON parsing to the user
                },
                onDone: (fullText) => {
                    try {
                        // Extract JSON from potential code blocks
                        const jsonMatch = fullText.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            const persona = JSON.parse(jsonMatch[0]);
                            PersonaManager.write(persona);
                            console.log(`  ✅ [onboarding] Persona saved: ${persona.agent_name}`);

                            this.wsServer.broadcast({
                                type: 'chat:stream:chunk',
                                timestamp: new Date().toISOString(),
                                payload: { requestId, delta: `Entendido! De agora em diante, eu sou **${persona.agent_name}**. Meu novo sistema de persona foi configurado com sucesso! Como posso te ajudar hoje?` },
                            });
                        }
                    } catch (err) {
                        console.error('  ❌ [onboarding] Failed to parse persona JSON:', err);
                    }
                },
                onError: (error) => {
                    this.wsServer.broadcast({
                        type: 'chat:error',
                        timestamp: new Date().toISOString(),
                        payload: { requestId, error: `Falha no onboarding: ${error.message}` },
                    });
                }
            });

            this.wsServer.broadcast({
                type: 'chat:stream:done',
                timestamp: new Date().toISOString(),
                payload: {
                    requestId,
                    fullText: '',
                    tier: result.tier,
                    model: result.model,
                },
            });
            return;
        }

        // Trivial escape hatch force-routing to Live Engine (Slash Command menu equivalent)
        if (content.trim().toLowerCase().startsWith('/local')) {
            targetTier = 'live';
            content = content.replace(/^\/local\s*/i, '');
        }

        // ─── Intent Classifier Pre-flight ─────────────────────────────────────
        if (!isOnboarding && content.trim() !== '' && !this.forceLive && !tier) {
            // Cloud-First: all models are treated as full-capability
            const powerClass = 'gold';
            const workerEnabled = vaultConfig?.worker_engine?.enabled ?? false;

            console.log(`  🕵️‍♂️ [pre-router] Calculating heuristic complexity score...`);
            const score = calculateComplexityScore(content, messages || []);

            if (score >= 40) {
                targetTier = 'cloud';
            } else {
                targetTier = 'live';
            }

            // ─── Dual-Cloud: Delegate heavy background tasks to Worker Queue ──
            // If the Worker Engine is enabled and the score indicates heavy work,
            // enqueue a background analysis task and let the Live Engine handle
            // a quick acknowledgement instead of blocking the chat.
            if (workerEnabled && score >= 60) {
                const taskId = HeavyTaskQueue.enqueue({
                    description: `Deep analysis: ${content.slice(0, 80)}...`,
                    prompt: content,
                    type: 'deep_analysis',
                    onComplete: (result) => {
                        // Notify user via WS when the worker finishes
                        this.wsServer.broadcast({
                            type: 'log',
                            timestamp: new Date().toISOString(),
                            payload: { level: 'info', source: 'Worker Engine', message: `🏗️ Background analysis complete. Result available.` }
                        });
                    },
                });

                this.wsServer.broadcast({
                    type: 'log',
                    timestamp: new Date().toISOString(),
                    payload: { level: 'info', source: 'Router', message: `🧠 [Router]: Complexity Score ${score}/100 → Delegated to Worker Engine (background task ${taskId.slice(0, 12)})` }
                });
            } else {
                let engineLabel: string;
                if (targetTier === 'live') {
                    const liveConf = getLiveEngineConfig();
                    const providerLabel = liveConf.provider ?? 'Cloud';
                    engineLabel = `Live Engine (${providerLabel}/${liveConf.model})`;
                } else {
                    engineLabel = 'Cloud Engine';
                }
                this.wsServer.broadcast({
                    type: 'log',
                    timestamp: new Date().toISOString(),
                    payload: { level: 'info', source: 'Router', message: `🧠 [Router]: Complexity Score ${score}/100 → Routing to ${engineLabel}` }
                });
            }
        }

        // Fallback targetTier to Live Engine just in case somehow it is undefined
        targetTier = targetTier || 'live';

        console.log(`  🧠 [${targetTier}] Processing request ${requestId.slice(0, 8)}... from ${clientId}`);

        // ─── Lane-based Queue: Route to session or main lane ───────
        // System-originated requests (watcher) go to main lane; user requests
        // use a per-client session lane for future multi-session parallelism.
        const lane = clientId === 'system'
            ? CommandLane.Main
            : `session:${clientId}`;
        await enqueueCommandInLane(lane, async () => {
                let result;
                const callbacks = {
                    onChunk: (delta: string) => {
                        this.wsServer.broadcast({
                            type: 'chat:stream:chunk',
                            timestamp: new Date().toISOString(),
                            payload: { requestId, delta },
                        });
                    },
                    onDone: (fullText: string) => {
                    },
                    onError: (error: Error) => {
                        console.error(`  ❌ [${targetTier}] Error:`, error.message);
                        this.wsServer.broadcast({
                            type: 'chat:error',
                            timestamp: new Date().toISOString(),
                            payload: { requestId, error: error.message },
                        });
                    },
                    onToolCall: (toolName: string, args: Record<string, unknown>) => {
                        console.log(`  🔧 [${targetTier}] Tool call: ${toolName}`);
                        this.wsServer.broadcast({
                            type: 'chat:tool:call',
                            timestamp: new Date().toISOString(),
                            payload: { requestId, toolName, args },
                        });
                    },
                    onToolResult: (toolName: string, success: boolean, toolResult: string) => {
                        console.log(`  ${success ? '✅' : '❌'} [${targetTier}] Tool result: ${toolName} — ${success ? 'success' : 'failed'}`);
                        this.wsServer.broadcast({
                            type: 'chat:tool:result',
                            timestamp: new Date().toISOString(),
                            payload: { requestId, toolName, success, result: toolResult },
                        });
                    },
                };

                const senderRole = resolveSenderRole(clientId);
                this.heartbeat?.setThinking(true);
                try {
                    if (targetTier === 'live') {
                        result = await askLive(content, callbacks, messages, senderRole);
                    } else {
                        result = await askTier2(content, callbacks, undefined, messages, senderRole);
                    }
                } finally {
                    this.heartbeat?.setThinking(false);
                }

                this.wsServer.broadcast({
                    type: 'chat:stream:done',
                    timestamp: new Date().toISOString(),
                    payload: {
                        requestId,
                        fullText: '',
                        tier: result.tier,
                        model: result.model,
                    },
                });

                console.log(`  ✅ [${result.tier}] Completed request ${requestId.slice(0, 8)}... via ${result.model}`);
        }, { warnAfterMs: 5_000 });
    }
}
