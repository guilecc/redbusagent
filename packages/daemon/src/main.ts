/**
 * @redbusagent/daemon — Entry Point
 *
 * Bootstraps the daemon process:
 *  1. Starts the WebSocket server
 *  2. Launches the Heartbeat service
 *  3. Handles graceful shutdown on SIGINT/SIGTERM
 */

import {
    DEFAULT_PORT,
    DEFAULT_HOST,
    APP_NAME,
    APP_VERSION,
} from '@redbusagent/shared';
import { DaemonWsServer } from './infra/ws-server.js';
import { HeartbeatService } from './core/heartbeat.js';

// ── Configuration ─────────────────────────────────────────────────

const PORT = Number(process.env['REDBUS_PORT']) || DEFAULT_PORT;
const HOST = process.env['REDBUS_HOST'] || DEFAULT_HOST;

// ── Bootstrap ─────────────────────────────────────────────────────

console.log(`\n🔴 ${APP_NAME} daemon v${APP_VERSION}`);
console.log(`   PID: ${process.pid}`);
console.log(`   Listening on ws://${HOST}:${PORT}\n`);

const wsServer = new DaemonWsServer({
    port: PORT,
    host: HOST,
    onConnection: (clientId) => {
        console.log(`  ⚡ Client connected: ${clientId} (total: ${wsServer.connectionCount})`);
    },
    onDisconnection: (clientId) => {
        console.log(`  ⛓️‍💥 Client disconnected: ${clientId} (total: ${wsServer.connectionCount})`);
    },
});

const heartbeat = new HeartbeatService(wsServer, PORT);
heartbeat.start();

console.log('  💓 Heartbeat service started');
console.log('  ✅ Daemon is ready. Waiting for TUI connections...\n');

// ── Graceful Shutdown ─────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
    console.log(`\n  🛑 Received ${signal}. Shutting down gracefully...`);
    heartbeat.stop();
    await wsServer.shutdown();
    console.log('  👋 Daemon stopped.\n');
    process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
