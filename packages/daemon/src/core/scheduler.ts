import cron, { type ScheduledTask } from 'node-cron';
import { DaemonWsServer } from '../infra/ws-server.js';
import { ChatHandler } from './chat-handler.js';
import { v4 as uuidv4 } from 'uuid';
import { Vault } from '@redbusagent/shared';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class TaskScheduler {
    private static wsServer: DaemonWsServer;
    private static chatHandler: ChatHandler;
    private static jobs: Map<string, { job: ScheduledTask, expression: string, prompt: string }> = new Map();

    private static get storagePath(): string {
        return join(Vault.dir, 'scheduler.json');
    }

    static init(wsServer: DaemonWsServer, chatHandler: ChatHandler) {
        this.wsServer = wsServer;
        this.chatHandler = chatHandler;
        this.loadTasksFromDisk();
    }

    private static loadTasksFromDisk() {
        if (!existsSync(this.storagePath)) return;
        try {
            const data = readFileSync(this.storagePath, 'utf-8');
            const tasks = JSON.parse(data) as Array<{ id: string; expression: string; prompt: string }>;
            for (const t of tasks) {
                console.log(`  ⏱️ [Scheduler] Restoring task from disk: ${t.id}`);
                this.scheduleTask(t.expression, t.prompt, t.id);
            }
        } catch (err: any) {
            console.error('  ❌ [Scheduler] Failed to load tasks from disk:', err.message);
        }
    }

    private static saveTasksToDisk() {
        try {
            const tasks = this.listScheduledTasks();
            writeFileSync(this.storagePath, JSON.stringify(tasks, null, 2), 'utf-8');
        } catch (err: any) {
            console.error('  ❌ [Scheduler] Failed to save tasks to disk:', err.message);
        }
    }

    static scheduleTask(cronExpression: string, prompt: string, existingTaskId?: string): string {
        if (!cron.validate(cronExpression)) {
            throw new Error(`Invalid cron expression: ${cronExpression}`);
        }

        const taskId = existingTaskId || uuidv4();

        const job = cron.schedule(cronExpression, async () => {
            console.log(`\n  ⏱️ [Scheduler] Executing scheduled task: ${taskId}`);

            const vaultConfig = Vault.read();
            const tier1Config = vaultConfig?.tier1;
            const powerClass = (tier1Config as any)?.power_class || 'bronze';

            // "MUST flag it to be strictly executed by Tier 2 (or Tier 1 Gold) to guarantee accurate analytical results."
            const requiredTier = (powerClass === 'gold' || powerClass === 'platinum') ? 'tier1' : 'tier2';

            this.wsServer.broadcast({
                type: 'log',
                timestamp: new Date().toISOString(),
                payload: { level: 'info', source: 'Scheduler', message: `Executing scheduled task: ${prompt.substring(0, 50)}...` }
            });

            try {
                // We send it as a synthetic chat request from the backend itself
                await this.chatHandler.handleChatRequest('scheduler', {
                    type: 'chat:request',
                    timestamp: new Date().toISOString(),
                    payload: {
                        requestId: `cron-${taskId}-${Date.now()}`,
                        content: `[SCHEDULED TASK] ${prompt}`,
                        tier: requiredTier,
                        isOnboarding: false
                    }
                });
            } catch (err) {
                console.error(`  ❌ [Scheduler] Error executing task:`, err);
            }
        });

        this.jobs.set(taskId, { job, expression: cronExpression, prompt });
        job.start();

        // Save to disk whenever a new task is completely scheduled
        this.saveTasksToDisk();

        return taskId;
    }

    static stopAll() {
        for (const record of this.jobs.values()) {
            record.job.stop();
        }
        this.jobs.clear();
    }

    static listScheduledTasks(): Array<{ id: string; expression: string; prompt: string }> {
        const tasks = [];
        for (const [id, record] of this.jobs.entries()) {
            tasks.push({ id, expression: record.expression, prompt: record.prompt });
        }
        return tasks;
    }

    static deleteTask(taskId: string): boolean {
        const record = this.jobs.get(taskId);
        if (record) {
            record.job.stop();
            this.jobs.delete(taskId);
            this.saveTasksToDisk();
            return true;
        }
        return false;
    }
}
