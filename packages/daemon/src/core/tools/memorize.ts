import { tool } from 'ai';
import { z } from 'zod';
import { MemoryManager } from '../memory-manager.js';

export const memorizeTool = tool({
    description: `Memorizes profound or important information for long-term usage. Stores a vectorized representation into the organic memory bank under a specific conceptual category. Use this whenever the user asks you to "remember", "memorize", or if you infer that a piece of organizational context or architecture definition will be useful forever. CRITICAL RULE: BEFORE calling 'memorize', you MUST call 'search_memory' to check if similar or contradicting facts already exist, and only proceed if it adds new value. If the user repeats something you already know, kindly let them know!`,
    inputSchema: z.object({
        category: z.string().describe('Broad namespace mapping to this knowledge block (e.g., "Architecture", "UserPreferences", "Onboarding").'),
        content: z.string().describe('Rich text containing all necessary contextual facts to be memorized. Include full descriptions.'),
    }),
    execute: async (params: { category: string; content: string }) => {
        try {
            const result = await MemoryManager.memorize(params.category, params.content);
            if (result.duplicate) {
                return { success: true, message: `This content already exists in category "${params.category}" — skipped duplicate storage.`, duplicate: true };
            }
            return { success: true, message: `Memorized chunk under category "${params.category}".`, duplicate: false };
        } catch (error) {
            return { success: false, error: (error as Error).message };
        }
    },
});
