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
import { HeavyTaskQueue } from '../heavy-task-queue.js';
import { Vault } from '@redbusagent/shared';

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

            // ─── Dual-Local: Auto-delegate compression to Worker Engine ──
            if (result.needsCompression) {
                const workerEnabled = Vault.read()?.worker_engine?.enabled ?? false;
                if (workerEnabled) {
                    const currentMemory = CoreMemory.read();
                    HeavyTaskQueue.enqueue({
                        description: 'Distill core-memory.md (auto-triggered by overflow)',
                        type: 'distill_memory',
                        prompt: `You are a memory compression engine. Below is the current core-memory.md which has exceeded its size limit.\n\nCURRENT CORE MEMORY:\n${currentMemory}\n\nCOMPRESS this into a highly condensed version under 3000 characters. Preserve:\n- Active goals and tasks\n- Critical user context and preferences\n- Key facts and architecture decisions\n- File paths and references\n\nRemove:\n- Redundant or outdated information\n- Verbose descriptions that can be shortened\n- Completed tasks that are no longer relevant\n\nReturn ONLY the compressed markdown content, nothing else.`,
                        onComplete: (compressed) => {
                            CoreMemory.replace(compressed);
                            console.log(`  🧠 [Worker] Core Memory distilled successfully (${compressed.length} chars)`);
                        },
                    });
                    return {
                        success: true,
                        message: `Fact appended to Core Memory. ⚠️ Memory overflow detected — distillation delegated to Worker Engine (background).`,
                        needsCompression: true,
                    };
                }
            }

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
