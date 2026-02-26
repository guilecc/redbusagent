/**
 * @redbusagent/daemon — Persistent Cron Scheduler
 *
 * Deterministic, croner-based scheduler inspired by openclaw/src/cron.
 * Key design:
 *  • Uses `croner` for robust cron expression parsing + next-run computation
 *  • Persists jobs to ~/.redbusagent/cron_jobs.json (atomic write via tmp+rename)
 *  • Triggers inject synthetic user prompts into the TaskQueue "cron" lane
 *    instead of calling the LLM directly — prevents interrupting active streams
 *  • Supports human-friendly aliases and enabled/disabled state
 */

import { Cron } from 'croner';
import { v4 as uuidv4 } from 'uuid';
import { Vault } from '@redbusagent/shared';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { enqueueCommandInLane, CommandLane } from './task-queue.js';
import type { ChatHandler } from './chat-handler.js';
import type { DaemonWsServer } from '../infra/ws-server.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface CronJobRecord {
    id: string;
    alias: string;
    cronExpr: string;
    prompt: string;
    enabled: boolean;
    createdAt: string;
    lastRunAt: string | null;
}

interface CronJobsFile {
    version: number;
    jobs: CronJobRecord[];
}

// ─── Constants ──────────────────────────────────────────────────────

const STORAGE_FILENAME = 'cron_jobs.json';

// ─── TaskScheduler ──────────────────────────────────────────────────

export class TaskScheduler {
    private static wsServer: DaemonWsServer;
    private static chatHandler: ChatHandler;
    /** In-memory map: jobId → live Cron instance + metadata */
    private static timers = new Map<string, { cron: Cron; record: CronJobRecord }>();

    private static get storagePath(): string {
        return join(Vault.dir, STORAGE_FILENAME);
    }

    // ─── Bootstrap ──────────────────────────────────────────────────

    static init(wsServer: DaemonWsServer, chatHandler: ChatHandler): void {
        this.wsServer = wsServer;
        this.chatHandler = chatHandler;
        this.loadFromDisk();
    }

    // ─── Persistence (atomic write) ─────────────────────────────────

    private static loadFromDisk(): void {
        if (!existsSync(this.storagePath)) return;
        try {
            const raw = readFileSync(this.storagePath, 'utf-8');
            const file = JSON.parse(raw) as CronJobsFile;
            for (const rec of file.jobs) {
                if (!rec.enabled) continue;
                console.log(`  ⏱️ [Cron] Restoring job "${rec.alias}" (${rec.id})`);
                this.startTimer(rec);
            }
        } catch (err: any) {
            console.error('  ❌ [Cron] Failed to load jobs from disk:', err.message);
        }
    }

    private static saveToDisk(): void {
        try {
            const file: CronJobsFile = {
                version: 1,
                jobs: Array.from(this.timers.values()).map(t => t.record),
            };
            const tmp = this.storagePath + '.tmp';
            writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
            renameSync(tmp, this.storagePath);
        } catch (err: any) {
            console.error('  ❌ [Cron] Failed to save jobs to disk:', err.message);
        }
    }

    // ─── Timer Management ───────────────────────────────────────────

    /**
     * Start a live croner timer for a job record.
     * When the cron fires, it injects a synthetic prompt into the TaskQueue
     * "cron" lane — never calls the LLM directly.
     */
    private static startTimer(record: CronJobRecord): void {
        const job = new Cron(record.cronExpr, {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            catch: (err) => {
                console.error(`  ❌ [Cron] Error in job "${record.alias}":`, err);
            },
        }, () => {
            // ── Deterministic injection: push into TaskQueue cron lane ──
            this.injectCronTask(record);
        });

        this.timers.set(record.id, { cron: job, record });
    }

    /**
     * Inject a cron-triggered task as a synthetic user message into the
     * TaskQueue's "cron" lane. The HeartbeatManager picks this up only
     * when the daemon is IDLE — no LLM interruption.
     */
    private static injectCronTask(record: CronJobRecord): void {
        const now = new Date().toISOString();
        record.lastRunAt = now;
        this.saveToDisk();

        console.log(`  ⏱️ [Cron] Triggered: "${record.alias}" → injecting into TaskQueue`);

        this.wsServer?.broadcast({
            type: 'log',
            timestamp: now,
            payload: {
                level: 'info',
                source: 'Cron',
                message: `Triggered: "${record.alias}" — ${record.prompt.substring(0, 60)}…`,
            },
        });

        // Enqueue in the "cron" lane — serialized but independent of user "main" lane
        enqueueCommandInLane(CommandLane.Cron, async () => {
            try {
                await this.chatHandler.handleChatRequest('cron', {
                    type: 'chat:request',
                    timestamp: now,
                    payload: {
                        requestId: `cron-${record.id}-${Date.now()}`,
                        content: `[SCHEDULED TASK: ${record.alias}] ${record.prompt}`,
                        tier: 'tier2',
                        isOnboarding: false,
                    },
                });
            } catch (err) {
                console.error(`  ❌ [Cron] Failed to execute "${record.alias}":`, err);
            }
        });
    }

    // ─── Public API ─────────────────────────────────────────────────

    /**
     * Schedule a new recurring job. Returns the job ID.
     * @throws if cronExpr is invalid
     */
    static scheduleTask(cronExpr: string, prompt: string, alias?: string, existingId?: string): string {
        // Validate with croner (throws on invalid expression)
        try {
            const test = new Cron(cronExpr);
            test.stop();
        } catch {
            throw new Error(`Invalid cron expression: ${cronExpr}`);
        }

        const id = existingId || uuidv4();
        const record: CronJobRecord = {
            id,
            alias: alias || prompt.substring(0, 40).replace(/\s+/g, '-').toLowerCase(),
            cronExpr,
            prompt,
            enabled: true,
            createdAt: new Date().toISOString(),
            lastRunAt: null,
        };

        this.startTimer(record);
        this.saveToDisk();

        return id;
    }

    /** List all registered jobs (including disabled ones). */
    static listScheduledTasks(): CronJobRecord[] {
        return Array.from(this.timers.values()).map(t => ({
            ...t.record,
            nextRun: t.cron.nextRun()?.toISOString() ?? null,
        })) as any;
    }

    /** Remove a job by ID or alias. Returns true if found. */
    static deleteTask(idOrAlias: string): boolean {
        // Try by ID first, then by alias
        let entry = this.timers.get(idOrAlias);
        if (!entry) {
            for (const [id, e] of this.timers.entries()) {
                if (e.record.alias === idOrAlias) {
                    entry = e;
                    idOrAlias = id;
                    break;
                }
            }
        }
        if (!entry) return false;

        entry.cron.stop();
        this.timers.delete(idOrAlias);
        this.saveToDisk();
        return true;
    }

    /** Stop all timers and clear in-memory state. */
    static stopAll(): void {
        for (const entry of this.timers.values()) {
            entry.cron.stop();
        }
        this.timers.clear();
    }

    /** Get count of active (enabled) jobs. */
    static get activeCount(): number {
        return this.timers.size;
    }
}
