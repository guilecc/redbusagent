/**
 * @redbusagent/daemon — Context Compaction (Recursive Summarization)
 *
 * Inspired by openclaw's compaction.ts.
 * When conversation history exceeds token budget, older messages are
 * summarized into a compact digest, preserving decisions, TODOs, and constraints.
 */

import { estimateTokens } from './context-window-guard.js';

// ─── Constants ──────────────────────────────────────────────────

/** Ratio of history to compact (40% oldest messages) */
export const BASE_CHUNK_RATIO = 0.4;
/** Minimum ratio to ensure progress */
export const MIN_CHUNK_RATIO = 0.15;
/** Safety margin for token estimation inaccuracy */
export const SAFETY_MARGIN = 1.2;

const DEFAULT_SUMMARY_FALLBACK = 'No prior history.';

// ─── Types ───────────────────────────────────────────────────────

export interface CompactionConfig {
    /** Max tokens before compaction triggers */
    maxTokens: number;
    /** Target tokens after compaction */
    targetTokens: number;
    /** Summarization function (injected — calls the LLM) */
    summarize: (text: string, instruction: string) => Promise<string>;
}

export interface CompactionResult {
    messages: Array<{ role: string; content: string; [key: string]: unknown }>;
    compacted: boolean;
    summary?: string;
    originalTokens: number;
    finalTokens: number;
}

// ─── Helpers ────────────────────────────────────────────────────

function estimateMessagesTokens(messages: Array<{ content?: string }>): number {
    return messages.reduce((sum, m) => {
        return sum + (typeof m.content === 'string' ? estimateTokens(m.content) : 0) + 4;
    }, 0);
}

/**
 * Compute adaptive chunk ratio based on how far over budget we are.
 * The more over-budget, the more aggressively we compact.
 */
export function computeAdaptiveChunkRatio(
    currentTokens: number,
    maxTokens: number,
): number {
    const overflowRatio = currentTokens / maxTokens;
    if (overflowRatio <= 1) return 0; // No compaction needed
    if (overflowRatio >= 2) return BASE_CHUNK_RATIO + 0.2; // Very aggressive
    // Linear interpolation between MIN and BASE
    const t = (overflowRatio - 1);
    return MIN_CHUNK_RATIO + t * (BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
}

/**
 * Split messages into two groups: "to summarize" (oldest) and "to keep" (recent).
 */
export function splitForCompaction(
    messages: Array<{ role: string; content: string; [key: string]: unknown }>,
    ratio: number,
): {
    toSummarize: typeof messages;
    toKeep: typeof messages;
} {
    const splitIndex = Math.max(1, Math.floor(messages.length * ratio));
    return {
        toSummarize: messages.slice(0, splitIndex),
        toKeep: messages.slice(splitIndex),
    };
}

// ─── Main ────────────────────────────────────────────────────────

/**
 * Compact conversation history if it exceeds token budget.
 * Replaces oldest messages with an LLM-generated summary.
 */
export async function compactHistory(
    messages: Array<{ role: string; content: string; [key: string]: unknown }>,
    config: CompactionConfig,
): Promise<CompactionResult> {
    const originalTokens = estimateMessagesTokens(messages);

    // No compaction needed
    if (originalTokens <= config.maxTokens) {
        return { messages, compacted: false, originalTokens, finalTokens: originalTokens };
    }

    console.log(`  📦 [compaction] History exceeds budget (${originalTokens} > ${config.maxTokens} tokens). Compacting...`);

    const ratio = computeAdaptiveChunkRatio(originalTokens, config.maxTokens);
    const { toSummarize, toKeep } = splitForCompaction(messages, ratio);

    if (toSummarize.length === 0) {
        return { messages, compacted: false, originalTokens, finalTokens: originalTokens };
    }

    // Build conversation text for summarization
    const conversationText = toSummarize
        .map(m => `[${m.role}]: ${typeof m.content === 'string' ? m.content.slice(0, 1000) : '...'}`)
        .join('\n');

    const instruction = 'Summarize this conversation history into a compact digest. ' +
        'Preserve: key decisions, action items, TODOs, open questions, constraints, ' +
        'tool results that affect current state, and any file/path references. ' +
        'Be concise but complete. Use bullet points.';

    let summary: string;
    try {
        summary = await config.summarize(conversationText, instruction);
    } catch (err) {
        console.error('  ❌ [compaction] Summarization failed, keeping original:', err);
        return { messages, compacted: false, originalTokens, finalTokens: originalTokens };
    }

    if (!summary || summary.trim().length === 0) {
        summary = DEFAULT_SUMMARY_FALLBACK;
    }

    // Build compacted message array
    const compactedMessages = [
        {
            role: 'system' as const,
            content: `[CONVERSATION HISTORY SUMMARY]\n${summary}`,
            meta: { compacted: true, originalMessages: toSummarize.length },
        },
        ...toKeep,
    ];

    const finalTokens = estimateMessagesTokens(compactedMessages);
    console.log(`  📦 [compaction] Reduced ${originalTokens} → ${finalTokens} tokens (${toSummarize.length} messages summarized)`);

    return {
        messages: compactedMessages,
        compacted: true,
        summary,
        originalTokens,
        finalTokens,
    };
}

