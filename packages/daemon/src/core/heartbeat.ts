/**
 * @redbusagent/daemon — Heartbeat Service
 *
 * Emits periodic heartbeat messages to all connected TUI clients.
 * This is the daemon's "pulse of life" — the foundation for the
 * curiosity engine, monitoring, and self-maintenance loops that
 * will extend this in the future.
 */

import type { DaemonWsServer } from '../infra/ws-server.js';
import type { HeartbeatMessage, ProactiveThoughtMessage } from '@redbusagent/shared';
import { HEARTBEAT_INTERVAL_MS } from '@redbusagent/shared';

import { askTier1, askTier2, type CognitiveRouterResult } from './cognitive-router.js';
import { MemoryManager } from './memory-manager.js';
import { ToolRegistry } from './tool-registry.js';
import { ProactiveEngine } from './proactive-engine.js';
import { AlertManager } from './alert-manager.js';
import { WhatsAppChannel } from '../channels/whatsapp.js';

export class HeartbeatService {
    private intervalHandle: ReturnType<typeof setInterval> | null = null;
    private readonly startedAt: number;
    private lastActivityAt: number;
    private engine: ProactiveEngine;

    // Run proactive pulse every 60 seconds of idle time
    static IDLE_THRESHOLD_MS = 60000;

    constructor(
        private readonly wsServer: DaemonWsServer,
        private readonly port: number,
    ) {
        this.startedAt = Date.now();
        this.lastActivityAt = Date.now();
        this.engine = new ProactiveEngine(wsServer);
    }

    /** Records that the user has interacted */
    public markActivity(): void {
        this.lastActivityAt = Date.now();
    }

    /** Start emitting heartbeats at the configured interval */
    start(): void {
        if (this.intervalHandle) return; // idempotent

        this.emit(); // Emit one immediately so TUI sees it right away

        this.intervalHandle = setInterval(() => {
            this.emit();
            this.checkAlerts();
            void this.pulseProactiveCognition();
        }, HEARTBEAT_INTERVAL_MS);
    }

    /** Stop the heartbeat loop */
    stop(): void {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
    }

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

    private emitThought(text: string, status: ProactiveThoughtMessage['payload']['status']): void {
        this.wsServer.broadcast({
            type: 'proactive:thought',
            timestamp: new Date().toISOString(),
            payload: { text, status }
        });
    }

    private checkAlerts(): void {
        const dueAlerts = AlertManager.popDueAlerts();
        for (const alert of dueAlerts) {
            console.log(`  ⏰ Heartbeat: Triggering scheduled alert: ${alert.message}`);
            this.wsServer.broadcast({
                type: 'system:alert',
                timestamp: new Date().toISOString(),
                payload: {
                    id: alert.id,
                    message: alert.message
                }
            });

            // 🛡️ OUTBOUND FIREWALL: Send directly to the owner via WhatsApp. No destination needed.
            WhatsAppChannel.getInstance().sendNotificationToOwner(`⏰ *Alerta Proativo:*\n${alert.message}`).catch((err) => {
                console.error('  ❌ Heartbeat: Erro ao enviar notificação WhatsApp:', err);
            });
        }
    }

    /**
     * Checks if the agent is idle. If so, triggers the Proactive Engine evaluation cycle.
     */
    private async pulseProactiveCognition(): Promise<void> {
        const idleFor = Date.now() - this.lastActivityAt;
        if (idleFor < HeartbeatService.IDLE_THRESHOLD_MS) {
            return;
        }

        await this.engine.tick();
    }
}
