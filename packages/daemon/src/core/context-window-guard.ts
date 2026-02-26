/**
 * @redbusagent/daemon — Context Window Guard
 *
 * Pre-flight token budget check inspired by openclaw's context-window-guard.ts.
 * Evaluates whether the prompt + context fits within the model's context window
 * and returns warn/block signals.
 */

// ─── Constants ──────────────────────────────────────────────────

/** Below this, block the request entirely */
export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 2_000;
/** Below this, emit a warning and consider trimming */
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 4_000;

// ─── Types ───────────────────────────────────────────────────────

export interface ContextWindowInfo {
    /** Total tokens available for the model */
    maxTokens: number;
    /** Estimated tokens consumed by system prompt + context */
    usedTokens: number;
    /** Remaining tokens for conversation */
    remainingTokens: number;
}

export interface ContextWindowGuardResult extends ContextWindowInfo {
    /** True if remaining tokens are below the warning threshold */
    shouldWarn: boolean;
    /** True if remaining tokens are below the hard minimum */
    shouldBlock: boolean;
    /** Recommended action */
    action: 'proceed' | 'warn' | 'compact' | 'block';
}

// ─── Token Estimation ───────────────────────────────────────────
// Rough estimator: ~4 chars per token for English text.
// This is intentionally conservative — better to over-estimate than under-estimate.

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessagesTokens(messages: Array<{ content?: string; role?: string }>): number {
    let total = 0;
    for (const msg of messages) {
        if (typeof msg.content === 'string') {
            total += estimateTokens(msg.content);
        }
        // Overhead for role, formatting
        total += 4;
    }
    return total;
}

// ─── Known Model Context Windows ────────────────────────────────

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
    // Anthropic
    'claude-sonnet-4-20250514': 200_000,
    'claude-3-5-sonnet-20241022': 200_000,
    'claude-3-haiku-20240307': 200_000,
    // Google
    'gemini-2.0-flash': 1_000_000,
    'gemini-1.5-pro': 2_000_000,
    'gemini-1.5-flash': 1_000_000,
    // OpenAI
    'gpt-4o': 128_000,
    'gpt-4o-mini': 128_000,
    'gpt-4-turbo': 128_000,
    // Local / Ollama
    'llama3.2:1b': 4_096,
    'llama3.2:3b': 4_096,
    'qwen2.5:7b': 32_768,
    'deepseek-r1:8b': 32_768,
    'mistral:7b': 32_768,
};

export function getModelContextWindow(model: string): number {
    return MODEL_CONTEXT_WINDOWS[model] ?? 128_000; // Conservative default
}

// ─── Guard Evaluation ───────────────────────────────────────────

/**
 * Evaluate whether the current context fits within the model's window.
 *
 * @param model - Model identifier
 * @param systemPromptTokens - Estimated tokens in system prompt
 * @param messageTokens - Estimated tokens in conversation messages
 * @param reserveTokens - Tokens to reserve for the model's response (default: 2000)
 */
export function evaluateContextWindowGuard(
    model: string,
    systemPromptTokens: number,
    messageTokens: number,
    reserveTokens = 2_000,
): ContextWindowGuardResult {
    const maxTokens = getModelContextWindow(model);
    const usedTokens = systemPromptTokens + messageTokens + reserveTokens;
    const remainingTokens = Math.max(0, maxTokens - usedTokens);

    const shouldBlock = remainingTokens < CONTEXT_WINDOW_HARD_MIN_TOKENS;
    const shouldWarn = remainingTokens < CONTEXT_WINDOW_WARN_BELOW_TOKENS;

    let action: ContextWindowGuardResult['action'] = 'proceed';
    if (shouldBlock) action = 'block';
    else if (shouldWarn && remainingTokens < CONTEXT_WINDOW_WARN_BELOW_TOKENS / 2) action = 'compact';
    else if (shouldWarn) action = 'warn';

    return {
        maxTokens,
        usedTokens,
        remainingTokens,
        shouldWarn,
        shouldBlock,
        action,
    };
}

