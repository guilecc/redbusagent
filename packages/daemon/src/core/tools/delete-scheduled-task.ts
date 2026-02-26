import { tool } from 'ai';
import { z } from 'zod';
import { TaskScheduler } from '../scheduler.js';

export const removeScheduledTaskTool = tool({
    description: "Removes a scheduled cron job by its ID or human-friendly alias. Use this when the user asks to cancel, stop, or remove a recurring task.",
    inputSchema: z.object({
        id_or_alias: z.string().describe("The job ID (UUID) or human-friendly alias to remove."),
    }),
    execute: async ({ id_or_alias }: { id_or_alias: string }) => {
        try {
            const success = TaskScheduler.deleteTask(id_or_alias);
            if (success) {
                return `Cron job "${id_or_alias}" removed successfully.`;
            }
            return `No cron job found matching "${id_or_alias}". Use list_scheduled_tasks to see active jobs.`;
        } catch (err: any) {
            return `Failed to remove job: ${err.message}`;
        }
    }
});
