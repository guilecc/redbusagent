import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskScheduler } from './scheduler.js';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Vault } from '@redbusagent/shared';

// ─── Mocks ──────────────────────────────────────────────────────────

const mockBroadcast = vi.fn();
const mockHandleChatRequest = vi.fn().mockResolvedValue(undefined);

const mockWsServer = { broadcast: mockBroadcast } as any;
const mockChatHandler = { handleChatRequest: mockHandleChatRequest } as any;

const STORAGE_PATH = join(Vault.dir, 'cron_jobs.json');
const STORAGE_TMP = STORAGE_PATH + '.tmp';

function cleanup() {
    TaskScheduler.stopAll();
    try { unlinkSync(STORAGE_PATH); } catch { /* ignore */ }
    try { unlinkSync(STORAGE_TMP); } catch { /* ignore */ }
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('TaskScheduler', () => {
    beforeEach(() => {
        cleanup();
        vi.clearAllMocks();
        TaskScheduler.init(mockWsServer, mockChatHandler);
    });

    afterEach(() => {
        cleanup();
    });

    // ── Scheduling ──────────────────────────────────────────────────

    it('should schedule a task and return a UUID', () => {
        const id = TaskScheduler.scheduleTask('*/5 * * * *', 'check server health');
        expect(id).toBeDefined();
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
    });

    it('should accept an optional alias', () => {
        const id = TaskScheduler.scheduleTask('0 9 * * *', 'morning report', 'daily-report');
        expect(id).toBeDefined();

        const tasks = TaskScheduler.listScheduledTasks();
        const job = tasks.find(t => t.id === id);
        expect(job).toBeDefined();
        expect(job!.alias).toBe('daily-report');
    });

    it('should auto-generate alias from prompt when not provided', () => {
        const id = TaskScheduler.scheduleTask('0 0 * * *', 'Check disk space usage');
        const tasks = TaskScheduler.listScheduledTasks();
        const job = tasks.find(t => t.id === id);
        expect(job).toBeDefined();
        expect(job!.alias).toBe('check-disk-space-usage');
    });

    it('should throw on invalid cron expression', () => {
        expect(() => TaskScheduler.scheduleTask('invalid', 'test')).toThrow('Invalid cron expression');
    });

    // ── Listing ─────────────────────────────────────────────────────

    it('should list all scheduled tasks', () => {
        TaskScheduler.scheduleTask('*/10 * * * *', 'task 1');
        TaskScheduler.scheduleTask('0 12 * * *', 'task 2');

        const tasks = TaskScheduler.listScheduledTasks();
        expect(tasks).toHaveLength(2);
    });

    it('should return empty array when no tasks', () => {
        const tasks = TaskScheduler.listScheduledTasks();
        expect(tasks).toEqual([]);
    });

    it('should include nextRun in listed tasks', () => {
        TaskScheduler.scheduleTask('0 0 * * *', 'midnight job');
        const tasks = TaskScheduler.listScheduledTasks();
        expect(tasks[0]).toHaveProperty('nextRun');
    });

    // ── Deletion ────────────────────────────────────────────────────

    it('should delete a task by ID', () => {
        const id = TaskScheduler.scheduleTask('*/5 * * * *', 'to delete');
        expect(TaskScheduler.deleteTask(id)).toBe(true);
        expect(TaskScheduler.listScheduledTasks()).toHaveLength(0);
    });

    it('should delete a task by alias', () => {
        TaskScheduler.scheduleTask('*/5 * * * *', 'to delete', 'my-alias');
        expect(TaskScheduler.deleteTask('my-alias')).toBe(true);
        expect(TaskScheduler.listScheduledTasks()).toHaveLength(0);
    });

    it('should return false when deleting non-existent task', () => {
        expect(TaskScheduler.deleteTask('nonexistent-id')).toBe(false);
    });

    // ── Persistence ─────────────────────────────────────────────────

    it('should persist jobs to disk on schedule', () => {
        TaskScheduler.scheduleTask('*/5 * * * *', 'persist me', 'persist-test');

        expect(existsSync(STORAGE_PATH)).toBe(true);
        const raw = readFileSync(STORAGE_PATH, 'utf-8');
        const file = JSON.parse(raw);
        expect(file.version).toBe(1);
        expect(file.jobs).toHaveLength(1);
        expect(file.jobs[0].alias).toBe('persist-test');
    });

    it('should restore jobs from disk on init', () => {
        // Schedule and save
        TaskScheduler.scheduleTask('0 6 * * *', 'wake up call', 'wake-up');
        TaskScheduler.stopAll();

        // Re-init should restore
        TaskScheduler.init(mockWsServer, mockChatHandler);
        const tasks = TaskScheduler.listScheduledTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0]!.alias).toBe('wake-up');
    });

    it('should remove persisted job when deleted', () => {
        const id = TaskScheduler.scheduleTask('*/5 * * * *', 'temp job');
        TaskScheduler.deleteTask(id);

        const raw = readFileSync(STORAGE_PATH, 'utf-8');
        const file = JSON.parse(raw);
        expect(file.jobs).toHaveLength(0);
    });

    // ── stopAll ─────────────────────────────────────────────────────

    it('should stop all timers and clear state', () => {
        TaskScheduler.scheduleTask('*/1 * * * *', 'job 1');
        TaskScheduler.scheduleTask('*/2 * * * *', 'job 2');
        expect(TaskScheduler.activeCount).toBe(2);

        TaskScheduler.stopAll();
        expect(TaskScheduler.activeCount).toBe(0);
    });
});

