import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
    ApprovalGateManager,
    clearAllToolExecutionContexts,
    getRestrictedWorkerShellAutoApproval,
    type ToolExecutionContext,
} from './approval-gate.js';
import { engineBus } from './engine-message-bus.js';

let gate: ApprovalGateManager;

beforeEach(() => {
    vi.useFakeTimers();
    engineBus.reset();
    gate = new ApprovalGateManager();
});

afterEach(() => {
    clearAllToolExecutionContexts();
    engineBus.reset();
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

describe('orchestration lifecycle', () => {
    it('resumes the original approval session when the decision arrives after another session becomes active', async () => {
        engineBus.startTask('approval-task', 'Wait for command approval');

        const promise = gate.requestApproval({ id: 'approval-ctx', ...PAYLOAD });

        expect(engineBus.getSession('approval-task')).toMatchObject({
            state: 'paused',
            pauseKind: 'awaiting_approval',
            pauseReason: `${PAYLOAD.toolName}: ${PAYLOAD.description}`,
            activeActor: 'worker',
        });

        vi.advanceTimersByTime(1);
        engineBus.startTask('approval-other-task', 'Handle a separate workflow');
        expect(engineBus.getLatestActiveSession()?.taskId).toBe('approval-other-task');

        expect(gate.resolveApproval('approval-ctx', true)).toBe(true);
        await expect(promise).resolves.toBe(true);

        const resumedSession = engineBus.getSession('approval-task');
        expect(resumedSession).toMatchObject({
            state: 'running',
            activeActor: 'worker',
            pauseKind: undefined,
            pauseReason: `Approval decision received for ${PAYLOAD.toolName}.`,
        });
        expect(resumedSession?.history.map(event => event.type)).toEqual([
            'task_created',
            'yield_requested',
            'user_reply_received',
            'resumed',
        ]);
        expect(resumedSession?.history[2]).toMatchObject({
            type: 'user_reply_received',
            sessionId: 'approval-task',
            taskId: 'approval-task',
            mode: 'collaborative',
            actor: 'user',
            replyPreview: 'Approval granted once',
        });
        expect(engineBus.getSession('approval-other-task')?.lastEventType).toBe('task_created');
    });
});

describe('restricted shell auto-approval policy', () => {
    const collaborativeWorkerContext: ToolExecutionContext = {
        toolCallId: 'tool-1',
        toolName: 'execute_shell_command',
        args: {},
        actor: 'worker',
        mode: 'collaborative',
        sessionId: 'worker-safe-task',
        taskId: 'worker-safe-task',
    };

    it('auto-approves simple worker vault runtime commands tied to the active collaborative execution context', () => {
        expect(getRestrictedWorkerShellAutoApproval(
            'node -e "Vault.storeCredential(\"outlook.com\", \"user\", \"secret\")"',
            collaborativeWorkerContext,
        )).toEqual({
            approved: true,
            rationale: 'worker collaborative vault runtime command',
        });
    });

    it('auto-approves simple forge runtime commands tied to the active collaborative execution context', () => {
        expect(getRestrictedWorkerShellAutoApproval(
            'npm install --prefix "$REDBUSAGENT_FORGE_DIR" playwright',
            collaborativeWorkerContext,
        )).toEqual({
            approved: true,
            rationale: 'worker collaborative forge runtime command',
        });
    });

    it('preserves HITL for chained shell commands, arbitrary commands, or non-worker contexts', () => {
        expect(getRestrictedWorkerShellAutoApproval(
            'cd "$REDBUSAGENT_FORGE_DIR" && npm install playwright',
            collaborativeWorkerContext,
        )).toEqual({ approved: false });

        expect(getRestrictedWorkerShellAutoApproval(
            'rm -rf "$REDBUSAGENT_FORGE_DIR"',
            collaborativeWorkerContext,
        )).toEqual({ approved: false });

        expect(getRestrictedWorkerShellAutoApproval(
            'node -e "Vault.storeBrowserSession(\"outlook.com\", { ok: true })"',
            { ...collaborativeWorkerContext, actor: 'live' },
        )).toEqual({ approved: false });

        expect(getRestrictedWorkerShellAutoApproval(
            'node -e "Vault.storeCredential(\"outlook.com\", \"user\", \"secret\")"',
            { ...collaborativeWorkerContext, sessionId: undefined },
        )).toEqual({ approved: false });
    });
});

