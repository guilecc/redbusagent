/**
 * @redbusagent/daemon — Heartbeat Service
 *
 * Emits periodic heartbeat messages to all connected TUI clients.
 * This is the daemon's "pulse of life" — the foundation for the
 * curiosity engine, monitoring, and self-maintenance loops that
 * will extend this in the future.
 */

import type { DaemonWsServer } from '../infra/ws-server.js';
import type { HeartbeatMessage } from '@redbusagent/shared';
import { HEARTBEAT_INTERVAL_MS } from '@redbusagent/shared';

export class HeartbeatService {
    private intervalHandle: ReturnType<typeof setInterval> | null = null;
    private readonly startedAt: number;

    constructor(
        private readonly wsServer: DaemonWsServer,
        private readonly port: number,
    ) {
        this.startedAt = Date.now();
    }

    /** Start emitting heartbeats at the configured interval */
    start(): void {
        if (this.intervalHandle) return; // idempotent

        // Emit one immediately so TUI sees it right away
        this.emit();

        this.intervalHandle = setInterval(() => {
            this.emit();
        }, HEARTBEAT_INTERVAL_MS);
    }

    /** Stop the heartbeat loop */
    stop(): void {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
    }

    // ── Private ──────────────────────────────────────────────────────

    private emit(): void {
        const message: HeartbeatMessage = {
            type: 'heartbeat',
            timestamp: new Date().toISOString(),
            payload: {
                uptimeMs: Date.now() - this.startedAt,
                pid: process.pid,
                port: this.port,
            },
        };

        this.wsServer.broadcast(message);
    }
}
