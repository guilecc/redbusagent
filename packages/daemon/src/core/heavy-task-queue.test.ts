/**
 * @redbusagent/daemon — HeavyTaskQueue Tests
 *
 * Validates the Dual-Local Architecture's task queue for
 * delegating heavy work to the Worker Engine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// We re-create the queue for isolation — import the class directly
// The singleton would carry state between tests, so we import the module fresh
describe('HeavyTaskQueue', () => {
    let HeavyTaskQueue: typeof import('./heavy-task-queue.js')['HeavyTaskQueue'];

    beforeEach(async () => {
        // Reset module to get a fresh queue instance per test
        vi.resetModules();
        const mod = await import('./heavy-task-queue.js');
        HeavyTaskQueue = mod.HeavyTaskQueue;
    });

    it('enqueues a task and returns an ID', () => {
        const id = HeavyTaskQueue.enqueue({
            description: 'Test task',
            prompt: 'Hello worker',
            type: 'general',
        });
        expect(id).toBeDefined();
        expect(typeof id).toBe('string');
        expect(id).toMatch(/^heavy-/);
    });

    it('hasPending returns true after enqueue', () => {
        expect(HeavyTaskQueue.hasPending()).toBe(false);
        HeavyTaskQueue.enqueue({ description: 'Task', prompt: 'p' });
        expect(HeavyTaskQueue.hasPending()).toBe(true);
    });

    it('dequeue returns the first pending task and marks it running', () => {
        HeavyTaskQueue.enqueue({ description: 'First', prompt: 'p1' });
        HeavyTaskQueue.enqueue({ description: 'Second', prompt: 'p2' });

        const task = HeavyTaskQueue.dequeue();
        expect(task).not.toBeNull();
        expect(task!.description).toBe('First');
        expect(task!.status).toBe('running');
        expect(task!.startedAt).toBeDefined();
    });

    it('dequeue returns null when no pending tasks', () => {
        expect(HeavyTaskQueue.dequeue()).toBeNull();
    });

    it('complete marks task as completed and calls onComplete', () => {
        const onComplete = vi.fn();
        const id = HeavyTaskQueue.enqueue({
            description: 'Completable',
            prompt: 'work',
            onComplete,
        });

        const task = HeavyTaskQueue.dequeue();
        expect(task).not.toBeNull();

        HeavyTaskQueue.complete(id, 'result-text');

        const all = HeavyTaskQueue.getAll();
        const completed = all.find(t => t.id === id);
        expect(completed!.status).toBe('completed');
        expect(completed!.result).toBe('result-text');
        expect(completed!.completedAt).toBeDefined();
        expect(onComplete).toHaveBeenCalledWith('result-text');
    });

    it('fail marks task as failed and calls onError', () => {
        const onError = vi.fn();
        const id = HeavyTaskQueue.enqueue({
            description: 'Failing task',
            prompt: 'broken',
            onError,
        });

        HeavyTaskQueue.dequeue();
        HeavyTaskQueue.fail(id, 'Connection refused');

        const all = HeavyTaskQueue.getAll();
        const failed = all.find(t => t.id === id);
        expect(failed!.status).toBe('failed');
        expect(failed!.error).toBe('Connection refused');
        expect(onError).toHaveBeenCalled();
        expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    });

    it('getStatus returns correct counts', () => {
        HeavyTaskQueue.enqueue({ description: 'A', prompt: 'a' });
        HeavyTaskQueue.enqueue({ description: 'B', prompt: 'b' });
        const id = HeavyTaskQueue.enqueue({ description: 'C', prompt: 'c' });

        HeavyTaskQueue.dequeue(); // A -> running
        HeavyTaskQueue.dequeue(); // B -> running
        // C stays pending

        const status = HeavyTaskQueue.getStatus();
        expect(status.pending).toBe(1);
        expect(status.running).toBe(2);
        expect(status.completed).toBe(0);
        expect(status.failed).toBe(0);
        expect(status.total).toBe(3);
    });

    it('prune removes completed and failed tasks', () => {
        const id1 = HeavyTaskQueue.enqueue({ description: 'Done', prompt: 'd' });
        const id2 = HeavyTaskQueue.enqueue({ description: 'Failed', prompt: 'f' });
        HeavyTaskQueue.enqueue({ description: 'Pending', prompt: 'p' });

        HeavyTaskQueue.dequeue();
        HeavyTaskQueue.complete(id1, 'ok');
        HeavyTaskQueue.dequeue();
        HeavyTaskQueue.fail(id2, 'err');

        const pruned = HeavyTaskQueue.prune();
        expect(pruned).toBe(2);
        expect(HeavyTaskQueue.getAll().length).toBe(1);
        expect(HeavyTaskQueue.getAll()[0]!.description).toBe('Pending');
    });

    it('emits task_enqueued event', () => {
        const listener = vi.fn();
        HeavyTaskQueue.on('task_enqueued', listener);
        HeavyTaskQueue.enqueue({ description: 'Evt', prompt: 'e' });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0].description).toBe('Evt');
    });

    it('emits task_completed event', () => {
        const listener = vi.fn();
        HeavyTaskQueue.on('task_completed', listener);
        const id = HeavyTaskQueue.enqueue({ description: 'C', prompt: 'c' });
        HeavyTaskQueue.dequeue();
        HeavyTaskQueue.complete(id, 'done');
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('defaults task type to general', () => {
        HeavyTaskQueue.enqueue({ description: 'No type', prompt: 'x' });
        const task = HeavyTaskQueue.dequeue();
        expect(task!.type).toBe('general');
    });

    it('supports distill_memory task type', () => {
        HeavyTaskQueue.enqueue({ description: 'Distill', prompt: 'x', type: 'distill_memory' });
        const task = HeavyTaskQueue.dequeue();
        expect(task!.type).toBe('distill_memory');
    });
});

