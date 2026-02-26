import { tool } from 'ai';
import { z } from 'zod';
import { WhatsAppChannel } from '../../channels/whatsapp.js';

export const sendWhatsappMessageTool = tool({
    description: `Sends a WhatsApp message to the owner's phone. CRITICAL RULE: NEVER use this tool unless the user explicitly uses the words 'WhatsApp', 'mensagem', 'avise', 'notifica', 'manda no zap', or explicitly requests to notify someone on their phone. If the user just asks a question, requests information, asks for a joke, or makes any kind of conversational request, DO NOT use this tool — answer in the standard chat instead. This tool is ONLY for deliberate, user-initiated outbound notifications. When in doubt, DO NOT use it.`,
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
