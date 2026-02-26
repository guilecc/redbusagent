/**
 * @redbusagent/daemon — Queue Helper Utilities
 *
 * Ported from openclaw/src/utils/queue-helpers.ts.
 * Provides:
 *  • Queue modes (steer / followup / collect / interrupt)
 *  • Drop policies (old / new / summarize)
 *  • Debounce / deduplication helpers
 *  • Summary prompt building for dropped messages
 */

// ─── Queue Modes ─────────────────────────────────────────────────────

export type QueueMode = 'steer' | 'followup' | 'collect' | 'interrupt';

/** All valid queue modes for normalization. */
const VALID_MODES: ReadonlySet<string> = new Set<QueueMode>([
    'steer', 'followup', 'collect', 'interrupt',
]);

export function normalizeQueueMode(mode: string | undefined, fallback: QueueMode = 'followup'): QueueMode {
    if (!mode) return fallback;
    const cleaned = mode.trim().toLowerCase();
    return VALID_MODES.has(cleaned) ? (cleaned as QueueMode) : fallback;
}

// ─── Drop Policies ───────────────────────────────────────────────────

export type QueueDropPolicy = 'summarize' | 'old' | 'new';

const VALID_DROP_POLICIES: ReadonlySet<string> = new Set<QueueDropPolicy>([
    'summarize', 'old', 'new',
]);

export function normalizeQueueDropPolicy(
    policy: string | undefined,
    fallback: QueueDropPolicy = 'summarize',
): QueueDropPolicy {
    if (!policy) return fallback;
    const cleaned = policy.trim().toLowerCase();
    return VALID_DROP_POLICIES.has(cleaned) ? (cleaned as QueueDropPolicy) : fallback;
}

// ─── Queue State ─────────────────────────────────────────────────────

export interface QueueSummaryState {
    dropPolicy: QueueDropPolicy;
    droppedCount: number;
    summaryLines: string[];
}

export interface QueueState<T> extends QueueSummaryState {
    items: T[];
    cap: number;
}

export function clearQueueSummaryState(state: QueueSummaryState): void {
    state.droppedCount = 0;
    state.summaryLines = [];
}

// ─── Runtime Settings ────────────────────────────────────────────────

export function applyQueueRuntimeSettings<TMode extends string>(params: {
    target: { mode: TMode; debounceMs: number; cap: number; dropPolicy: QueueDropPolicy };
    settings: { mode: TMode; debounceMs?: number; cap?: number; dropPolicy?: QueueDropPolicy };
}): void {
    params.target.mode = params.settings.mode;
    params.target.debounceMs = typeof params.settings.debounceMs === 'number'
        ? Math.max(0, params.settings.debounceMs)
        : params.target.debounceMs;
    params.target.cap = typeof params.settings.cap === 'number' && params.settings.cap > 0
        ? Math.floor(params.settings.cap)
        : params.target.cap;
    params.target.dropPolicy = params.settings.dropPolicy ?? params.target.dropPolicy;
}

// ─── Text Helpers ────────────────────────────────────────────────────

export function elideQueueText(text: string, limit = 140): string {
    if (text.length <= limit) return text;
    return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function buildQueueSummaryLine(text: string, limit = 160): string {
    const cleaned = text.replace(/\s+/g, ' ').trim();
    return elideQueueText(cleaned, limit);
}

// ─── Deduplication ───────────────────────────────────────────────────

export function shouldSkipQueueItem<T>(params: {
    item: T;
    items: T[];
    dedupe?: (item: T, items: T[]) => boolean;
}): boolean {
    if (!params.dedupe) return false;
    return params.dedupe(params.item, params.items);
}

// ─── Drop Policy Application ─────────────────────────────────────────

export function applyQueueDropPolicy<T>(params: {
    queue: QueueState<T>;
    summarize: (item: T) => string;
    summaryLimit?: number;
}): boolean {
    const { cap } = params.queue;
    if (cap <= 0 || params.queue.items.length < cap) return true;
    if (params.queue.dropPolicy === 'new') return false;

    const dropCount = params.queue.items.length - cap + 1;
    const dropped = params.queue.items.splice(0, dropCount);
    if (params.queue.dropPolicy === 'summarize') {
        for (const item of dropped) {
            params.queue.droppedCount += 1;
            params.queue.summaryLines.push(buildQueueSummaryLine(params.summarize(item)));
        }
        const limit = Math.max(0, params.summaryLimit ?? cap);
        while (params.queue.summaryLines.length > limit) {
            params.queue.summaryLines.shift();
        }
    }
    return true;
}

// ─── Debounce ────────────────────────────────────────────────────────

export function waitForQueueDebounce(queue: {
    debounceMs: number;
    lastEnqueuedAt: number;
}): Promise<void> {
    const debounceMs = Math.max(0, queue.debounceMs);
    if (debounceMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const check = () => {
            const since = Date.now() - queue.lastEnqueuedAt;
            if (since >= debounceMs) { resolve(); return; }
            setTimeout(check, debounceMs - since);
        };
        check();
    });
}

// ─── Summary Prompt Builder ──────────────────────────────────────────

export function buildQueueSummaryPrompt(params: {
    state: QueueSummaryState;
    noun: string;
    title?: string;
}): string | undefined {
    if (params.state.dropPolicy !== 'summarize' || params.state.droppedCount <= 0) return undefined;
    const title = params.title ??
        `[Queue overflow] Dropped ${params.state.droppedCount} ${params.state.droppedCount === 1 ? params.noun : params.noun + 's'} due to cap.`;
    const lines = [title];
    if (params.state.summaryLines.length > 0) {
        lines.push('Summary:');
        for (const line of params.state.summaryLines) lines.push(`- ${line}`);
    }
    clearQueueSummaryState(params.state);
    return lines.join('\n');
}

