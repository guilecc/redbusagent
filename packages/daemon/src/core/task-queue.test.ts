import { describe, it, expect, beforeEach } from 'vitest';
import {
    enqueueCommandInLane,
    enqueueCommand,
    getQueueSize,
    getTotalQueueSize,
    clearCommandLane,
    resetAllLanes,
    getActiveTaskCount,
    waitForActiveTasks,
    markGatewayDraining,
    setCommandLaneConcurrency,
    CommandLane,
    CommandLaneClearedError,
    GatewayDrainingError,
} from './task-queue.js';

beforeEach(() => {
    resetAllLanes();
});

// ─── Lane Serialization ──────────────────────────────────────────

describe('enqueueCommandInLane', () => {
    it('executes tasks sequentially within a lane', async () => {
        const order: number[] = [];
        const p1 = enqueueCommandInLane('a', async () => {
            await delay(20);
            order.push(1);
            return 1;
        });
        const p2 = enqueueCommandInLane('a', async () => {
            order.push(2);
            return 2;
        });
        await Promise.all([p1, p2]);
        expect(order).toEqual([1, 2]);
    });

    it('allows cross-lane parallelism', async () => {
        const starts: string[] = [];
        const p1 = enqueueCommandInLane('x', async () => {
            starts.push('x');
            await delay(30);
        });
        const p2 = enqueueCommandInLane('y', async () => {
            starts.push('y');
            await delay(30);
        });
        await delay(10);
        // Both should have started before either finishes
        expect(starts).toContain('x');
        expect(starts).toContain('y');
        await Promise.all([p1, p2]);
    });

    it('returns the task result', async () => {
        const result = await enqueueCommandInLane('a', async () => 42);
        expect(result).toBe(42);
    });

    it('propagates task errors', async () => {
        await expect(
            enqueueCommandInLane('a', async () => { throw new Error('boom'); }),
        ).rejects.toThrow('boom');
    });
});

// ─── enqueueCommand (main lane shortcut) ─────────────────────────

describe('enqueueCommand', () => {
    it('routes to main lane', async () => {
        const p = enqueueCommand(async () => { await delay(20); });
        expect(getQueueSize(CommandLane.Main)).toBeGreaterThanOrEqual(1);
        await p;
    });
});

// ─── Queue Size ──────────────────────────────────────────────────

describe('getQueueSize / getTotalQueueSize', () => {
    it('returns 0 for empty lane', () => {
        expect(getQueueSize('empty')).toBe(0);
    });

    it('counts active + queued across lanes', async () => {
        const p1 = enqueueCommandInLane('a', () => delay(50));
        const p2 = enqueueCommandInLane('b', () => delay(50));
        await delay(5);
        expect(getTotalQueueSize()).toBe(2);
        await Promise.all([p1, p2]);
    });
});

// ─── clearCommandLane ────────────────────────────────────────────

describe('clearCommandLane', () => {
    it('rejects queued tasks with CommandLaneClearedError', async () => {
        // Block the lane with a long task so the second is queued
        const blocker = enqueueCommandInLane('c', () => delay(100));
        const queued = enqueueCommandInLane('c', async () => 'should not run');
        const removed = clearCommandLane('c');
        expect(removed).toBe(1);
        await expect(queued).rejects.toThrow(CommandLaneClearedError);
        await blocker;
    });

    it('returns 0 for an empty lane', () => {
        expect(clearCommandLane('nonexistent')).toBe(0);
    });
});

// ─── Gateway Draining ────────────────────────────────────────────

describe('markGatewayDraining', () => {
    it('rejects new enqueues with GatewayDrainingError', async () => {
        markGatewayDraining();
        await expect(
            enqueueCommandInLane('a', async () => {}),
        ).rejects.toThrow(GatewayDrainingError);
        // Reset for subsequent tests
        resetAllLanes();
    });
});

// ─── resetAllLanes ───────────────────────────────────────────────

describe('resetAllLanes', () => {
    it('clears draining flag and bumps generation', async () => {
        markGatewayDraining();
        resetAllLanes();
        // Should accept tasks again
        const result = await enqueueCommandInLane('a', async () => 'ok');
        expect(result).toBe('ok');
    });
});

// ─── setCommandLaneConcurrency ───────────────────────────────────

describe('setCommandLaneConcurrency', () => {
    it('allows parallel execution up to maxConcurrent', async () => {
        setCommandLaneConcurrency('par', 2);
        const running: number[] = [];
        let maxParallel = 0;
        const task = async (id: number) => {
            running.push(id);
            maxParallel = Math.max(maxParallel, running.length);
            await delay(30);
            running.splice(running.indexOf(id), 1);
        };
        await Promise.all([
            enqueueCommandInLane('par', () => task(1)),
            enqueueCommandInLane('par', () => task(2)),
            enqueueCommandInLane('par', () => task(3)),
        ]);
        expect(maxParallel).toBe(2);
    });
});

// ─── waitForActiveTasks ──────────────────────────────────────────

describe('waitForActiveTasks', () => {
    it('resolves drained:true when no active tasks', async () => {
        const result = await waitForActiveTasks(100);
        expect(result).toEqual({ drained: true });
    });

    it('waits for active tasks to complete', async () => {
        const p = enqueueCommandInLane('w', () => delay(50));
        const result = await waitForActiveTasks(500);
        expect(result).toEqual({ drained: true });
        await p;
    });

    it('returns drained:false on timeout', async () => {
        const p = enqueueCommandInLane('w2', () => delay(500));
        const result = await waitForActiveTasks(20);
        expect(result).toEqual({ drained: false });
        // Let it finish to avoid dangling
        await p;
    });
});

// ─── getActiveTaskCount ──────────────────────────────────────────

describe('getActiveTaskCount', () => {
    it('counts only active (not queued) tasks', async () => {
        expect(getActiveTaskCount()).toBe(0);
        const p = enqueueCommandInLane('act', () => delay(50));
        await delay(5);
        expect(getActiveTaskCount()).toBeGreaterThanOrEqual(1);
        await p;
        expect(getActiveTaskCount()).toBe(0);
    });
});

// ─── Helpers ─────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
