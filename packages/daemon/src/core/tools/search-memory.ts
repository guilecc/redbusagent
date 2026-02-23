import { tool } from 'ai';
import { z } from 'zod';
import { MemoryManager } from '../memory-manager.js';

export const searchMemoryTool = tool({
    description: `Searches the deep organic RAG vector database for historic conversational context. If a user asks questions regarding a known specific system, client, framework, or architecture choice implicitly available in one of your Categories, search for it here. It will return the most semantically relevant memory blocks.`,
    inputSchema: z.object({
        category: z.string().describe('Broad namespace mapping to search this knowledge block from the Cognitive Map (e.g., "Architecture" or "ProjectContext"). Must perfectly match one of your known Categories.'),
        query: z.string().describe('A semantic question or sequence of words representing the specific piece of knowledge you seek within the category.'),
    }),
    execute: async (params: { category: string; query: string }) => {
        try {
            const results = await MemoryManager.searchMemory(params.category, params.query);
            if (!results.length) {
                return { success: false, message: `Nothing semantic found in category "${params.category}" matching "${params.query}".` };
            }
            return { success: true, blocks: results };
        } catch (error) {
            return { success: false, error: (error as Error).message };
        }
    },
});
