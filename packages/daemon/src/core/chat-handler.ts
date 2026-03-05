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

import { CoreMemory } from './core-memory.js';
import { approvalGate, type ApprovalRequest } from './approval-gate.js';
import { enqueueCommandInLane, CommandLane } from './task-queue.js';
import { processMonitorEmitter } from './tools/process-manager.js';
import { HeavyTaskQueue } from './heavy-task-queue.js';
import type { HeartbeatManager } from './gateway/heartbeat.js';
import { createThinkingFilter } from './thinking-filter.js';
import { userInputManager } from './tools/ask-user.js';
import { engineBus } from './engine-message-bus.js';

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

        // ─── User Input Gate (ask_user_for_input yield/resume) ─────────
        userInputManager.on('question_asked', ({ id, question }) => {
            console.log(`  ❓ [ChatHandler] Relaying question to TUI: "${question.slice(0, 60)}..."`);
            this.wsServer.broadcast({
                type: 'chat:stream:chunk',
                timestamp: new Date().toISOString(),
                payload: { requestId: id, delta: `❓ **Agent needs your input:**\n${question}` }
            });
            this.wsServer.broadcast({
                type: 'chat:stream:done',
                timestamp: new Date().toISOString(),
                payload: { requestId: id, fullText: '', tier: 'worker', model: 'system' }
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
        let forcedExecutionMode: 'local-only' | undefined;

        const vaultConfig = Vault.read();
        let targetTier = this.forceLive ? 'live' : tier;

        // ─── User Input Gate Interception (ask_user_for_input) ──────
        if (userInputManager.hasPendingQuestions()) {
            const pendingId = userInputManager.getFirstPendingId()!;
            userInputManager.resolveInput(pendingId, content);

            this.wsServer.broadcast({
                type: 'log',
                timestamp: new Date().toISOString(),
                payload: { level: 'info', source: 'System', message: `✅ Response received. Agent resuming...` }
            });

            this.wsServer.broadcast({
                type: 'chat:stream:done',
                timestamp: new Date().toISOString(),
                payload: { requestId, fullText: '', tier: 'worker', model: 'system' }
            });
            return;
        }

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
            const askFnOnboarding = targetTier === 'cloud' ? askTier2 : askLive;
            const onboardingPrompt = `The user is describing their desired agent persona. 
User response: "${content}"

Extract the following information into a JSON object:
{
  "agent_name": "...",
  "user_context": "...",
  "behavioral_guidelines": "..."
}
Return ONLY the JSON object. Do not explain.`;

            const callbacks = {
                onChunk: (delta: string) => {
                    // We don't stream the raw JSON parsing to the user
                },
                onDone: (fullText: string) => {
                    try {
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
                onError: (error: Error) => {
                    this.wsServer.broadcast({
                        type: 'chat:error',
                        timestamp: new Date().toISOString(),
                        payload: { requestId, error: `Falha no onboarding: ${error.message}` },
                    });
                }
            };

            const disableOpts = { disableTools: true };
            let result;
            if (targetTier === 'cloud') {
                result = await askTier2(onboardingPrompt, callbacks, undefined, undefined, 'owner', disableOpts);
            } else {
                result = await askLive(onboardingPrompt, callbacks, undefined, 'owner', disableOpts);
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
            return;
        }

        // Trivial escape hatch force-routing to Live Engine (Slash Command menu equivalent)
        if (content.trim().toLowerCase().startsWith('/local')) {
            targetTier = 'live';
            forcedExecutionMode = 'local-only';
            content = content.replace(/^\/local\s*/i, '');
        }

        // ─── Direct Routing ──────────────────────────────────────────────────
        if (!isOnboarding && content.trim() !== '' && !this.forceLive && !tier) {
            targetTier = 'live';
            const liveConf = getLiveEngineConfig();
            const providerLabel = liveConf.provider ?? 'Cloud';
            const engineLabel = `Live Engine (${providerLabel}/${liveConf.model})`;
            this.wsServer.broadcast({
                type: 'log',
                timestamp: new Date().toISOString(),
                payload: { level: 'info', source: 'Router', message: `🧠 [Router]: Routing to ${engineLabel}` }
            });
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
            // Thinking tag filter: strips <thinking>...</thinking> from stream,
            // emits a 💭 indicator instead of raw XML
            const thinkingFilter = createThinkingFilter((cleanDelta: string) => {
                if (!cleanDelta) return;
                this.wsServer.broadcast({
                    type: 'chat:stream:chunk',
                    timestamp: new Date().toISOString(),
                    payload: { requestId, delta: cleanDelta },
                });
            });

            const callbacks = {
                onChunk: (delta: string) => {
                    thinkingFilter.push(delta);
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

            // ─── Zero Abandonment Guard ───────────────────────────────
            // If no activity (chunks, tool calls) for 30s, send a status ping.
            // Ensures the user NEVER waits in silence.
            const SILENCE_THRESHOLD_MS = 30_000;
            let lastActivityTime = Date.now();
            let silenceCheckCount = 0;

            const markActivity = () => { lastActivityTime = Date.now(); };

            // Patch callbacks to track activity
            const originalOnChunk = callbacks.onChunk;
            callbacks.onChunk = (delta: string) => { markActivity(); originalOnChunk(delta); };
            const originalOnToolCall = callbacks.onToolCall;
            callbacks.onToolCall = (toolName: string, args: Record<string, unknown>) => { markActivity(); originalOnToolCall(toolName, args); };

            const silenceGuard = setInterval(() => {
                const silentMs = Date.now() - lastActivityTime;
                if (silentMs >= SILENCE_THRESHOLD_MS) {
                    silenceCheckCount++;
                    const elapsed = Math.round((Date.now() - lastActivityTime) / 1000);
                    const isWorkerActive = engineBus.isWorkerActive();
                    const statusMsg = isWorkerActive
                        ? `⏳ Still working... Worker Engine is processing (${elapsed}s since last update)`
                        : `⏳ Still working... processing your request (${elapsed}s since last update)`;

                    console.log(`  ⏳ [ZeroAbandon] Silence detected (${elapsed}s). Sending status ping #${silenceCheckCount}.`);
                    this.wsServer.broadcast({
                        type: 'chat:stream:chunk',
                        timestamp: new Date().toISOString(),
                        payload: { requestId, delta: `\n${statusMsg}\n` },
                    });
                    markActivity(); // Reset so we don't spam
                }
            }, SILENCE_THRESHOLD_MS);

            try {
                if (targetTier === 'live') {
                    result = await askLive(
                        content,
                        callbacks,
                        messages,
                        senderRole,
                        forcedExecutionMode ? { forceExecutionMode: forcedExecutionMode } : undefined,
                    );
                } else {
                    result = await askTier2(content, callbacks, undefined, messages, senderRole);
                }
            } catch (err) {
                // ─── Zero Abandonment: Error path MUST respond ────────
                const error = err instanceof Error ? err : new Error(String(err));
                console.error(`  ❌ [${targetTier}] Unhandled error:`, error.message);
                this.wsServer.broadcast({
                    type: 'chat:error',
                    timestamp: new Date().toISOString(),
                    payload: { requestId, error: `Something went wrong: ${error.message}. Please try again or rephrase your request.` },
                });
                // Ensure we still signal completion so the TUI resets
                result = { tier: targetTier as 'live' | 'cloud', model: 'error' };
            } finally {
                clearInterval(silenceGuard);
                // Flush any buffered thinking content before signalling done
                thinkingFilter.flush();
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
