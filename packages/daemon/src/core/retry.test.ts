/**
 * Tests for Retry with Backoff module
 */
import { describe, it, expect, vi } from 'vitest';
import { retryAsync, isRetryableError } from './retry.js';

describe('retryAsync', () => {
    it('returns result on first success', async () => {
        const fn = vi.fn().mockResolvedValue('ok');
        const result = await retryAsync(fn, { attempts: 3, minDelayMs: 10, maxDelayMs: 20, jitter: 0 });
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on failure and succeeds', async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error('temporary'))
            .mockResolvedValue('ok');
        const result = await retryAsync(fn, { attempts: 3, minDelayMs: 10, maxDelayMs: 20, jitter: 0 });
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('throws after exhausting attempts', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('persistent'));
        await expect(retryAsync(fn, { attempts: 2, minDelayMs: 10, maxDelayMs: 20, jitter: 0 }))
            .rejects.toThrow('persistent');
        expect(fn).toHaveBeenCalledTimes(2); // 2 attempts total
    });

    it('respects shouldRetry to skip non-retryable errors', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('Invalid API key'));
        await expect(retryAsync(fn, {
            attempts: 3,
            minDelayMs: 10,
            maxDelayMs: 20,
            jitter: 0,
            shouldRetry: () => false,
        })).rejects.toThrow('Invalid API key');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('calls onRetry callback with RetryInfo', async () => {
        const onRetry = vi.fn();
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error('timeout'))
            .mockResolvedValue('ok');
        await retryAsync(fn, { attempts: 3, minDelayMs: 10, maxDelayMs: 20, jitter: 0, onRetry });
        expect(onRetry).toHaveBeenCalledTimes(1);
        expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({
            attempt: 1,
            maxAttempts: 3,
        }));
    });
});

describe('isRetryableError', () => {
    it('returns true for 429 status', () => {
        expect(isRetryableError({ status: 429 })).toBe(true);
    });

    it('returns true for 5xx status', () => {
        expect(isRetryableError({ status: 500 })).toBe(true);
        expect(isRetryableError({ status: 503 })).toBe(true);
    });

    it('returns true for network error codes', () => {
        expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true);
        expect(isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
    });

    it('returns false for 400 errors', () => {
        expect(isRetryableError({ status: 400 })).toBe(false);
    });

    it('returns false for null/undefined', () => {
        expect(isRetryableError(null)).toBe(false);
        expect(isRetryableError(undefined)).toBe(false);
    });
});

