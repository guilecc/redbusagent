/**
 * @redbusagent/daemon — Heartbeat Service
 *
 * Emits periodic heartbeat messages to all connected TUI clients.
 * This is the daemon's "pulse of life" — the foundation for the
 * curiosity engine, monitoring, and self-maintenance loops.
 *
 * MemGPT Integration:
 * - Core Memory Compressor: When idle, uses Tier 1 (Ollama) to review
 *   and compress the Core Working Memory, distilling facts and dropping
 *   irrelevant chit-chat.
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
import { CoreMemory } from './core-memory.js';

export class HeartbeatService {
    private intervalHandle: ReturnType<typeof setInterval> | null = null;
    private readonly startedAt: number;
    private lastActivityAt: number;
    private engine: ProactiveEngine;
    private idleCycleCount = 0;

    /** Ring buffer of recent chat exchanges for the compressor */
    private static recentChatHistory: string[] = [];
    private static readonly MAX_HISTORY_ENTRIES = 20;

    // Run proactive pulse every 60 seconds of idle time
    static IDLE_THRESHOLD_MS = 60000;

    // Run compressor every N idle cycles (N * HEARTBEAT_INTERVAL_MS of idle time)
    static COMPRESSION_CYCLE_INTERVAL = 5;

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

    /**
     * Records a chat exchange in the ring buffer for the compressor.
     * Called by the ChatHandler after each completed request/response.
     */
    static recordChatExchange(userMessage: string, assistantResponse: string): void {
        const entry = `[User]: ${userMessage.slice(0, 300)}\n[Assistant]: ${assistantResponse.slice(0, 500)}`;
        this.recentChatHistory.push(entry);
        if (this.recentChatHistory.length > this.MAX_HISTORY_ENTRIES) {
            this.recentChatHistory.shift();
        }
    }

    /** Returns the recent chat history for the compressor */
    static getRecentHistory(): string {
        if (this.recentChatHistory.length === 0) return '(no recent conversations)';
        return this.recentChatHistory.join('\n---\n');
    }

    /** Start emitting heartbeats at the configured interval */
    start(): void {
        if (this.intervalHandle) return; // idempotent

        this.emit(); // Emit one immediately so TUI sees it right away

        this.intervalHandle = setInterval(() => {
            this.emit();
            this.checkAlerts();
            void this.pulseProactiveCognition();
            void this.pulseMemoryCompressor();
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

    /**
     * Core Memory Compressor (MemGPT Heartbeat Integration)
     *
     * When the system is idle, uses Tier 1 (Ollama) to review:
     * 1. The recent chat history
     * 2. The current core-memory.md
     *
     * Then generates a new, highly compressed version of the Core Memory
     * — distilling facts, dropping irrelevant chit-chat, updating active tasks.
     */
    private async pulseMemoryCompressor(): Promise<void> {
        const idleFor = Date.now() - this.lastActivityAt;
        if (idleFor < HeartbeatService.IDLE_THRESHOLD_MS) {
            this.idleCycleCount = 0;
            return;
        }

        this.idleCycleCount++;

        // Only run every N cycles to avoid constant compression
        if (this.idleCycleCount % HeartbeatService.COMPRESSION_CYCLE_INTERVAL !== 0) {
            return;
        }

        const stats = CoreMemory.getStats();

        // Only compress if memory is somewhat populated (>50% or has recent history)
        const recentHistory = HeartbeatService.getRecentHistory();
        if (!stats.exists || (stats.percentFull < 50 && recentHistory === '(no recent conversations)')) {
            return;
        }

        console.log(`  🧠 CoreMemory Compressor: Triggering compression cycle (${stats.percentFull}% full)...`);

        const currentMemory = CoreMemory.read();

        const compressionPrompt = `You are a memory compressor for an AI agent. Your job is to produce a HIGHLY COMPRESSED version of the Core Working Memory.

CURRENT CORE MEMORY:
---
${currentMemory}
---

RECENT CHAT HISTORY (newest last):
---
${recentHistory}
---

INSTRUCTIONS:
1. Review both the current Core Memory and recent chat history
2. Extract NEW facts, goals, tasks, and context from the chat history
3. Remove any obsolete, completed, or irrelevant information from the current memory
4. Produce a new, compressed version that fits under 3500 characters
5. Use markdown with these exact sections: ## Active Goals, ## User Context, ## Critical Facts, ## Active Tasks
6. Be brutally concise — facts only, no filler words
7. If nothing new to add and memory is clean, return "NO_CHANGE"

Output ONLY the new compressed memory text (or "NO_CHANGE"). No explanations.`;

        try {
            let compressedResult = '';
            await askTier1(compressionPrompt, {
                onChunk: (chunk) => { compressedResult += chunk; },
                onDone: () => { },
                onError: (err) => {
                    console.error('  ❌ CoreMemory Compressor Error:', err.message);
                },
            });

            const trimmed = compressedResult.trim();
            if (trimmed && trimmed !== 'NO_CHANGE' && trimmed.length > 50) {
                CoreMemory.replace(trimmed);
                console.log(`  🧠 CoreMemory Compressor: Memory compressed successfully (${trimmed.length} chars)`);
            } else {
                console.log('  🧠 CoreMemory Compressor: No changes needed.');
            }
        } catch (err) {
            console.error('  ❌ CoreMemory Compressor: Fatal error:', err);
        }
    }
}

