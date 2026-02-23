/**
 * @redbusagent/daemon — Chat Handler
 *
 * Bridges WebSocket incoming chat:request messages to the Cognitive Router,
 * streaming LLM responses and tool events back to the TUI in real-time.
 */

import type { DaemonWsServer } from '../infra/ws-server.js';
import type { ChatRequestMessage } from '@redbusagent/shared';
import { PersonaManager, Vault } from '@redbusagent/shared';
import { askTier1, askTier2 } from './cognitive-router.js';
import { HeartbeatService } from './heartbeat.js';
import { CoreMemory } from './core-memory.js';

export class ChatHandler {
    private forceTier1 = false;
    private pendingCodingEscalation = new Map<string, { active: boolean, originalPrompt: string | null }>();

    constructor(private readonly wsServer: DaemonWsServer) { }

    setForceTier1(enabled: boolean): void {
        this.forceTier1 = enabled;
    }

    async handleChatRequest(
        clientId: string,
        message: ChatRequestMessage,
    ): Promise<void> {
        const { requestId } = message.payload;
        let { content, tier, isOnboarding } = message.payload;

        // Priority: 1. Manual flag from Slash Command, 2. Explicit tier in payload, 3. Vault default
        const vaultConfig = Vault.read();
        const defaultTier = vaultConfig?.default_chat_tier === 1 ? 'tier1' : 'tier2';
        let targetTier = this.forceTier1 ? 'tier1' : (tier ?? defaultTier);

        // Smart Escalation Interception
        const escalationState = this.pendingCodingEscalation.get(clientId);
        if (escalationState?.active && escalationState.originalPrompt) {
            const isAffirmative = /^(yes|y|sure|manda bala|pode|sim|claro|please|yeah|yep)\b/i.test(content.trim());

            this.pendingCodingEscalation.set(clientId, { active: false, originalPrompt: null });

            if (isAffirmative) {
                targetTier = 'tier2';
                content = escalationState.originalPrompt;

                this.wsServer.sendTo(clientId, {
                    type: 'log',
                    timestamp: new Date().toISOString(),
                    payload: { level: 'info', source: 'System', message: '🚀 Escalating task to Tier 2 Cloud...' }
                });
            } else {
                targetTier = 'tier1';
            }
        }

        // Reset flag after use
        this.forceTier1 = false;

        // Special handling for onboarding
        if (isOnboarding) {
            console.log(`  👤 [onboarding] Parsing persona from user input...`);
            const onboardingPrompt = `The user is describing their desired agent persona. 
User response: "${content}"

Extract the following information into a JSON object:
{
  "agent_name": "...",
  "user_context": "...",
  "behavioral_guidelines": "..."
}
Return ONLY the JSON object. Do not explain.`;

            const result = await askTier2(onboardingPrompt, {
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

        // Trivial escape hatch force-routing to local engine (Slash Command menu equivalent)
        if (content.trim().toLowerCase().startsWith('/local')) {
            targetTier = 'tier1';
            content = content.replace(/^\/local\s*/i, '');
        }

        console.log(`  🧠 [${targetTier}] Processing request ${requestId.slice(0, 8)}... from ${clientId}`);

        const askFn = targetTier === 'tier1' ? askTier1 : askTier2;

        const result = await askFn(content, {
            onChunk: (delta) => {
                this.wsServer.broadcast({
                    type: 'chat:stream:chunk',
                    timestamp: new Date().toISOString(),
                    payload: { requestId, delta },
                });
            },
            onDone: (fullText) => {
                if (targetTier === 'tier1' &&
                    fullText.includes('Do you want me to escalate this coding task to Tier 2?')) {
                    this.pendingCodingEscalation.set(clientId, { active: true, originalPrompt: message.payload.content });
                }

                // MemGPT: Record exchange for the Core Memory Compressor
                if (fullText) {
                    HeartbeatService.recordChatExchange(content, fullText);
                }
            },
            onError: (error) => {
                console.error(`  ❌ [${targetTier}] Error:`, error.message);
                this.wsServer.broadcast({
                    type: 'chat:error',
                    timestamp: new Date().toISOString(),
                    payload: { requestId, error: error.message },
                });
            },
            onToolCall: (toolName, args) => {
                console.log(`  🔧 [${targetTier}] Tool call: ${toolName}`);
                this.wsServer.broadcast({
                    type: 'chat:tool:call',
                    timestamp: new Date().toISOString(),
                    payload: { requestId, toolName, args },
                });
            },
            onToolResult: (toolName, success, toolResult) => {
                console.log(`  ${success ? '✅' : '❌'} [${targetTier}] Tool result: ${toolName} — ${success ? 'success' : 'failed'}`);
                this.wsServer.broadcast({
                    type: 'chat:tool:result',
                    timestamp: new Date().toISOString(),
                    payload: { requestId, toolName, success, result: toolResult },
                });
            },
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

        console.log(`  ✅ [${result.tier}] Completed request ${requestId.slice(0, 8)}... via ${result.model}`);
    }
}
