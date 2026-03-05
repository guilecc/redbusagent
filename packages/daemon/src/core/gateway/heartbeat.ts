/**
 * @redbusagent/daemon — Gateway Heartbeat Manager
 *
 * A deterministic, fixed-interval tick loop that orchestrates global daemon
 * state without polling the LLM. Inspired by openclaw's heartbeat architecture.
 *
 * Responsibilities:
 *  1. Global state machine (IDLE → THINKING → EXECUTING_TOOL → BLOCKED_WAITING_USER)
 *  2. Periodic status broadcasts to TUI clients via WebSocket
 *  3. Aggregates TaskQueue + ApprovalGate state as Source of Truth
 *  4. HEARTBEAT_OK suppression — skips broadcast when nothing changed
 */

import type { DaemonWsServer } from '../../infra/ws-server.js';
import type { DaemonState } from '@redbusagent/shared';
import { getActiveTaskCount, getTotalQueueSize } from '../task-queue.js';
import { approvalGate } from '../approval-gate.js';
import { HeavyTaskQueue } from '../heavy-task-queue.js';
import { askWorkerEngine } from '../cognitive-router.js';
import { getWorkerEngineConfig } from '../../infra/llm-config.js';
import { engineBus } from '../engine-message-bus.js';

// ─── Configuration ─────────────────────────────────────────────────
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 1_000;

export interface HeartbeatManagerOptions {
    /** Tick interval in ms (default: 1000) */
    intervalMs?: number;
    /** Daemon WS port for payload */
    port?: number;
    /** Suppress broadcasts when state hasn't changed */
    suppressUnchanged?: boolean;
}

// ─── State snapshot for comparison ─────────────────────────────────
interface StateSnapshot {
    state: DaemonState;
    activeTasks: number;
    pendingTasks: number;
    awaitingApproval: boolean;
    connectedClients: number;
    workerPending: number;
    workerRunning: number;
    workerCompleted: number;
}

function snapshotsEqual(a: StateSnapshot | null, b: StateSnapshot): boolean {
    if (!a) return false;
    return (
        a.state === b.state &&
        a.activeTasks === b.activeTasks &&
        a.pendingTasks === b.pendingTasks &&
        a.awaitingApproval === b.awaitingApproval &&
        a.connectedClients === b.connectedClients &&
        a.workerPending === b.workerPending &&
        a.workerRunning === b.workerRunning &&
        a.workerCompleted === b.workerCompleted
    );
}

// ─── HeartbeatManager ──────────────────────────────────────────────
export class HeartbeatManager {
    private timer: ReturnType<typeof setInterval> | null = null;
    private workerTimer: ReturnType<typeof setInterval> | null = null;
    private tickCount = 0;
    private startedAt = 0;
    private lastSnapshot: StateSnapshot | null = null;
    private _workerProcessing = false;

    // External state signals (set by ChatHandler or other subsystems)
    private _thinking = false;

    private readonly intervalMs: number;
    private readonly port: number;
    private readonly suppressUnchanged: boolean;

    constructor(
        private readonly wsServer: DaemonWsServer,
        options: HeartbeatManagerOptions = {},
    ) {
        this.intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
        this.port = options.port ?? 0;
        this.suppressUnchanged = options.suppressUnchanged ?? true;
    }

    // ─── External state signals ────────────────────────────────────
    /** Called by ChatHandler when an LLM request starts */
    setThinking(active: boolean): void {
        this._thinking = active;
    }

    get isThinking(): boolean {
        return this._thinking;
    }

    // ─── State Machine ─────────────────────────────────────────────
    /**
     * Computes global state by polling subsystems.
     * Priority order (highest to lowest):
     *  1. BLOCKED_WAITING_USER — approval gate has pending requests
     *  2. THINKING — LLM is generating
     *  3. EXECUTING_TOOL — tasks are actively running in lanes
     *  4. IDLE — nothing happening
     */
    computeState(): DaemonState {
        if (approvalGate.hasPendingRequests()) return 'BLOCKED_WAITING_USER';
        if (this._thinking) return 'THINKING';
        if (getActiveTaskCount() > 0) return 'EXECUTING_TOOL';
        return 'IDLE';
    }

    // ─── Tick Loop ─────────────────────────────────────────────────
    start(): void {
        if (this.timer) return; // Already running
        this.startedAt = Date.now();
        this.tickCount = 0;
        this.lastSnapshot = null;
        this.timer = setInterval(() => this.tick(), this.intervalMs);
        // Emit first tick immediately
        this.tick();

        // ─── Worker Engine Loop (independent, every 3s) ────────────
        const workerConfig = getWorkerEngineConfig();
        if (workerConfig.enabled) {
            console.log(`  🏗️ [heartbeat] Worker Engine loop started (model: ${workerConfig.model}, threads: ${workerConfig.num_threads})`);
            this.workerTimer = setInterval(() => this.workerTick(), 3_000);
        }
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.workerTimer) {
            clearInterval(this.workerTimer);
            this.workerTimer = null;
        }
    }

    get isRunning(): boolean {
        return this.timer !== null;
    }

    get uptimeMs(): number {
        return this.startedAt > 0 ? Date.now() - this.startedAt : 0;
    }

    get currentTick(): number {
        return this.tickCount;
    }

    /** Single heartbeat tick — aggregate state → optionally broadcast */
    private tick(): void {
        this.tickCount++;

        const workerConfig = getWorkerEngineConfig();
        const workerQueueStatus = HeavyTaskQueue.getStatus();
        // Also check if the Worker Engine is active via delegate_to_worker_engine (engineBus)
        const engineBusActive = engineBus.isWorkerActive() ? 1 : 0;

        const snapshot: StateSnapshot = {
            state: this.computeState(),
            activeTasks: getActiveTaskCount(),
            pendingTasks: getTotalQueueSize(),
            awaitingApproval: approvalGate.hasPendingRequests(),
            connectedClients: this.wsServer.connectionCount,
            workerPending: workerQueueStatus.pending,
            workerRunning: Math.max(workerQueueStatus.running, engineBusActive),
            workerCompleted: workerQueueStatus.completed,
        };

        // HEARTBEAT_OK suppression: skip if nothing changed
        if (this.suppressUnchanged && snapshotsEqual(this.lastSnapshot, snapshot)) {
            return;
        }

        this.lastSnapshot = snapshot;

        this.wsServer.broadcast({
            type: 'heartbeat',
            timestamp: new Date().toISOString(),
            payload: {
                uptimeMs: this.uptimeMs,
                pid: process.pid,
                port: this.port,
                state: snapshot.state,
                activeTasks: snapshot.activeTasks,
                pendingTasks: snapshot.pendingTasks,
                awaitingApproval: snapshot.awaitingApproval,
                connectedClients: snapshot.connectedClients,
                tick: this.tickCount,
                workerStatus: workerConfig.enabled ? {
                    enabled: true,
                    model: workerConfig.model,
                    pending: workerQueueStatus.pending,
                    running: workerQueueStatus.running,
                    completed: workerQueueStatus.completed,
                    failed: workerQueueStatus.failed,
                } : undefined,
            },
        });
    }

    // ─── Worker Engine Tick (independent loop, every 3s) ─────────────
    /**
     * Pulls the next pending task from the HeavyTaskQueue and executes
     * it on the Worker Engine (CPU/RAM-bound). Only one task runs at a
     * time to avoid overwhelming system RAM.
     */
    private async workerTick(): Promise<void> {
        // Guard: skip if already processing or no pending tasks
        if (this._workerProcessing) return;
        if (!HeavyTaskQueue.hasPending()) return;

        const task = HeavyTaskQueue.dequeue();
        if (!task) return;

        this._workerProcessing = true;
        try {
            const { result } = await askWorkerEngine(task.prompt);
            HeavyTaskQueue.complete(task.id, result);

            // Broadcast worker completion to connected TUI clients
            this.wsServer.broadcast({
                type: 'worker_task_completed',
                timestamp: new Date().toISOString(),
                payload: {
                    taskId: task.id,
                    description: task.description,
                    taskType: task.type,
                    resultLength: result.length,
                },
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            HeavyTaskQueue.fail(task.id, msg);

            this.wsServer.broadcast({
                type: 'worker_task_failed',
                timestamp: new Date().toISOString(),
                payload: {
                    taskId: task.id,
                    description: task.description,
                    error: msg,
                },
            });
        } finally {
            this._workerProcessing = false;
        }
    }
}

