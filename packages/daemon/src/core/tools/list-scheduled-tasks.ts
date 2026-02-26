import { tool } from 'ai';
import { z } from 'zod';
import { TaskScheduler } from '../scheduler.js';

export const listScheduledTasksTool = tool({
    description: "Lists all currently registered scheduled/recurring cron jobs with their ID, alias, expression, next run time, and last run time.",
    inputSchema: z.object({}),
    execute: async () => {
        try {
            const tasks = TaskScheduler.listScheduledTasks();
            if (tasks.length === 0) {
                return "There are no cron jobs scheduled right now.";
            }
            return JSON.stringify(tasks, null, 2);
        } catch (err: any) {
            return `Failed to list tasks: ${err.message}`;
        }
    }
});
