import { tool } from 'ai';
import { z } from 'zod';
import { TaskScheduler } from '../scheduler.js';

export const scheduleTaskTool = tool({
    description: "CRITICAL: This is the ONLY way to create an alarm, timer, reminder, or scheduled task. Use this when the user asks to 'warn me in 30 minutes', 'check X every day', or 'notify me at 2pm'. Do NOT just save it to memory; you MUST use this tool to actually trigger in the future. For a one-off task (e.g. 'in 30 mins'), calculate the exact minute and hour for the cron expression.",
    inputSchema: z.object({
        cron_expression: z.string().describe("A valid cron expression, e.g., '*/5 * * * *' for every 5 minutes, '0 0 * * *' for daily midnight."),
        prompt: z.string().describe("The instruction to execute when the cron job fires. Explain exactly what the agent should do."),
    }),
    execute: async ({ cron_expression, prompt }: { cron_expression: string; prompt: string }) => {
        try {
            const taskId = TaskScheduler.scheduleTask(cron_expression, prompt);
            return `Task scheduled successfully with ID: ${taskId} using cron expression: ${cron_expression}`;
        } catch (err: any) {
            return `Failed to schedule task: ${err.message}`;
        }
    }
});
