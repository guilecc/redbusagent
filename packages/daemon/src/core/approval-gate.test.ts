import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ApprovalGateManager, DEFAULT_APPROVAL_TIMEOUT_MS } from './approval-gate.js';

let gate: ApprovalGateManager;

beforeEach(() => {
    vi.useFakeTimers();
    gate = new ApprovalGateManager();
});

afterEach(() => {
    vi.useRealTimers();
});

const PAYLOAD = {
    toolName: 'execute_shell_command',
    description: 'rm -rf /',
    reason: 'destructive' as const,
    args: { command: 'rm -rf /' },
};

// ─── create ──────────────────────────────────────────────────────

describe('create', () => {
    it('returns a record with timestamps and provided id', () => {
        const record = gate.create(PAYLOAD, 5000, 'abc');
        expect(record.id).toBe('abc');
        expect(record.expiresAtMs - record.createdAtMs).toBe(5000);
        expect(record.request).toEqual(PAYLOAD);
    });

    it('generates a UUID when id is null', () => {
        const record = gate.create(PAYLOAD, 5000, null);
        expect(record.id).toBeTruthy();
        expect(record.id.length).toBeGreaterThan(5);
    });

    it('generates a UUID when id is empty string', () => {
        const record = gate.create(PAYLOAD, 5000, '  ');
        expect(record.id.trim().length).toBeGreaterThan(0);
        expect(record.id).not.toBe('  ');
    });
});

// ─── register + resolve ──────────────────────────────────────────

describe('register & resolve', () => {
    it('resolves with decision when resolve() is called', async () => {
        const record = gate.create(PAYLOAD, 5000, 'r1');
        const promise = gate.register(record, 5000);
        gate.resolve('r1', 'allow-once');
        await expect(promise).resolves.toBe('allow-once');
    });

    it('idempotent: same id returns same promise', () => {
        const record = gate.create(PAYLOAD, 5000, 'idem');
        const p1 = gate.register(record, 5000);
        const p2 = gate.register(record, 5000);
        expect(p1).toBe(p2);
    });

    it('throws when re-registering an already resolved id', async () => {
        const record = gate.create(PAYLOAD, 5000, 'done');
        gate.register(record, 5000);
        gate.resolve('done', 'deny');
        const record2 = gate.create(PAYLOAD, 5000, 'done');
        expect(() => gate.register(record2, 5000)).toThrow('already resolved');
    });

    it('resolve returns false for unknown id', () => {
        expect(gate.resolve('nope', 'deny')).toBe(false);
    });

    it('resolve returns false for already-resolved id', () => {
        const record = gate.create(PAYLOAD, 5000, 'dup');
        gate.register(record, 5000);
        expect(gate.resolve('dup', 'deny')).toBe(true);
        expect(gate.resolve('dup', 'allow-once')).toBe(false);
    });
});

// ─── expiration ──────────────────────────────────────────────────

describe('expiration', () => {
    it('auto-expires after timeout, resolving with null', async () => {
        const record = gate.create(PAYLOAD, 100, 'exp');
        const promise = gate.register(record, 100);
        vi.advanceTimersByTime(101);
        await expect(promise).resolves.toBeNull();
    });

    it('manual expire returns true for pending', () => {
        const record = gate.create(PAYLOAD, 5000, 'mexp');
        gate.register(record, 5000);
        expect(gate.expire('mexp', 'system')).toBe(true);
    });

    it('manual expire returns false for already resolved', () => {
        const record = gate.create(PAYLOAD, 5000, 'mexp2');
        gate.register(record, 5000);
        gate.resolve('mexp2', 'deny');
        expect(gate.expire('mexp2')).toBe(false);
    });
});

// ─── consumeAllowOnce (anti-replay) ─────────────────────────────

describe('consumeAllowOnce', () => {
    it('consumes allow-once atomically', () => {
        const record = gate.create(PAYLOAD, 5000, 'c1');
        gate.register(record, 5000);
        gate.resolve('c1', 'allow-once');
        expect(gate.consumeAllowOnce('c1')).toBe(true);
        // Second call fails — already consumed
        expect(gate.consumeAllowOnce('c1')).toBe(false);
    });

    it('returns false for deny decisions', () => {
        const record = gate.create(PAYLOAD, 5000, 'c2');
        gate.register(record, 5000);
        gate.resolve('c2', 'deny');
        expect(gate.consumeAllowOnce('c2')).toBe(false);
    });

    it('returns false for unknown id', () => {
        expect(gate.consumeAllowOnce('nope')).toBe(false);
    });
});

// ─── grace period ────────────────────────────────────────────────

describe('grace period', () => {
    it('keeps resolved entry accessible for 15s', () => {
        const record = gate.create(PAYLOAD, 5000, 'g1');
        gate.register(record, 5000);
        gate.resolve('g1', 'allow-once');
        // Still accessible during grace
        expect(gate.getSnapshot('g1')).toBeTruthy();
        expect(gate.awaitDecision('g1')).toBeTruthy();
    });
});

