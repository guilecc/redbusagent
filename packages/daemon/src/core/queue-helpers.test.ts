import { describe, it, expect } from 'vitest';
import {
    normalizeQueueMode,
    normalizeQueueDropPolicy,
    elideQueueText,
    buildQueueSummaryLine,
    shouldSkipQueueItem,
    applyQueueDropPolicy,
    buildQueueSummaryPrompt,
    clearQueueSummaryState,
    applyQueueRuntimeSettings,
    type QueueState,
    type QueueSummaryState,
} from './queue-helpers.js';

// ─── normalizeQueueMode ──────────────────────────────────────────

describe('normalizeQueueMode', () => {
    it('returns valid mode unchanged', () => {
        expect(normalizeQueueMode('steer')).toBe('steer');
        expect(normalizeQueueMode('followup')).toBe('followup');
        expect(normalizeQueueMode('collect')).toBe('collect');
        expect(normalizeQueueMode('interrupt')).toBe('interrupt');
    });

    it('normalizes case and whitespace', () => {
        expect(normalizeQueueMode('  STEER  ')).toBe('steer');
    });

    it('returns fallback for invalid mode', () => {
        expect(normalizeQueueMode('invalid')).toBe('followup');
        expect(normalizeQueueMode('invalid', 'collect')).toBe('collect');
    });

    it('returns fallback for undefined', () => {
        expect(normalizeQueueMode(undefined)).toBe('followup');
    });
});

// ─── normalizeQueueDropPolicy ────────────────────────────────────

describe('normalizeQueueDropPolicy', () => {
    it('returns valid policy', () => {
        expect(normalizeQueueDropPolicy('summarize')).toBe('summarize');
        expect(normalizeQueueDropPolicy('old')).toBe('old');
        expect(normalizeQueueDropPolicy('new')).toBe('new');
    });

    it('returns fallback for invalid', () => {
        expect(normalizeQueueDropPolicy('x')).toBe('summarize');
    });

    it('returns fallback for undefined', () => {
        expect(normalizeQueueDropPolicy(undefined)).toBe('summarize');
    });
});

// ─── elideQueueText ──────────────────────────────────────────────

describe('elideQueueText', () => {
    it('returns short text unchanged', () => {
        expect(elideQueueText('hi', 10)).toBe('hi');
    });

    it('truncates and adds ellipsis', () => {
        const result = elideQueueText('hello world', 6);
        expect(result.endsWith('…')).toBe(true);
        expect(result.length).toBeLessThanOrEqual(6);
    });
});

// ─── buildQueueSummaryLine ───────────────────────────────────────

describe('buildQueueSummaryLine', () => {
    it('collapses whitespace', () => {
        expect(buildQueueSummaryLine('  a   b   c  ')).toBe('a b c');
    });
});

// ─── shouldSkipQueueItem ─────────────────────────────────────────

describe('shouldSkipQueueItem', () => {
    it('returns false when no dedupe fn', () => {
        expect(shouldSkipQueueItem({ item: 1, items: [1, 2] })).toBe(false);
    });

    it('uses dedupe function when provided', () => {
        const dedupe = (item: number, items: number[]) => items.includes(item);
        expect(shouldSkipQueueItem({ item: 1, items: [1, 2], dedupe })).toBe(true);
        expect(shouldSkipQueueItem({ item: 3, items: [1, 2], dedupe })).toBe(false);
    });
});

// ─── applyQueueDropPolicy ────────────────────────────────────────

function makeQueue(items: string[], cap: number, policy: 'summarize' | 'old' | 'new'): QueueState<string> {
    return { items: [...items], cap, dropPolicy: policy, droppedCount: 0, summaryLines: [] };
}

describe('applyQueueDropPolicy', () => {
    it('accepts when under cap', () => {
        const q = makeQueue(['a'], 5, 'summarize');
        expect(applyQueueDropPolicy({ queue: q, summarize: (s) => s })).toBe(true);
        expect(q.items).toEqual(['a']);
    });

    it('rejects new items with "new" policy', () => {
        const q = makeQueue(['a', 'b', 'c'], 3, 'new');
        expect(applyQueueDropPolicy({ queue: q, summarize: (s) => s })).toBe(false);
    });

    it('drops oldest with "old" policy (no summary)', () => {
        const q = makeQueue(['a', 'b', 'c'], 3, 'old');
        applyQueueDropPolicy({ queue: q, summarize: (s) => s });
        expect(q.items.length).toBeLessThan(3);
        expect(q.summaryLines).toEqual([]);
    });

    it('drops oldest and summarizes with "summarize" policy', () => {
        const q = makeQueue(['a', 'b', 'c'], 3, 'summarize');
        applyQueueDropPolicy({ queue: q, summarize: (s) => `msg:${s}` });
        expect(q.droppedCount).toBeGreaterThan(0);
        expect(q.summaryLines.length).toBeGreaterThan(0);
        expect(q.summaryLines[0]).toContain('msg:');
    });
});

// ─── buildQueueSummaryPrompt ─────────────────────────────────────

describe('buildQueueSummaryPrompt', () => {
    it('returns undefined when no drops', () => {
        const state: QueueSummaryState = { dropPolicy: 'summarize', droppedCount: 0, summaryLines: [] };
        expect(buildQueueSummaryPrompt({ state, noun: 'message' })).toBeUndefined();
    });

    it('returns undefined for non-summarize policy', () => {
        const state: QueueSummaryState = { dropPolicy: 'old', droppedCount: 2, summaryLines: ['a'] };
        expect(buildQueueSummaryPrompt({ state, noun: 'message' })).toBeUndefined();
    });

    it('builds prompt and clears state', () => {
        const state: QueueSummaryState = { dropPolicy: 'summarize', droppedCount: 2, summaryLines: ['hello', 'world'] };
        const result = buildQueueSummaryPrompt({ state, noun: 'message' });
        expect(result).toContain('Dropped 2 messages');
        expect(result).toContain('- hello');
        expect(result).toContain('- world');
        // State should be cleared
        expect(state.droppedCount).toBe(0);
        expect(state.summaryLines).toEqual([]);
    });

    it('uses singular noun for 1 drop', () => {
        const state: QueueSummaryState = { dropPolicy: 'summarize', droppedCount: 1, summaryLines: ['x'] };
        const result = buildQueueSummaryPrompt({ state, noun: 'message' });
        expect(result).toContain('1 message');
        expect(result).not.toContain('1 messages');
    });
});

