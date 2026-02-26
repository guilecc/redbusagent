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
}

function snapshotsEqual(a: StateSnapshot | null, b: StateSnapshot): boolean {
    if (!a) return false;
    return (
        a.state === b.state &&
        a.activeTasks === b.activeTasks &&
        a.pendingTasks === b.pendingTasks &&
        a.awaitingApproval === b.awaitingApproval &&
        a.connectedClients === b.connectedClients
    );
}

// ─── HeartbeatManager ──────────────────────────────────────────────
export class HeartbeatManager {
    private timer: ReturnType<typeof setInterval> | null = null;
    private tickCount = 0;
    private startedAt = 0;
    private lastSnapshot: StateSnapshot | null = null;

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
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
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

        const snapshot: StateSnapshot = {
            state: this.computeState(),
            activeTasks: getActiveTaskCount(),
            pendingTasks: getTotalQueueSize(),
            awaitingApproval: approvalGate.hasPendingRequests(),
            connectedClients: this.wsServer.connectionCount,
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
            },
        });
    }
}

