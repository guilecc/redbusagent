/**
 * @redbusagent/daemon — Entry Point
 *
 * Bootstraps the daemon process:
 *  1. Starts the WebSocket server
 *  2. Launches the Heartbeat service
 *  3. Initializes the Chat Handler (Cognitive Router bridge)
 *  4. Handles graceful shutdown on SIGINT/SIGTERM
 */

import {
    DEFAULT_PORT,
    DEFAULT_HOST,
    APP_NAME,
    APP_VERSION,
    Vault,
} from '@redbusagent/shared';
import type { ClientMessage } from '@redbusagent/shared';
import { DaemonWsServer } from './infra/ws-server.js';
import { HeartbeatService } from './core/heartbeat.js';
import { ChatHandler } from './core/chat-handler.js';
import { getRouterStatus } from './core/cognitive-router.js';
import { Forge } from './core/forge.js';
import { ToolRegistry } from './core/tool-registry.js';
import { OllamaManager } from './core/ollama-manager.js';
import { WhatsAppChannel } from './channels/whatsapp.js';

// ── Configuration ─────────────────────────────────────────────────

const PORT = Number(process.env['REDBUS_PORT']) || DEFAULT_PORT;
const HOST = process.env['REDBUS_HOST'] || DEFAULT_HOST;

// ── Bootstrap ─────────────────────────────────────────────────────

console.log(`\n🔴 ${APP_NAME} daemon v${APP_VERSION}`);
console.log(`   PID: ${process.pid}`);
console.log(`   Listening on ws://${HOST}:${PORT}\n`);

// Initialize Forge & Registry
Forge.ensureWorkspace();
ToolRegistry.ensureFile();

// Display vault status
if (Vault.isConfigured()) {
    console.log(`  🔐 Vault: ${Vault.configPath}`);
} else {
    console.log('  🔐 Vault: ⚠️  não configurado — rode: redbus config');
}

// Display router status
const routerStatus = getRouterStatus();
console.log('  🧠 Cognitive Router:');
console.log(`     Tier 1 (Local):  ${routerStatus.tier1.model} @ ${routerStatus.tier1.url} [${routerStatus.tier1.enabled ? '✅' : '⏸️  desativado'}]`);
if (routerStatus.tier2) {
    if (routerStatus.tier2.configured) {
        console.log(`     Tier 2 (Cloud):  ${routerStatus.tier2.provider}/${routerStatus.tier2.model} [✅ ${routerStatus.tier2.authMethod}]`);
    } else {
        console.log(`     Tier 2 (Cloud):  ${routerStatus.tier2.provider}/${routerStatus.tier2.model} [⚠️  credenciais ausentes]`);
    }
} else {
    console.log('     Tier 2 (Cloud):  ⚠️  não configurado');
}
console.log(`  🔨 Forge: ${Forge.dir} (${routerStatus.forgedTools} ferramentas registradas)`);
console.log('');

const wsServer = new DaemonWsServer({
    port: PORT,
    host: HOST,
    onConnection: (clientId) => {
        console.log(`  ⚡ Client connected: ${clientId} (total: ${wsServer.connectionCount})`);
    },
    onDisconnection: (clientId) => {
        console.log(`  ⛓️‍💥 Client disconnected: ${clientId} (total: ${wsServer.connectionCount})`);
    },
    onClientMessage: (clientId: string, message: ClientMessage) => {
        switch (message.type) {
            case 'chat:request':
                void chatHandler.handleChatRequest(clientId, message);
                break;
            case 'ping':
                console.log(`  📡 Ping from ${clientId}`);
                break;
            default:
                console.log(`  ❓ Unknown message type from ${clientId}:`, (message as { type: string }).type);
        }
    },
});

const heartbeat = new HeartbeatService(wsServer, PORT);
heartbeat.start();

const chatHandler = new ChatHandler(wsServer);

console.log('  💓 Heartbeat service started');
console.log('  💬 Chat handler initialized');
console.log('  ✅ Daemon is ready. Waiting for TUI connections...\n');

// ── Background Engine Download & Start ────────────────────────────

// The engine is mandatory for local workflows. Run it always.
const shouldRunLocalEngine = true;
if (shouldRunLocalEngine) {
    // Send progress to TUI connected clients
    OllamaManager.setCallbacks((status) => {
        wsServer.broadcast({
            type: 'system:status',
            timestamp: new Date().toISOString(),
            payload: { status: status as any } // Overload system:status display in TUI
        });
    });

    OllamaManager.startup().catch((err) => {
        console.error('  ❌ Failed to start managed Ollama:', err);
    });
}

// ── Extensions (Channels) ─────────────────────────────────────────

const whatsapp = new WhatsAppChannel();
whatsapp.startSilent().catch(err => {
    console.error('  ❌ Failed to start WhatsApp Bridge:', err);
});

// ── Graceful Shutdown ─────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
    console.log(`\n  🛑 Received ${signal}. Shutting down gracefully...`);
    OllamaManager.shutdown();
    await whatsapp.stop();
    heartbeat.stop();
    await wsServer.shutdown();
    console.log('  👋 Daemon stopped.\n');
    process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
