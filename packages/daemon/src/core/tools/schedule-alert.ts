import { tool } from 'ai';
import { z } from 'zod';
import { AlertManager } from '../alert-manager.js';

export const scheduleAlertTool = tool({
    description: `Schedules a reminder or an alert to be shown to the user at a specific date and time in the future. Use this when the user says "remind me to...", "avise-me amanhã", or when your autonomous proactive engine decides it should check back on the user later.`,
    inputSchema: z.object({
        message: z.string().describe('The content of the alert/notification to show.'),
        scheduledDate: z.string().describe('ISO-8601 formatted date and time for when the alert should trigger.'),
    }),
    execute: async (params: { message: string; scheduledDate: string }) => {
        try {
            const date = new Date(params.scheduledDate);
            if (isNaN(date.getTime())) {
                return { success: false, error: "Invalid ISO date format." };
            }
            const alert = AlertManager.addAlert(params.message, date.toISOString());
            return {
                success: true,
                message: `Alert scheduled successfully! It will ring exactly at ${date.toLocaleString('pt-BR')}.`,
                alertId: alert.id
            };
        } catch (error) {
            return { success: false, error: (error as Error).message };
        }
    },
});
