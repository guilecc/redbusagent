import { tool } from 'ai';
import { z } from 'zod';
import { TaskScheduler } from '../scheduler.js';

export const listScheduledTasksTool = tool({
    description: "Lists all currently active scheduled tasks, reminders, alarms, or cron jobs running in the engine.",
    inputSchema: z.object({}),
    execute: async () => {
        try {
            const tasks = TaskScheduler.listScheduledTasks();
            if (tasks.length === 0) {
                return "There are no tasks scheduled right now.";
            }
            return JSON.stringify(tasks, null, 2);
        } catch (err: any) {
            return `Failed to list tasks: ${err.message}`;
        }
    }
});
