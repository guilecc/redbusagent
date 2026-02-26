/**
 * HeartbeatManager — Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HeartbeatManager, DEFAULT_HEARTBEAT_INTERVAL_MS } from './heartbeat.js';
import * as taskQueue from '../task-queue.js';
import { approvalGate } from '../approval-gate.js';

// ─── Mock WS Server ────────────────────────────────────────────────
function createMockWsServer() {
    return {
        broadcast: vi.fn(),
        connectionCount: 0,
    } as any;
}

describe('HeartbeatManager', () => {
    let hb: HeartbeatManager;
    let ws: ReturnType<typeof createMockWsServer>;

    beforeEach(() => {
        vi.useFakeTimers();
        ws = createMockWsServer();
        vi.spyOn(taskQueue, 'getActiveTaskCount').mockReturnValue(0);
        vi.spyOn(taskQueue, 'getTotalQueueSize').mockReturnValue(0);
        // Reset approval gate
        approvalGate.removeAllListeners();
    });

    afterEach(() => {
        hb?.stop();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    // ─── State Machine ─────────────────────────────────────────────

    describe('computeState()', () => {
        it('returns IDLE when nothing is active', () => {
            hb = new HeartbeatManager(ws);
            expect(hb.computeState()).toBe('IDLE');
        });

        it('returns THINKING when setThinking(true)', () => {
            hb = new HeartbeatManager(ws);
            hb.setThinking(true);
            expect(hb.computeState()).toBe('THINKING');
            expect(hb.isThinking).toBe(true);
        });

        it('returns EXECUTING_TOOL when tasks are active', () => {
            vi.spyOn(taskQueue, 'getActiveTaskCount').mockReturnValue(2);
            hb = new HeartbeatManager(ws);
            expect(hb.computeState()).toBe('EXECUTING_TOOL');
        });

        it('returns BLOCKED_WAITING_USER when approval is pending', () => {
            hb = new HeartbeatManager(ws);
            vi.spyOn(approvalGate, 'hasPendingRequests').mockReturnValue(true);
            expect(hb.computeState()).toBe('BLOCKED_WAITING_USER');
        });

        it('BLOCKED_WAITING_USER has highest priority over THINKING', () => {
            hb = new HeartbeatManager(ws);
            hb.setThinking(true);
            vi.spyOn(approvalGate, 'hasPendingRequests').mockReturnValue(true);
            expect(hb.computeState()).toBe('BLOCKED_WAITING_USER');
        });

        it('THINKING has priority over EXECUTING_TOOL', () => {
            vi.spyOn(taskQueue, 'getActiveTaskCount').mockReturnValue(1);
            hb = new HeartbeatManager(ws);
            hb.setThinking(true);
            expect(hb.computeState()).toBe('THINKING');
        });
    });

    // ─── Tick Loop ─────────────────────────────────────────────────

    describe('tick loop', () => {
        it('starts and stops correctly', () => {
            hb = new HeartbeatManager(ws);
            expect(hb.isRunning).toBe(false);
            hb.start();
            expect(hb.isRunning).toBe(true);
            hb.stop();
            expect(hb.isRunning).toBe(false);
        });

        it('emits first tick immediately on start', () => {
            hb = new HeartbeatManager(ws);
            hb.start();
            expect(ws.broadcast).toHaveBeenCalledTimes(1);
            const msg = ws.broadcast.mock.calls[0][0];
            expect(msg.type).toBe('heartbeat');
            expect(msg.payload.state).toBe('IDLE');
            expect(msg.payload.tick).toBe(1);
        });

        it('increments tick count on interval', () => {
            hb = new HeartbeatManager(ws, { suppressUnchanged: false });
            hb.start();
            expect(hb.currentTick).toBe(1);
            vi.advanceTimersByTime(DEFAULT_HEARTBEAT_INTERVAL_MS);
            expect(hb.currentTick).toBe(2);
            vi.advanceTimersByTime(DEFAULT_HEARTBEAT_INTERVAL_MS);
            expect(hb.currentTick).toBe(3);
        });

        it('does not start twice', () => {
            hb = new HeartbeatManager(ws, { suppressUnchanged: false });
            hb.start();
            hb.start(); // Should be no-op
            expect(ws.broadcast).toHaveBeenCalledTimes(1); // Only one initial tick
        });

        it('reports correct payload fields', () => {
            ws.connectionCount = 3;
            vi.spyOn(taskQueue, 'getActiveTaskCount').mockReturnValue(1);
            vi.spyOn(taskQueue, 'getTotalQueueSize').mockReturnValue(5);
            hb = new HeartbeatManager(ws, { port: 9876 });
            hb.start();
            const payload = ws.broadcast.mock.calls[0][0].payload;
            expect(payload.port).toBe(9876);
            expect(payload.activeTasks).toBe(1);
            expect(payload.pendingTasks).toBe(5);
            expect(payload.connectedClients).toBe(3);
            expect(payload.state).toBe('EXECUTING_TOOL');
            expect(payload.pid).toBe(process.pid);
            expect(typeof payload.uptimeMs).toBe('number');
        });
    });

    // ─── HEARTBEAT_OK Suppression ──────────────────────────────────

    describe('HEARTBEAT_OK suppression', () => {
        it('suppresses broadcast when state has not changed', () => {
            hb = new HeartbeatManager(ws, { suppressUnchanged: true });
            hb.start(); // tick 1 → broadcasts
            expect(ws.broadcast).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(DEFAULT_HEARTBEAT_INTERVAL_MS); // tick 2 → suppressed
            expect(ws.broadcast).toHaveBeenCalledTimes(1);
        });

        it('broadcasts again when state changes', () => {
            hb = new HeartbeatManager(ws, { suppressUnchanged: true });
            hb.start(); // tick 1 → IDLE broadcast
            expect(ws.broadcast).toHaveBeenCalledTimes(1);

            hb.setThinking(true);
            vi.advanceTimersByTime(DEFAULT_HEARTBEAT_INTERVAL_MS); // tick 2 → THINKING broadcast
            expect(ws.broadcast).toHaveBeenCalledTimes(2);
            expect(ws.broadcast.mock.calls[1][0].payload.state).toBe('THINKING');
        });
    });
});

