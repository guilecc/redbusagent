/**
 * @redbusagent/daemon — Engine-to-Engine Message Bus
 *
 * A typed EventEmitter that enables real-time communication between
 * the Live Engine (observer/coordinator) and Worker Engine (executor).
 *
 * Event Flow:
 *   Worker starts → worker:start
 *   Worker calls tool → worker:tool_call
 *   Worker tool completes → worker:tool_result
 *   Worker streams text → worker:progress (batched)
 *   Worker finishes → worker:done
 *   Worker errors → worker:error
 *
 * The Live Engine subscribes to these events and translates them
 * into user-friendly status updates via the TUI/WhatsApp.
 */

import { EventEmitter } from 'node:events';

// ─── Event Types ──────────────────────────────────────────────────

export interface WorkerStartEvent {
    taskId: string;
    prompt: string;
    timestamp: number;
}

export interface WorkerToolCallEvent {
    taskId: string;
    toolName: string;
    args: Record<string, unknown>;
    timestamp: number;
}

export interface WorkerToolResultEvent {
    taskId: string;
    toolName: string;
    success: boolean;
    durationMs: number;
    timestamp: number;
}

export interface WorkerProgressEvent {
    taskId: string;
    charsGenerated: number;
    toolCallCount: number;
    elapsed: number;
    timestamp: number;
}

export interface WorkerDoneEvent {
    taskId: string;
    totalChars: number;
    totalToolCalls: number;
    totalDurationMs: number;
    timestamp: number;
}

export interface WorkerErrorEvent {
    taskId: string;
    error: string;
    timestamp: number;
}

// ─── Bus Event Map ────────────────────────────────────────────────

export interface EngineEventMap {
    'worker:start': WorkerStartEvent;
    'worker:tool_call': WorkerToolCallEvent;
    'worker:tool_result': WorkerToolResultEvent;
    'worker:progress': WorkerProgressEvent;
    'worker:done': WorkerDoneEvent;
    'worker:error': WorkerErrorEvent;
}

type EventKey = keyof EngineEventMap;

// ─── The Bus ──────────────────────────────────────────────────────

class EngineMessageBus extends EventEmitter {
    private activeTaskId: string | null = null;

    /** Mark a task as actively being processed by the Worker */
    startTask(taskId: string, prompt: string): void {
        this.activeTaskId = taskId;
        this.emit('worker:start', {
            taskId,
            prompt: prompt.slice(0, 200),
            timestamp: Date.now(),
        } satisfies WorkerStartEvent);
    }

    /** Emit a typed event on the bus */
    emitEvent<K extends EventKey>(event: K, data: EngineEventMap[K]): void {
        this.emit(event, data);
    }

    /** Subscribe to a typed event */
    onEvent<K extends EventKey>(event: K, handler: (data: EngineEventMap[K]) => void): void {
        this.on(event, handler);
    }

    /** Get the currently active Worker task ID */
    getActiveTaskId(): string | null {
        return this.activeTaskId;
    }

    /** Clear the active task */
    clearTask(): void {
        this.activeTaskId = null;
    }

    /** Check if the Worker is currently processing */
    isWorkerActive(): boolean {
        return this.activeTaskId !== null;
    }
}

export const engineBus = new EngineMessageBus();

