/**
 * @redbusagent/daemon — Retry with Exponential Backoff
 *
 * Inspired by openclaw's retry.ts. Provides a generic `retryAsync()`
 * utility with exponential backoff, jitter, configurable shouldRetry,
 * and onRetry hooks.
 */

// ─── Types ───────────────────────────────────────────────────────

export interface RetryConfig {
    attempts: number;
    minDelayMs: number;
    maxDelayMs: number;
    /** Jitter factor 0–1. 0 = no jitter, 1 = ±100% randomization */
    jitter: number;
}

export interface RetryInfo {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    err: unknown;
    label?: string;
}

export interface RetryOptions extends Partial<RetryConfig> {
    label?: string;
    /** Return false to stop retrying for this specific error */
    shouldRetry?: (err: unknown, attempt: number) => boolean;
    /** Extract retry-after delay from error (e.g., rate-limit headers) */
    retryAfterMs?: (err: unknown) => number | undefined;
    onRetry?: (info: RetryInfo) => void;
}

// ─── Defaults ────────────────────────────────────────────────────

const DEFAULT_CONFIG: RetryConfig = {
    attempts: 3,
    minDelayMs: 300,
    maxDelayMs: 30_000,
    jitter: 0.2,
};

// ─── Helpers ─────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function applyJitter(delayMs: number, jitter: number): number {
    if (jitter <= 0) return delayMs;
    const offset = (Math.random() * 2 - 1) * jitter;
    return Math.max(0, Math.round(delayMs * (1 + offset)));
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Main ────────────────────────────────────────────────────────

/**
 * Retry an async function with exponential backoff and jitter.
 *
 * @example
 * const data = await retryAsync(() => fetchFromAPI(), { attempts: 3, label: 'api-call' });
 */
export async function retryAsync<T>(
    fn: () => Promise<T>,
    options: RetryOptions = {},
): Promise<T> {
    const maxAttempts = Math.max(1, Math.round(options.attempts ?? DEFAULT_CONFIG.attempts));
    const minDelayMs = Math.max(0, Math.round(options.minDelayMs ?? DEFAULT_CONFIG.minDelayMs));
    const maxDelayMs = Math.max(minDelayMs, Math.round(options.maxDelayMs ?? DEFAULT_CONFIG.maxDelayMs));
    const jitter = clamp(options.jitter ?? DEFAULT_CONFIG.jitter, 0, 1);
    const shouldRetry = options.shouldRetry ?? (() => true);

    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;

            if (attempt >= maxAttempts || !shouldRetry(err, attempt)) {
                break;
            }

            // Check for provider retry-after header
            const retryAfter = options.retryAfterMs?.(err);
            const hasRetryAfter = typeof retryAfter === 'number' && Number.isFinite(retryAfter);

            const baseDelay = hasRetryAfter
                ? Math.max(retryAfter, minDelayMs)
                : minDelayMs * 2 ** (attempt - 1);

            let delay = clamp(baseDelay, minDelayMs, maxDelayMs);
            delay = applyJitter(delay, jitter);
            delay = clamp(delay, minDelayMs, maxDelayMs);

            options.onRetry?.({
                attempt,
                maxAttempts,
                delayMs: delay,
                err,
                label: options.label,
            });

            await sleep(delay);
        }
    }

    throw lastErr ?? new Error('Retry failed');
}

// ─── Convenience: shouldRetry for HTTP-like errors ───────────────

/** Returns true for transient errors (429, 5xx, network errors) */
export function isRetryableError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const status = (err as any).status ?? (err as any).statusCode;
    if (typeof status === 'number') {
        return status === 429 || (status >= 500 && status < 600);
    }
    const code = (err as any).code;
    if (typeof code === 'string') {
        return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET'].includes(code);
    }
    return false;
}

