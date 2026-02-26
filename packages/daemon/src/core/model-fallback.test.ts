/**
 * Tests for Model Fallback module
 */
import { describe, it, expect, vi } from 'vitest';
import { runWithModelFallback, type ModelCandidate } from './model-fallback.js';

const primary: ModelCandidate = { provider: 'anthropic', model: 'claude-3-5-sonnet' };
const fallback1: ModelCandidate = { provider: 'google', model: 'gemini-2.0-flash' };
const fallback2: ModelCandidate = { provider: 'openai', model: 'gpt-4o' };

describe('runWithModelFallback', () => {
    it('returns result from primary on success', async () => {
        const result = await runWithModelFallback({
            primary,
            run: async () => 'ok',
        });
        expect(result.result).toBe('ok');
        expect(result.provider).toBe('anthropic');
        expect(result.model).toBe('claude-3-5-sonnet');
        expect(result.attempts).toHaveLength(0);
    });

    it('falls back when primary fails with transient error', async () => {
        const run = vi.fn()
            .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
            .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 })) // retry of primary
            .mockResolvedValue('fallback-ok');
        const result = await runWithModelFallback({
            primary,
            fallbacks: [fallback1],
            run,
        });
        expect(result.result).toBe('fallback-ok');
        expect(result.provider).toBe('google');
    });

    it('throws context overflow without trying fallbacks', async () => {
        const run = vi.fn().mockRejectedValue(new Error('context_length_exceeded'));
        await expect(runWithModelFallback({
            primary,
            fallbacks: [fallback1],
            run,
        })).rejects.toThrow('context_length_exceeded');
        // Should NOT have tried fallback
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('throws when all candidates fail', async () => {
        const run = vi.fn().mockRejectedValue(Object.assign(new Error('server error'), { status: 500 }));
        await expect(runWithModelFallback({
            primary,
            fallbacks: [fallback1, fallback2],
            run,
        })).rejects.toThrow('All models failed');
    });

    it('calls onError callback for each failure', async () => {
        // Use unique candidates to avoid cooldown pollution from prior tests
        const uniquePrimary: ModelCandidate = { provider: 'anthropic', model: 'onerror-test-primary' };
        const uniqueFallback: ModelCandidate = { provider: 'google', model: 'onerror-test-fallback' };
        const onError = vi.fn();
        const run = vi.fn().mockRejectedValue(Object.assign(new Error('oops'), { status: 500 }));
        await expect(runWithModelFallback({
            primary: uniquePrimary,
            fallbacks: [uniqueFallback],
            run,
            onError,
        })).rejects.toThrow('All models failed');
        expect(onError).toHaveBeenCalled();
    });

    it('deduplicates candidates', async () => {
        const run = vi.fn().mockResolvedValue('ok');
        await runWithModelFallback({
            primary,
            fallbacks: [primary], // same as primary
            run,
        });
        // Should only call once since it's deduplicated
        expect(run).toHaveBeenCalledTimes(1);
    });
});

