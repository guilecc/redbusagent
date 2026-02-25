import { tool } from 'ai';
import { z } from 'zod';
import { MemoryManager } from '../memory-manager.js';

export const searchMemoryAllTool = tool({
    description: `Searches ALL memory categories simultaneously for the most relevant memories. Use this when you're unsure which category contains the answer, or when the query could span multiple knowledge domains. Returns results ranked by semantic relevance with their source category. For targeted single-category searches, prefer 'search_memory' instead.`,
    inputSchema: z.object({
        query: z.string().describe('A semantic question or keywords to search across all memory categories.'),
        limit: z.number().optional().describe('Max results to return (default: 5).'),
    }),
    execute: async (params: { query: string; limit?: number }) => {
        try {
            const results = await MemoryManager.searchAllCategories(params.query, params.limit ?? 5);
            if (results.length === 0) {
                return { success: false, message: 'No relevant memories found across any category.' };
            }
            return {
                success: true,
                results: results.map(r => ({
                    category: r.category,
                    content: r.content,
                    relevance: Math.round((1 - r.distance) * 100) + '%',
                })),
            };
        } catch (error) {
            return { success: false, error: (error as Error).message };
        }
    },
});

