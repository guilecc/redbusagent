/**
 * @redbusagent/daemon — Auto-RAG Engine (Pre-flight Context Injection)
 *
 * Implements automatic retrieval-augmented generation by silently
 * performing a vector search BEFORE the user's message reaches the LLM.
 *
 * When the user sends a chat message (from TUI or WhatsApp), this module:
 * 1. Generates an embedding from the user's raw message
 * 2. Searches ALL known memory categories for the top 3 most relevant chunks
 * 3. Prepends the retrieved context to the prompt invisibly
 *
 * This eliminates the reliability problem of the LLM needing to actively
 * decide to call search_memory — the context is always there.
 */

import { MemoryManager } from './memory-manager.js';

// ─── Types ────────────────────────────────────────────────────────

export interface AutoRAGResult {
    /** The enriched prompt with prepended context */
    enrichedPrompt: string;
    /** Number of chunks retrieved */
    chunksFound: number;
    /** Categories that contributed results */
    sourceCats: string[];
    /** Time taken for the retrieval in ms */
    retrievalMs: number;
}

// ─── Auto-RAG Engine ─────────────────────────────────────────────

export class AutoRAG {
    /** Maximum number of chunks to retrieve across all categories */
    private static readonly MAX_CHUNKS = 3;

    /**
     * Performs pre-flight context injection.
     * Searches across ALL known memory categories and returns
     * the user's prompt prepended with the top relevant chunks.
     *
     * If retrieval fails (Ollama down, no embeddings, etc.), it silently
     * falls back to the original prompt — never blocks the user.
     */
    static async enrich(userMessage: string): Promise<AutoRAGResult> {
        const startTime = Date.now();

        try {
            const categories = MemoryManager.getCognitiveMap();

            if (categories.length === 0) {
                return {
                    enrichedPrompt: userMessage,
                    chunksFound: 0,
                    sourceCats: [],
                    retrievalMs: Date.now() - startTime,
                };
            }

            // Search across all categories in parallel for speed
            const searchPromises = categories.map(async (cat) => {
                try {
                    const results = await MemoryManager.searchMemory(cat, userMessage, 2);
                    return results.map((content) => ({ category: cat, content }));
                } catch {
                    return []; // Silently skip failed categories
                }
            });

            const allResults = (await Promise.all(searchPromises)).flat();

            if (allResults.length === 0) {
                return {
                    enrichedPrompt: userMessage,
                    chunksFound: 0,
                    sourceCats: [],
                    retrievalMs: Date.now() - startTime,
                };
            }

            // Take the top N chunks (they're already ranked by similarity within each category)
            const topChunks = allResults.slice(0, this.MAX_CHUNKS);
            const sourceCats = [...new Set(topChunks.map((c) => c.category))];

            // Build the invisible context block
            const contextBlock = topChunks
                .map((chunk, i) => `[${i + 1}/${topChunks.length}] (from: ${chunk.category}) ${chunk.content}`)
                .join('\n');

            const enrichedPrompt = `[SYSTEM AUTO-CONTEXT RETRIEVED FROM ARCHIVAL MEMORY — use this to inform your answer if relevant]\n${contextBlock}\n[END AUTO-CONTEXT]\n\nUser Message: ${userMessage}`;

            const retrievalMs = Date.now() - startTime;
            console.log(`  🔍 AutoRAG: Retrieved ${topChunks.length} chunks from [${sourceCats.join(', ')}] in ${retrievalMs}ms`);

            return {
                enrichedPrompt,
                chunksFound: topChunks.length,
                sourceCats,
                retrievalMs,
            };
        } catch (err) {
            // CRITICAL: Never block the user. If Auto-RAG fails, pass through.
            console.error('  ⚠️ AutoRAG: Retrieval failed, falling back to raw prompt:', err);
            return {
                enrichedPrompt: userMessage,
                chunksFound: 0,
                sourceCats: [],
                retrievalMs: Date.now() - startTime,
            };
        }
    }
}
