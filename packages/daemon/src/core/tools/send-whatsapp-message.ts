import { tool } from 'ai';
import { z } from 'zod';
import { WhatsAppChannel } from '../../channels/whatsapp.js';

export const sendWhatsappMessageTool = tool({
    description: `Send a direct proactive message via WhatsApp to the application's owner. Use this when the user asks you to remind them on WhatsApp, or to surface important updates and alerts asynchronously to their phone.`,
    inputSchema: z.object({
        message: z.string().describe('The message content to send to the owner over WhatsApp.'),
    }),
    execute: async (params: { message: string }) => {
        try {
            await WhatsAppChannel.getInstance().sendNotificationToOwner(params.message);
            return { success: true, delivered: true, message: "Successfully sent message to owner via WhatsApp." };
        } catch (error) {
            return { success: false, error: (error as Error).message };
        }
    },
});
