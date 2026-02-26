/**
 * @redbusagent/daemon — Heavy Task Queue
 *
 * Dual-Local Architecture: Manages background tasks delegated from the
 * Live Engine to the Worker Engine. Tasks are enqueued by the Router
 * when it detects complex operations, and processed independently by
 * the HeartbeatManager's worker loop.
 *
 * The Worker Engine runs on CPU/System RAM (not GPU VRAM), so it can
 * handle large models (14B-32B) that would freeze the GPU.
 */

import { EventEmitter } from 'node:events';

// ─── Types ────────────────────────────────────────────────────────

export type HeavyTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface HeavyTask {
    /** Unique task ID */
    readonly id: string;
    /** Human-readable description */
    readonly description: string;
    /** The prompt to send to the Worker Engine */
    readonly prompt: string;
    /** Task type for categorization */
    readonly type: 'distill_memory' | 'deep_analysis' | 'code_review' | 'general';
    /** Current status */
    status: HeavyTaskStatus;
    /** Result text from worker engine (populated on completion) */
    result?: string;
    /** Error message (populated on failure) */
    error?: string;
    /** Timestamp when enqueued */
    readonly enqueuedAt: number;
    /** Timestamp when processing started */
    startedAt?: number;
    /** Timestamp when completed/failed */
    completedAt?: number;
    /** Optional callback invoked when task completes */
    onComplete?: (result: string) => void;
    /** Optional callback invoked on failure */
    onError?: (error: Error) => void;
}

// ─── Queue ────────────────────────────────────────────────────────

class HeavyTaskQueueImpl extends EventEmitter {
    private queue: HeavyTask[] = [];
    private idCounter = 0;

    /** Enqueue a new heavy task for the Worker Engine */
    enqueue(params: {
        description: string;
        prompt: string;
        type?: HeavyTask['type'];
        onComplete?: (result: string) => void;
        onError?: (error: Error) => void;
    }): string {
        const id = `heavy-${++this.idCounter}-${Date.now()}`;
        const task: HeavyTask = {
            id,
            description: params.description,
            prompt: params.prompt,
            type: params.type ?? 'general',
            status: 'pending',
            enqueuedAt: Date.now(),
            onComplete: params.onComplete,
            onError: params.onError,
        };
        this.queue.push(task);
        this.emit('task_enqueued', task);
        console.log(`  📥 [HeavyTaskQueue] Enqueued: "${task.description}" (${task.type}) → id=${id}`);
        return id;
    }

    /** Get the next pending task (FIFO) */
    dequeue(): HeavyTask | null {
        const task = this.queue.find(t => t.status === 'pending');
        if (task) {
            task.status = 'running';
            task.startedAt = Date.now();
        }
        return task ?? null;
    }

    /** Mark a task as completed */
    complete(id: string, result: string): void {
        const task = this.queue.find(t => t.id === id);
        if (!task) return;
        task.status = 'completed';
        task.result = result;
        task.completedAt = Date.now();
        const durationMs = task.startedAt ? task.completedAt - task.startedAt : 0;
        console.log(`  ✅ [HeavyTaskQueue] Completed: "${task.description}" (${durationMs}ms)`);
        task.onComplete?.(result);
        this.emit('task_completed', task);
    }

    /** Mark a task as failed */
    fail(id: string, error: string): void {
        const task = this.queue.find(t => t.id === id);
        if (!task) return;
        task.status = 'failed';
        task.error = error;
        task.completedAt = Date.now();
        console.log(`  ❌ [HeavyTaskQueue] Failed: "${task.description}" — ${error}`);
        task.onError?.(new Error(error));
        this.emit('task_failed', task);
    }

    /** Check if there are pending tasks */
    hasPending(): boolean {
        return this.queue.some(t => t.status === 'pending');
    }

    /** Check if a task is currently running */
    hasRunning(): boolean {
        return this.queue.some(t => t.status === 'running');
    }

    /** Get queue status summary */
    getStatus(): { pending: number; running: number; completed: number; failed: number; total: number } {
        return {
            pending: this.queue.filter(t => t.status === 'pending').length,
            running: this.queue.filter(t => t.status === 'running').length,
            completed: this.queue.filter(t => t.status === 'completed').length,
            failed: this.queue.filter(t => t.status === 'failed').length,
            total: this.queue.length,
        };
    }

    /** Clear completed/failed tasks (garbage collection) */
    prune(): number {
        const before = this.queue.length;
        this.queue = this.queue.filter(t => t.status === 'pending' || t.status === 'running');
        return before - this.queue.length;
    }

    /** Get all tasks (for debugging/status) */
    getAll(): readonly HeavyTask[] {
        return this.queue;
    }
}

/** Singleton Heavy Task Queue */
export const HeavyTaskQueue = new HeavyTaskQueueImpl();

