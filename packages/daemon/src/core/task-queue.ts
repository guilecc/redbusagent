/**
 * @redbusagent/daemon — Lane-Based Command Queue
 *
 * Serializes agent work using named "lanes" (main, cron, session:X).
 * Each lane runs at most `maxConcurrent` tasks in parallel (default 1).
 * Cross-lane work runs independently, enabling session-level parallelism
 * while maintaining strict serialization within a session.
 *
 * Key patterns from openclaw:
 *  • Generation tracking — prevents zombie tasks after reset/restart
 *  • Gateway draining — rejects new tasks during shutdown
 *  • Wait warnings — fires callback when a queued task waits too long
 *  • waitForActiveTasks — graceful drain before shutdown
 *
 * Inspired by openclaw/src/process/command-queue.ts
 */

// ─── Lane Constants ─────────────────────────────────────────────────

export const CommandLane = {
    Main: 'main',
    Cron: 'cron',
    Subagent: 'subagent',
} as const;

export type CommandLaneType = (typeof CommandLane)[keyof typeof CommandLane] | string;

// ─── Error Types ────────────────────────────────────────────────────

/** Thrown when a queued task is rejected because its lane was cleared. */
export class CommandLaneClearedError extends Error {
    constructor(lane?: string) {
        super(lane ? `Command lane "${lane}" cleared` : 'Command lane cleared');
        this.name = 'CommandLaneClearedError';
    }
}

/** Thrown when a new task is rejected because the gateway is draining for restart. */
export class GatewayDrainingError extends Error {
    constructor() {
        super('Gateway is draining for restart; new tasks are not accepted');
        this.name = 'GatewayDrainingError';
    }
}

// ─── Internal Types ─────────────────────────────────────────────────

interface QueueEntry {
    task: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    enqueuedAt: number;
    warnAfterMs: number;
    onWait?: (waitMs: number, queuedAhead: number) => void;
}

interface LaneState {
    lane: string;
    queue: QueueEntry[];
    activeTaskIds: Set<number>;
    maxConcurrent: number;
    draining: boolean;
    /** Bumped on reset; stale completions from old generations are ignored. */
    generation: number;
}

// ─── Module State ───────────────────────────────────────────────────

let gatewayDraining = false;
const lanes = new Map<string, LaneState>();
let nextTaskId = 1;

// ─── Internal Helpers ───────────────────────────────────────────────

function getLaneState(lane: string): LaneState {
    const existing = lanes.get(lane);
    if (existing) return existing;
    const created: LaneState = {
        lane,
        queue: [],
        activeTaskIds: new Set(),
        maxConcurrent: 1,
        draining: false,
        generation: 0,
    };
    lanes.set(lane, created);
    return created;
}

/** Returns true if the task belongs to the current generation. */
function completeTask(state: LaneState, taskId: number, taskGeneration: number): boolean {
    if (taskGeneration !== state.generation) return false;
    state.activeTaskIds.delete(taskId);
    return true;
}

/**
 * Pump pattern: dequeues entries up to maxConcurrent, each async task
 * calls pump() again on completion to keep the lane flowing.
 */
function drainLane(lane: string): void {
    const state = getLaneState(lane);
    if (state.draining) return;
    state.draining = true;

    const pump = () => {
        try {
            while (state.activeTaskIds.size < state.maxConcurrent && state.queue.length > 0) {
                const entry = state.queue.shift()!;
                const waitedMs = Date.now() - entry.enqueuedAt;
                if (waitedMs >= entry.warnAfterMs) {
                    try {
                        entry.onWait?.(waitedMs, state.queue.length);
                    } catch { /* swallow callback errors */ }
                    console.warn(`  ⏱️ [Queue] Lane "${lane}" wait exceeded: ${waitedMs}ms`);
                }
                const taskId = nextTaskId++;
                const taskGeneration = state.generation;
                state.activeTaskIds.add(taskId);

                void (async () => {
                    try {
                        const result = await entry.task();
                        const isCurrent = completeTask(state, taskId, taskGeneration);
                        if (isCurrent) pump();
                        entry.resolve(result);
                    } catch (err) {
                        const isCurrent = completeTask(state, taskId, taskGeneration);
                        if (isCurrent) pump();
                        entry.reject(err);
                    }
                })();
            }
        } finally {
            state.draining = false;
        }
    };

    pump();
}

// ─── Public API ─────────────────────────────────────────────────────

/** Mark gateway as draining; new enqueues are rejected with GatewayDrainingError. */
export function markGatewayDraining(): void {
    gatewayDraining = true;
}

/** Set per-lane concurrency limit (default 1 = strict serialization). */
export function setCommandLaneConcurrency(lane: string, maxConcurrent: number): void {
    const cleaned = lane.trim() || CommandLane.Main;
    const state = getLaneState(cleaned);
    state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
    drainLane(cleaned);
}

/** Enqueue a task into a specific lane. */
export function enqueueCommandInLane<T>(
    lane: string,
    task: () => Promise<T>,
    opts?: {
        warnAfterMs?: number;
        onWait?: (waitMs: number, queuedAhead: number) => void;
    },
): Promise<T> {
    if (gatewayDraining) {
        return Promise.reject(new GatewayDrainingError());
    }
    const cleaned = lane.trim() || CommandLane.Main;
    const warnAfterMs = opts?.warnAfterMs ?? 2_000;
    const state = getLaneState(cleaned);
    return new Promise<T>((resolve, reject) => {
        state.queue.push({
            task: () => task(),
            resolve: (value) => resolve(value as T),
            reject,
            enqueuedAt: Date.now(),
            warnAfterMs,
            onWait: opts?.onWait,
        });
        drainLane(cleaned);
    });
}

/** Enqueue a task in the default "main" lane. */
export function enqueueCommand<T>(
    task: () => Promise<T>,
    opts?: {
        warnAfterMs?: number;
        onWait?: (waitMs: number, queuedAhead: number) => void;
    },
): Promise<T> {
    return enqueueCommandInLane(CommandLane.Main, task, opts);
}

/** Get total size (active + queued) for a lane. */
export function getQueueSize(lane: string = CommandLane.Main): number {
    const resolved = lane.trim() || CommandLane.Main;
    const state = lanes.get(resolved);
    if (!state) return 0;
    return state.queue.length + state.activeTaskIds.size;
}

/** Get total size across all lanes. */
export function getTotalQueueSize(): number {
    let total = 0;
    for (const s of lanes.values()) {
        total += s.queue.length + s.activeTaskIds.size;
    }
    return total;
}

/** Clear a lane: reject all queued (not active) entries with CommandLaneClearedError. */
export function clearCommandLane(lane: string = CommandLane.Main): number {
    const cleaned = lane.trim() || CommandLane.Main;
    const state = lanes.get(cleaned);
    if (!state) return 0;
    const removed = state.queue.length;
    const pending = state.queue.splice(0);
    for (const entry of pending) {
        entry.reject(new CommandLaneClearedError(cleaned));
    }
    return removed;
}

/**
 * Reset all lane runtime state to idle. Used after in-process restarts
 * where interrupted tasks' finally blocks may not run, leaving stale
 * active task IDs that permanently block new work from draining.
 *
 * Bumps lane generation so stale completions from old tasks are ignored.
 * Queued entries are preserved — they represent pending user work.
 */
export function resetAllLanes(): void {
    gatewayDraining = false;
    const lanesToDrain: string[] = [];
    for (const state of lanes.values()) {
        state.generation += 1;
        state.activeTaskIds.clear();
        state.draining = false;
        if (state.queue.length > 0) {
            lanesToDrain.push(state.lane);
        }
    }
    // Drain after full reset so all lanes are clean first.
    for (const l of lanesToDrain) {
        drainLane(l);
    }
}

/** Returns total number of actively executing tasks across all lanes. */
export function getActiveTaskCount(): number {
    let total = 0;
    for (const s of lanes.values()) {
        total += s.activeTaskIds.size;
    }
    return total;
}

/**
 * Wait for all currently active tasks to finish (or timeout).
 * New tasks enqueued after this call are ignored.
 */
export function waitForActiveTasks(timeoutMs: number): Promise<{ drained: boolean }> {
    const POLL_INTERVAL_MS = 50;
    const deadline = Date.now() + timeoutMs;
    const activeAtStart = new Set<number>();
    for (const state of lanes.values()) {
        for (const taskId of state.activeTaskIds) {
            activeAtStart.add(taskId);
        }
    }

    return new Promise((resolve) => {
        const check = () => {
            if (activeAtStart.size === 0) {
                resolve({ drained: true });
                return;
            }
            let hasPending = false;
            for (const state of lanes.values()) {
                for (const taskId of state.activeTaskIds) {
                    if (activeAtStart.has(taskId)) {
                        hasPending = true;
                        break;
                    }
                }
                if (hasPending) break;
            }
            if (!hasPending) {
                resolve({ drained: true });
                return;
            }
            if (Date.now() >= deadline) {
                resolve({ drained: false });
                return;
            }
            setTimeout(check, POLL_INTERVAL_MS);
        };
        check();
    });
}

// ─── Backward-Compatible Singleton ──────────────────────────────────

/**
 * Thin wrapper preserving the old `taskQueue.enqueue()` API
 * while delegating to the lane-based system under the hood.
 */
export const taskQueue = {
    enqueue(task: { id: string; label: string; execute: () => Promise<void> }): Promise<void> {
        return enqueueCommand(task.execute, { warnAfterMs: 2_000 });
    },
    isProcessing(): boolean {
        return getActiveTaskCount() > 0;
    },
    get depth(): number {
        return getQueueSize(CommandLane.Main);
    },
};

