import { tool } from 'ai';
import { z } from 'zod';
import { TaskScheduler } from '../scheduler.js';

export const scheduleRecurringTaskTool = tool({
    description: "CRITICAL: This is the ONLY way to create an alarm, timer, reminder, or scheduled recurring task. Use this when the user asks to 'warn me in 30 minutes', 'check X every day', or 'notify me at 2pm'. Do NOT just save it to memory; you MUST use this tool to actually trigger in the future. For a one-off task (e.g. 'in 30 mins'), calculate the exact minute and hour for the cron expression. Uses croner syntax (standard 5-field cron).",
    inputSchema: z.object({
        cron_expression: z.string().describe("A valid 5-field cron expression, e.g., '*/5 * * * *' for every 5 minutes, '0 0 * * *' for daily midnight."),
        prompt: z.string().describe("The instruction to execute when the cron job fires. Explain exactly what the agent should do."),
        alias: z.string().optional().describe("A short, human-friendly label for this job (e.g. 'daily-standup-report'). Auto-generated if omitted."),
    }),
    execute: async ({ cron_expression, prompt, alias }: { cron_expression: string; prompt: string; alias?: string }) => {
        try {
            const jobId = TaskScheduler.scheduleTask(cron_expression, prompt, alias);
            return `Job scheduled successfully. ID: ${jobId}, cron: ${cron_expression}, alias: ${alias ?? '(auto)'}`;
        } catch (err: any) {
            return `Failed to schedule task: ${err.message}`;
        }
    }
});
