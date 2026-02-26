/**
 * Tests for Context Window Guard module
 */
import { describe, it, expect } from 'vitest';
import {
    estimateTokens,
    getModelContextWindow,
    evaluateContextWindowGuard,
} from './context-window-guard.js';

describe('estimateTokens', () => {
    it('estimates tokens using ~4 chars per token', () => {
        const text = 'a'.repeat(400);
        const tokens = estimateTokens(text);
        expect(tokens).toBe(100); // 400 / 4
    });

    it('returns 0 for empty string', () => {
        expect(estimateTokens('')).toBe(0);
    });

    it('handles short strings', () => {
        expect(estimateTokens('hi')).toBeGreaterThan(0);
    });
});

describe('getModelContextWindow', () => {
    it('returns known window for common models', () => {
        // Claude models
        expect(getModelContextWindow('claude-3-5-sonnet-20241022')).toBeGreaterThan(100000);
    });

    it('returns default for unknown models', () => {
        const window = getModelContextWindow('totally-unknown-model-xyz');
        expect(window).toBeGreaterThan(0);
        expect(window).toBeLessThanOrEqual(128000);
    });
});

describe('evaluateContextWindowGuard', () => {
    it('returns proceed for small messages', () => {
        const result = evaluateContextWindowGuard('claude-3-5-sonnet-20241022', 100, 200);
        expect(result.action).toBe('proceed');
        expect(result.shouldBlock).toBe(false);
    });

    it('warns when remaining tokens are below warn threshold', () => {
        const window = getModelContextWindow('claude-3-5-sonnet-20241022');
        // Leave ~3500 remaining (below CONTEXT_WINDOW_WARN_BELOW_TOKENS=4000)
        // usedTokens = systemPromptTokens + messageTokens + reserveTokens(2000)
        const messageTokens = window - 3500 - 100 - 2000;
        const result = evaluateContextWindowGuard('claude-3-5-sonnet-20241022', 100, messageTokens);
        expect(result.shouldWarn).toBe(true);
        expect(result.shouldBlock).toBe(false);
    });

    it('blocks when remaining tokens are below hard minimum', () => {
        const window = getModelContextWindow('claude-3-5-sonnet-20241022');
        // Leave ~1000 remaining (below CONTEXT_WINDOW_HARD_MIN_TOKENS=2000)
        const messageTokens = window - 1000 - 100 - 2000;
        const result = evaluateContextWindowGuard('claude-3-5-sonnet-20241022', 100, messageTokens);
        expect(result.shouldBlock).toBe(true);
    });

    it('includes token counts in result (systemPrompt + message + reserve)', () => {
        const result = evaluateContextWindowGuard('test-model', 500, 1000);
        // usedTokens = 500 + 1000 + 2000 (default reserve)
        expect(result.usedTokens).toBe(3500);
        expect(result.maxTokens).toBeGreaterThan(0);
        expect(result.remainingTokens).toBe(result.maxTokens - result.usedTokens);
    });
});

