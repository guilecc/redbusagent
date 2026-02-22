/**
 * @redbusagent/daemon — Chat Handler
 *
 * Bridges WebSocket incoming chat:request messages to the Cognitive Router,
 * streaming LLM responses and tool events back to the TUI in real-time.
 */

import type { DaemonWsServer } from '../infra/ws-server.js';
import type { ChatRequestMessage } from '@redbusagent/shared';
import { askTier1, askTier2 } from './cognitive-router.js';

export class ChatHandler {
    constructor(private readonly wsServer: DaemonWsServer) { }

    async handleChatRequest(
        clientId: string,
        message: ChatRequestMessage,
    ): Promise<void> {
        const { requestId } = message.payload;
        let { content, tier } = message.payload;
        let targetTier = tier ?? 'tier2';

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
                void fullText;
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
