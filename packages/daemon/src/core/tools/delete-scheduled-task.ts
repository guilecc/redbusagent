import { tool } from 'ai';
import { z } from 'zod';
import { TaskScheduler } from '../scheduler.js';

export const deleteScheduledTaskTool = tool({
    description: "Deletes a scheduled task, timer, alarm, or active cronjob by its ID. Use this when the user asks to cancel, explode, or remove a task.",
    inputSchema: z.object({
        taskId: z.string().describe("The ID of the task to delete")
    }),
    execute: async ({ taskId }: { taskId: string }) => {
        try {
            const success = TaskScheduler.deleteTask(taskId);
            if (success) {
                return `Task ${taskId} removed successfully.`;
            }
            return `Failed to remove task ${taskId}. Double check if the ID is valid.`;
        } catch (err: any) {
            return `Failed to delete task: ${err.message}`;
        }
    }
});
