/**
 * @redbusagent/daemon — Model Fallback
 *
 * Simplified model fallback inspired by openclaw's model-fallback.ts.
 * Manages a candidate chain for Cloud providers and handles
 * error classification, cooldowns, and automatic switching.
 */

import { retryAsync, isRetryableError } from './retry.js';

// ─── Types ───────────────────────────────────────────────────────

export interface ModelCandidate {
    provider: 'anthropic' | 'google' | 'openai';
    model: string;
}

export interface FallbackAttempt {
    provider: string;
    model: string;
    error: string;
    status?: number;
}

export interface ModelFallbackResult<T> {
    result: T;
    provider: string;
    model: string;
    attempts: FallbackAttempt[];
}

export interface ModelFallbackOptions<T> {
    /** Primary candidate (from user config) */
    primary: ModelCandidate;
    /** Additional fallback candidates */
    fallbacks?: ModelCandidate[];
    /** The function to run with the selected provider/model */
    run: (provider: string, model: string) => Promise<T>;
    /** Called on each error for logging */
    onError?: (attempt: FallbackAttempt, index: number, total: number) => void;
}

// ─── Cooldown Tracking ──────────────────────────────────────────

const cooldowns = new Map<string, number>();
const COOLDOWN_MS = 60_000; // 1 minute cooldown after failure

function modelKey(c: ModelCandidate): string {
    return `${c.provider}/${c.model}`;
}

function isInCooldown(candidate: ModelCandidate): boolean {
    const expiry = cooldowns.get(modelKey(candidate));
    if (!expiry) return false;
    if (Date.now() >= expiry) {
        cooldowns.delete(modelKey(candidate));
        return false;
    }
    return true;
}

function setCooldown(candidate: ModelCandidate): void {
    cooldowns.set(modelKey(candidate), Date.now() + COOLDOWN_MS);
}

// ─── Error Classification ───────────────────────────────────────

function isContextOverflowError(msg: string): boolean {
    const lower = msg.toLowerCase();
    return lower.includes('context length') ||
        lower.includes('context_length_exceeded') ||
        lower.includes('token limit') ||
        lower.includes('maximum context') ||
        lower.includes('too many tokens');
}

function isAbortError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    return (err as any).name === 'AbortError';
}

// ─── Main ────────────────────────────────────────────────────────

/**
 * Run an LLM call with automatic model fallback.
 * Tries each candidate in order, skipping cooled-down models.
 * Context overflow errors are NOT retried (a smaller model won't help).
 */
export async function runWithModelFallback<T>(
    options: ModelFallbackOptions<T>,
): Promise<ModelFallbackResult<T>> {
    const candidates: ModelCandidate[] = [options.primary];
    if (options.fallbacks) {
        // Deduplicate
        const seen = new Set<string>([modelKey(options.primary)]);
        for (const fb of options.fallbacks) {
            const key = modelKey(fb);
            if (!seen.has(key)) {
                seen.add(key);
                candidates.push(fb);
            }
        }
    }

    const attempts: FallbackAttempt[] = [];
    let lastError: unknown;

    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i]!;

        // Skip cooled-down models (unless it's the only one)
        if (candidates.length > 1 && isInCooldown(candidate)) {
            attempts.push({
                provider: candidate.provider,
                model: candidate.model,
                error: 'In cooldown — skipped',
            });
            continue;
        }

        try {
            // Wrap with retry for transient errors
            const result = await retryAsync(
                () => options.run(candidate.provider, candidate.model),
                {
                    attempts: 2,
                    minDelayMs: 500,
                    maxDelayMs: 5_000,
                    jitter: 0.3,
                    label: `model-fallback:${modelKey(candidate)}`,
                    shouldRetry: (err) => isRetryableError(err),
                    onRetry: (info) => {
                        console.log(`  🔄 [model-fallback] Retrying ${modelKey(candidate)} (attempt ${info.attempt}/${info.maxAttempts}, delay ${info.delayMs}ms)`);
                    },
                },
            );

            return { result, provider: candidate.provider, model: candidate.model, attempts };
        } catch (err) {
            // Abort errors should not trigger fallback
            if (isAbortError(err)) throw err;

            const errMsg = err instanceof Error ? err.message : String(err);

            // Context overflow: rethrow immediately — smaller model won't help
            if (isContextOverflowError(errMsg)) throw err;

            lastError = err;
            const status = (err as any)?.status ?? (err as any)?.statusCode;
            const attempt: FallbackAttempt = {
                provider: candidate.provider,
                model: candidate.model,
                error: errMsg.slice(0, 200),
                ...(typeof status === 'number' ? { status } : {}),
            };
            attempts.push(attempt);
            setCooldown(candidate);
            options.onError?.(attempt, i, candidates.length);
        }
    }

    // All candidates exhausted
    if (attempts.length <= 1 && lastError) throw lastError;
    const summary = attempts.map(a => `${a.provider}/${a.model}: ${a.error}`).join(' | ');
    throw new Error(`All models failed (${attempts.length}): ${summary}`, {
        cause: lastError instanceof Error ? lastError : undefined,
    });
}

