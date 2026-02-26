/**
 * @redbusagent/daemon — Advanced Approval Gate (HITL)
 *
 * Ported from openclaw's ExecApprovalManager pattern.
 * Features:
 *  • ExecApprovalRecord with metadata & timestamps
 *  • Auto-expiration with configurable timeout
 *  • 15s grace period for late awaitDecision calls
 *  • consumeAllowOnce — atomic one-time anti-replay
 *  • Idempotent registration (same ID returns existing promise)
 *  • Separated create → register → await lifecycle
 *  • Tool flags registry for destructive/intrusive classification
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

// ─── Constants ───────────────────────────────────────────────────────

/** Grace period to keep resolved entries for late awaitDecision calls. */
const RESOLVED_ENTRY_GRACE_MS = 15_000;

/** Default timeout for approval requests. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

// ─── Types ──────────────────────────────────────────────────────────

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny';

export interface ApprovalRequestPayload {
    toolName: string;
    description: string;
    reason: 'destructive' | 'intrusive';
    args: Record<string, unknown>;
}

export interface ExecApprovalRecord {
    id: string;
    request: ApprovalRequestPayload;
    createdAtMs: number;
    expiresAtMs: number;
    /** Caller metadata — used to prevent cross-client replay attacks. */
    requestedByConnId?: string | null;
    requestedByClientId?: string | null;
    resolvedAtMs?: number;
    decision?: ApprovalDecision;
    resolvedBy?: string | null;
}

/** Backward-compatible alias for existing callsites. */
export interface ApprovalRequest extends ApprovalRequestPayload {
    id: string;
}

// ─── Internal Entry ──────────────────────────────────────────────────

interface PendingEntry {
    record: ExecApprovalRecord;
    resolve: (decision: ApprovalDecision | null) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    promise: Promise<ApprovalDecision | null>;
}

// ─── Tool Flags Registry ────────────────────────────────────────────

export interface ToolFlags {
    destructive?: boolean;
    intrusive?: boolean;
}

const TOOL_FLAGS: Record<string, ToolFlags> = {
    execute_shell_command: { destructive: true },
    edit_file_blocks: { destructive: true },
    git_commit_changes: { destructive: true },
    send_whatsapp_message: { intrusive: true },
    create_and_run_tool: { destructive: true },
};

// ─── Approval Gate Manager ──────────────────────────────────────────

export class ApprovalGateManager extends EventEmitter {
    private pending = new Map<string, PendingEntry>();

    // ── Tool Flags ────────────────────────────────────────────────

    registerToolFlags(toolName: string, flags: ToolFlags): void {
        TOOL_FLAGS[toolName] = flags;
    }

    requiresApproval(toolName: string): 'destructive' | 'intrusive' | null {
        const flags = TOOL_FLAGS[toolName];
        if (!flags) return null;
        if (flags.destructive) return 'destructive';
        if (flags.intrusive) return 'intrusive';
        return null;
    }

    getToolFlags(): Record<string, ToolFlags> {
        return { ...TOOL_FLAGS };
    }

    // ── Lifecycle: create → register → await ─────────────────────

    /** Create a record (pure, no side effects). */
    create(
        request: ApprovalRequestPayload,
        timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS,
        id?: string | null,
    ): ExecApprovalRecord {
        const now = Date.now();
        const resolvedId = id && id.trim().length > 0 ? id.trim() : randomUUID();
        return {
            id: resolvedId,
            request,
            createdAtMs: now,
            expiresAtMs: now + timeoutMs,
        };
    }

    /**
     * Register a record and return a promise that resolves on decision.
     * Idempotent: same ID returns existing promise if still pending.
     */
    register(
        record: ExecApprovalRecord,
        timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS,
    ): Promise<ApprovalDecision | null> {
        const existing = this.pending.get(record.id);
        if (existing) {
            if (existing.record.resolvedAtMs === undefined) return existing.promise;
            throw new Error(`approval id '${record.id}' already resolved`);
        }

        let resolvePromise!: (decision: ApprovalDecision | null) => void;
        let rejectPromise!: (err: Error) => void;
        const promise = new Promise<ApprovalDecision | null>((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        });

        const entry: PendingEntry = {
            record,
            resolve: resolvePromise,
            reject: rejectPromise,
            timer: null as unknown as ReturnType<typeof setTimeout>,
            promise,
        };
        entry.timer = setTimeout(() => this.expire(record.id), timeoutMs);
        this.pending.set(record.id, entry);
        return promise;
    }

    // ── Backward-compatible requestApproval ───────────────────────

    /**
     * One-shot request+wait (preserves old API used by shell-executor).
     * Emits 'approval_requested' for ChatHandler to relay to TUI.
     */
    requestApproval(request: ApprovalRequest): Promise<boolean> {
        const record = this.create(request, DEFAULT_APPROVAL_TIMEOUT_MS, request.id);
        const promise = this.register(record, DEFAULT_APPROVAL_TIMEOUT_MS);
        this.emit('approval_requested', request);
        return promise.then((d) => d === 'allow-once' || d === 'allow-always');
    }

    // ── Resolution ────────────────────────────────────────────────

    resolve(
        recordId: string,
        decision: ApprovalDecision,
        resolvedBy?: string | null,
    ): boolean {
        const entry = this.pending.get(recordId);
        if (!entry || entry.record.resolvedAtMs !== undefined) return false;
        clearTimeout(entry.timer);
        entry.record.resolvedAtMs = Date.now();
        entry.record.decision = decision;
        entry.record.resolvedBy = resolvedBy ?? null;
        entry.resolve(decision);
        // Grace window: keep entry for late awaitDecision callers
        setTimeout(() => {
            if (this.pending.get(recordId) === entry) this.pending.delete(recordId);
        }, RESOLVED_ENTRY_GRACE_MS);
        return true;
    }

    /** Backward-compatible resolve taking a boolean. */
    resolveApproval(id: string, approved: boolean): boolean {
        return this.resolve(id, approved ? 'allow-once' : 'deny');
    }

    expire(recordId: string, resolvedBy?: string | null): boolean {
        const entry = this.pending.get(recordId);
        if (!entry || entry.record.resolvedAtMs !== undefined) return false;
        clearTimeout(entry.timer);
        entry.record.resolvedAtMs = Date.now();
        entry.record.decision = undefined;
        entry.record.resolvedBy = resolvedBy ?? null;
        entry.resolve(null);
        setTimeout(() => {
            if (this.pending.get(recordId) === entry) this.pending.delete(recordId);
        }, RESOLVED_ENTRY_GRACE_MS);
        return true;
    }

    // ── Anti-Replay ───────────────────────────────────────────────

    /**
     * Atomically consume an allow-once decision, preventing replay.
     * Returns true if consumed; false if not found or not allow-once.
     */
    consumeAllowOnce(recordId: string): boolean {
        const entry = this.pending.get(recordId);
        if (!entry) return false;
        if (entry.record.decision !== 'allow-once') return false;
        entry.record.decision = undefined;
        return true;
    }

    // ── Queries ───────────────────────────────────────────────────

    getSnapshot(recordId: string): ExecApprovalRecord | null {
        return this.pending.get(recordId)?.record ?? null;
    }

    awaitDecision(recordId: string): Promise<ApprovalDecision | null> | null {
        return this.pending.get(recordId)?.promise ?? null;
    }

    hasPendingRequests(): boolean {
        for (const entry of this.pending.values()) {
            if (entry.record.resolvedAtMs === undefined) return true;
        }
        return false;
    }

    getFirstPending(): ApprovalRequest | undefined {
        for (const entry of this.pending.values()) {
            if (entry.record.resolvedAtMs === undefined) {
                return { id: entry.record.id, ...entry.record.request };
            }
        }
        return undefined;
    }

    getFirstPendingId(): string | undefined {
        for (const entry of this.pending.values()) {
            if (entry.record.resolvedAtMs === undefined) return entry.record.id;
        }
        return undefined;
    }
}

export const approvalGate = new ApprovalGateManager();

