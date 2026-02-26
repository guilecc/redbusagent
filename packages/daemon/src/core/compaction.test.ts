/**
 * Tests for Context Compaction module
 */
import { describe, it, expect, vi } from 'vitest';
import {
    computeAdaptiveChunkRatio,
    splitForCompaction,
    compactHistory,
    BASE_CHUNK_RATIO,
    MIN_CHUNK_RATIO,
} from './compaction.js';

describe('computeAdaptiveChunkRatio', () => {
    it('returns 0 when under budget', () => {
        expect(computeAdaptiveChunkRatio(500, 1000)).toBe(0);
    });

    it('returns 0 when exactly at budget', () => {
        expect(computeAdaptiveChunkRatio(1000, 1000)).toBe(0);
    });

    it('returns a ratio between MIN and BASE when slightly over', () => {
        const ratio = computeAdaptiveChunkRatio(1200, 1000);
        expect(ratio).toBeGreaterThanOrEqual(MIN_CHUNK_RATIO);
        expect(ratio).toBeLessThanOrEqual(BASE_CHUNK_RATIO);
    });

    it('returns aggressive ratio when 2x+ over budget', () => {
        const ratio = computeAdaptiveChunkRatio(2500, 1000);
        expect(ratio).toBeGreaterThan(BASE_CHUNK_RATIO);
    });
});

describe('splitForCompaction', () => {
    it('splits messages into toSummarize and toKeep', () => {
        const msgs = Array.from({ length: 10 }, (_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `Message ${i}`,
        }));
        const { toSummarize, toKeep } = splitForCompaction(msgs, 0.4);
        expect(toSummarize.length).toBe(4);
        expect(toKeep.length).toBe(6);
        expect(toSummarize[0]!.content).toBe('Message 0');
        expect(toKeep[0]!.content).toBe('Message 4');
    });

    it('ensures at least 1 message in toSummarize', () => {
        const msgs = [{ role: 'user', content: 'hello' }];
        const { toSummarize } = splitForCompaction(msgs, 0.01);
        expect(toSummarize.length).toBe(1);
    });
});

describe('compactHistory', () => {
    it('returns unchanged messages when under budget', async () => {
        const msgs = [{ role: 'user', content: 'hello' }];
        const summarize = vi.fn();
        const result = await compactHistory(msgs, {
            maxTokens: 10000,
            targetTokens: 5000,
            summarize,
        });
        expect(result.compacted).toBe(false);
        expect(result.messages).toBe(msgs);
        expect(summarize).not.toHaveBeenCalled();
    });

    it('compacts when over budget', async () => {
        const longContent = 'word '.repeat(2000); // ~2000 tokens
        const msgs = Array.from({ length: 10 }, (_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: longContent,
        }));
        const summarize = vi.fn().mockResolvedValue('Summary of prior conversation.');
        const result = await compactHistory(msgs, {
            maxTokens: 500,
            targetTokens: 300,
            summarize,
        });
        expect(result.compacted).toBe(true);
        expect(result.summary).toBe('Summary of prior conversation.');
        expect(result.messages.length).toBeLessThan(msgs.length);
        expect(result.messages[0]!.role).toBe('system');
        expect(result.messages[0]!.content).toContain('CONVERSATION HISTORY SUMMARY');
    });

    it('handles summarization failure gracefully', async () => {
        const longContent = 'word '.repeat(2000);
        const msgs = Array.from({ length: 10 }, (_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: longContent,
        }));
        const summarize = vi.fn().mockRejectedValue(new Error('LLM down'));
        const result = await compactHistory(msgs, {
            maxTokens: 500,
            targetTokens: 300,
            summarize,
        });
        expect(result.compacted).toBe(false);
        expect(result.messages).toBe(msgs);
    });
});

