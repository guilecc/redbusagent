import { tool } from 'ai';
import { z } from 'zod';
import { MemoryManager } from '../memory-manager.js';

export const forgetMemoryTool = tool({
    description: `Removes specific memories from archival storage by semantic match. Use when the user says to "forget", "delete", or "remove" a memory, or when you discover stored information is outdated or incorrect. First use 'search_memory' to find the exact content, then pass it here to remove. Only high-similarity matches (cosine distance < 0.15) will be deleted.`,
    inputSchema: z.object({
        category: z.string().describe('The memory category to delete from. Must match one of the known categories in the Cognitive Map.'),
        content_match: z.string().describe('The exact or near-exact content string of the memory to remove. The system will find semantically similar records and delete them.'),
    }),
    execute: async (params: { category: string; content_match: string }) => {
        try {
            const count = await MemoryManager.forgetMemory(params.category, params.content_match);
            if (count === 0) {
                return { success: false, message: `No matching memories found in category "${params.category}" close enough to delete. Try using 'search_memory' first to find the exact content.` };
            }
            return { success: true, message: `Forgot ${count} memory(ies) from category "${params.category}".`, removedCount: count };
        } catch (error) {
            return { success: false, error: (error as Error).message };
        }
    },
});

