/**
 * @redbusagent/daemon — Entry Point
 *
 * Bootstraps the daemon process:
 *  1. Starts the WebSocket server
 *  2. Launches the Heartbeat service
 *  3. Initializes the Chat Handler (Cognitive Router bridge)
 *  4. Handles graceful shutdown on SIGINT/SIGTERM
 */

import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
    DEFAULT_PORT,
    DEFAULT_HOST,
    APP_NAME,
    APP_VERSION,
    Vault,
} from '@redbusagent/shared';
import type { ClientMessage } from '@redbusagent/shared';
import { DaemonWsServer } from './infra/ws-server.js';
import { TaskScheduler } from './core/scheduler.js';
import { ChatHandler } from './core/chat-handler.js';
import { HeartbeatManager } from './core/gateway/heartbeat.js';
import { getRouterStatus } from './core/cognitive-router.js';
import { getLiveEngineConfig } from './infra/llm-config.js';
import { Forge } from './core/forge.js';
import { ToolRegistry } from './core/tool-registry.js';
// OllamaManager removed — Cloud-First architecture (no local engine management)
import { WhatsAppChannel } from './channels/whatsapp.js';
import { CoreMemory } from './core/core-memory.js';
import { MCPEngine } from './core/mcp-engine.js';

// ── Configuration ─────────────────────────────────────────────────

const PORT = Number(process.env['REDBUS_PORT']) || DEFAULT_PORT;
const HOST = process.env['REDBUS_HOST'] || DEFAULT_HOST;

// ── Bootstrap ─────────────────────────────────────────────────────

console.log(`\n🔴 ${APP_NAME} daemon v${APP_VERSION}`);
console.log(`   PID: ${process.pid}`);
console.log(`   Listening on ws://${HOST}:${PORT}\n`);

// ── Write PID file for `redbus stop` ────────────────────────────
const PID_FILE = join(Vault.dir, 'daemon.pid');
writeFileSync(PID_FILE, String(process.pid), { encoding: 'utf-8', mode: 0o600 });

// Initialize Forge & Registry & Core Memory & MCP
Forge.ensureWorkspace();
ToolRegistry.ensureFile();
CoreMemory.ensureFile();
await MCPEngine.getInstance().initialize();

// Display vault status
if (Vault.isConfigured()) {
    console.log(`  🔐 Vault: ${Vault.configPath}`);
} else {
    console.log('  🔐 Vault: ⚠️  not configured — run: redbus config');
}

// Display router status
const routerStatus = getRouterStatus();
console.log('  🧠 Cognitive Router:');
const liveProviderLabel = routerStatus.liveEngine.provider ?? 'Cloud';
console.log(`     Live Engine (${liveProviderLabel}):  ${routerStatus.liveEngine.model} [${routerStatus.liveEngine.enabled ? '✅' : '⏸️  disabled'}]`);
if (routerStatus.tier2) {
    if (routerStatus.tier2.configured) {
        console.log(`     Worker Engine (${routerStatus.tier2.provider}):  ${routerStatus.tier2.model} [✅ ${routerStatus.tier2.authMethod}]`);
    } else {
        console.log(`     Worker Engine (${routerStatus.tier2.provider}):  ${routerStatus.tier2.model} [⚠️  credentials missing]`);
    }
} else {
    console.log('     Worker Engine:  ⚠️  not configured');
}
console.log(`  🔨 Forge: ${Forge.dir} (${routerStatus.forgedTools} registered tools)`);
const coreMemStats = CoreMemory.getStats();
console.log(`  🧠 Core Memory: ${coreMemStats.exists ? `${coreMemStats.charCount} chars (${coreMemStats.percentFull}% full)` : 'initialized'}`);

const connectedMCPs = MCPEngine.getInstance().getConnectedMCPs();
const mcpConfig = Vault.read()?.mcps || {};
const totalConfiguredMCPs = Object.keys(mcpConfig).length;

if (totalConfiguredMCPs > 0) {
    const successRatio = `${connectedMCPs.length}/${totalConfiguredMCPs}`;
    const allGood = connectedMCPs.length === totalConfiguredMCPs;
    const mcpList = connectedMCPs.length > 0 ? `(${connectedMCPs.join(', ')})` : '';
    const totalToolsFromMcp = MCPEngine.getInstance().getTools().length;

    console.log(`  🔌 MCP Engine: ${successRatio} active extensions ${mcpList} [${allGood ? '✅' : '⚠️ '}]`);
    if (connectedMCPs.length > 0) {
        console.log(`     -> Providing ${totalToolsFromMcp} dynamic tools`);
    }
} else {
    console.log(`  🔌 MCP Engine: no extensions connected`);
}

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
            case 'system:command': {
                const { command, args } = message.payload;
                console.log(`  🔌 Command from ${clientId}: ${command}`);

                if (command === 'force-local') {
                    chatHandler.setForceLive(true);
                    wsServer.sendTo(clientId, {
                        type: 'log',
                        timestamp: new Date().toISOString(),
                        payload: { level: 'info', source: 'System', message: 'Next message forced to Live Engine' }
                    });
                } else if (command === 'auto-route') {
                    chatHandler.setForceLive(false);
                    wsServer.sendTo(clientId, {
                        type: 'log',
                        timestamp: new Date().toISOString(),
                        payload: { level: 'info', source: 'System', message: 'Automatic routing restored' }
                    });
                } else if (command === 'status') {
                    const status = getRouterStatus();
                    const mem = process.memoryUsage();
                    const ramUsage = `${(mem.rss / 1024 / 1024).toFixed(1)} MB`;

                    wsServer.sendTo(clientId, {
                        type: 'log',
                        timestamp: new Date().toISOString(),
                        payload: {
                            level: 'info',
                            source: 'Status',
                            message: `Models: Live:${status.liveEngine.model}, Worker:${status.tier2?.provider}/${status.tier2?.model} | RAM: ${ramUsage} | Scheduler: OK`
                        }
                    });
                } else if (command === 'switch-cloud') {
                    const provider = args?.['provider'] as any;
                    const model = args?.['model'] as string;
                    if (provider) {
                        const config = Vault.read();
                        if (config) {
                            const newModel = model || (provider === 'anthropic' ? 'claude-3-5-sonnet-20240620' :
                                provider === 'google' ? 'gemini-1.5-pro' : 'gpt-4o');

                            Vault.write({
                                ...config,
                                tier2: { ...config.tier2, provider, model: newModel }
                            });
                            wsServer.sendTo(clientId, {
                                type: 'log',
                                timestamp: new Date().toISOString(),
                                payload: { level: 'info', source: 'System', message: `Provider changed to ${provider} (${newModel})` }
                            });
                        }
                    }
                } else if (command === 'set-default-tier') {
                    const value = args?.['value'] as number;
                    if (value === 1 || value === 2) {
                        const config = Vault.read();
                        if (config) {
                            if (value === 2 && config.tier2_enabled === false) {
                                wsServer.sendTo(clientId, {
                                    type: 'chat:error',
                                    timestamp: new Date().toISOString(),
                                    payload: { requestId: 'sys', error: 'Worker Engine is disabled. Run redbus config to configure an API key, or continue using the Live Engine.' }
                                });
                                return;
                            }
                            Vault.write({ ...config, default_chat_tier: value });
                            wsServer.sendTo(clientId, {
                                type: 'log',
                                timestamp: new Date().toISOString(),
                                payload: { level: 'info', source: 'System', message: `Default tier changed to Tier ${value}` }
                            });
                        }
                    }
                }
                break;
            }
            case 'ping':
                console.log(`  📡 Ping from ${clientId}`);
                break;
            default:
                console.log(`  ❓ Unknown message type from ${clientId}:`, (message as { type: string }).type);
        }
    },
});

const chatHandler = new ChatHandler(wsServer);

// ── Gateway Heartbeat (State Machine Tick Loop) ──────────────
const heartbeat = new HeartbeatManager(wsServer, { port: PORT });
chatHandler.setHeartbeat(heartbeat);
heartbeat.start();

TaskScheduler.init(wsServer, chatHandler);

console.log('  💓 Heartbeat manager started (1s tick loop)');
console.log('  ⏱️  Task Scheduler started (deterministic cron engine)');
console.log('  💬 Chat handler initialized');
console.log('  ✅ Daemon is ready. Waiting for TUI connections...\n');

// ── Cloud-First: No local engine management needed ───────────────
// All engines are cloud APIs (Anthropic, Google, OpenAI) or local Ollama.
// No local Ollama auto-start or model pulling.

// ── Extensions (Channels) ─────────────────────────────────────────

const whatsapp = WhatsAppChannel.getInstance();
whatsapp.setWsServer(wsServer); // Omnichannel: mirror WhatsApp activity to TUI
whatsapp.startSilent().catch(err => {
    console.error('  ❌ Failed to start WhatsApp Bridge:', err);
});

// ── Graceful Shutdown ─────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
    console.log(`\n  🛑 Received ${signal}. Shutting down gracefully...`);
    heartbeat.stop();
    // Cloud-First: no local engine to shut down
    await MCPEngine.getInstance().stop();
    await whatsapp.stop();
    TaskScheduler.stopAll();
    await wsServer.shutdown();

    // Clean up PID file
    try { unlinkSync(PID_FILE); } catch { /* ignore if already removed */ }

    console.log('  👋 Daemon stopped.\n');
    process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
