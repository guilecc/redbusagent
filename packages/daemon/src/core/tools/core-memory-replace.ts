/**
 * @redbusagent/daemon — core_memory_replace Tool
 *
 * Native tool that allows the LLM (or the Heartbeat Compressor) to fully
 * replace the contents of the Core Working Memory (core-memory.md).
 *
 * This is the MemGPT-style mechanism for the agent to maintain its own
 * compressed working memory — distilling facts, dropping irrelevant
 * context, and updating active tasks.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { CoreMemory } from '../core-memory.js';

export const coreMemoryReplaceTool = tool({
    description: `Replaces the entire Core Working Memory with a new compressed version. Use this to update your working context when important facts change, goals shift, or you need to distill the current state. The Core Memory is always visible to you in your system prompt — keep it concise, structured, and under 1000 tokens. Structure it with sections: ## Active Goals, ## User Context, ## Critical Facts, ## Active Tasks.`,
    inputSchema: z.object({
        new_content: z.string().describe(
            'The complete new content for core-memory.md. Must be well-structured markdown with sections for Active Goals, User Context, Critical Facts, and Active Tasks. Keep it highly compressed — facts only, no fluff.'
        ),
    }),
    execute: async (params: { new_content: string }) => {
        try {
            const result = CoreMemory.replace(params.new_content);
            return {
                success: true,
                message: `Core Memory updated (${result.charCount} chars).${result.truncated ? ' ⚠️ Content was truncated to fit the 1000-token limit.' : ''}`,
                charCount: result.charCount,
                truncated: result.truncated,
            };
        } catch (error) {
            return { success: false, error: (error as Error).message };
        }
    },
});

export const coreMemoryAppendTool = tool({
    description: `Appends a new fact or update to the Core Working Memory without replacing everything. Use this for quick, incremental updates — adding a new discovered fact, noting a completed task, or recording a user preference. If the memory gets too large, a compression cycle will be triggered automatically.`,
    inputSchema: z.object({
        fact: z.string().describe(
            'A concise fact, status update, or context snippet to append. Keep it to 1-2 lines.'
        ),
    }),
    execute: async (params: { fact: string }) => {
        try {
            const result = CoreMemory.append(params.fact);
            return {
                success: true,
                message: `Fact appended to Core Memory.${result.needsCompression ? ' ⚠️ Memory is full — compression cycle recommended.' : ''}`,
                needsCompression: result.needsCompression,
            };
        } catch (error) {
            return { success: false, error: (error as Error).message };
        }
    },
});
