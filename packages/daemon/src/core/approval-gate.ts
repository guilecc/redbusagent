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
import { engineBus, type OrchestrationActor, type OrchestrationExecutionMode } from './engine-message-bus.js';

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

export interface ApprovalOrchestrationContext {
    sessionId: string;
    taskId: string;
    mode: OrchestrationExecutionMode;
    actor: OrchestrationActor;
}

export interface ToolExecutionContext {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    mode: OrchestrationExecutionMode;
    actor: OrchestrationActor;
    sessionId?: string;
    taskId?: string;
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
    orchestrationContext?: ApprovalOrchestrationContext | null;
    toolCallId?: string;
}

// ─── Internal Entry ──────────────────────────────────────────────────

interface PendingEntry {
    record: ExecApprovalRecord;
    resolve: (decision: ApprovalDecision | null) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    promise: Promise<ApprovalDecision | null>;
    orchestration: ApprovalOrchestrationContext | null;
}

const toolExecutionContexts = new Map<string, ToolExecutionContext>();

const SIMPLE_SHELL_CONTROL_PATTERN = /(?:\r|\n|&&|\|\||;|\||`|\$\()/;
const SAFE_WORKER_SHELL_EXECUTABLES = new Set([
    'node',
    'nodejs',
    'npm',
    'npx',
    'pnpm',
    'yarn',
    'python',
    'python3',
    'tsx',
    'uv',
    'uvx',
]);
const SAFE_PACKAGE_MANAGER_EXECUTABLES = new Set(['npm', 'pnpm', 'yarn']);
const SAFE_FORGE_PACKAGE_SUBCOMMANDS = new Set(['install', 'add']);
const SAFE_FORGE_PATH_PATTERN = /^\$REDBUSAGENT_(?:FORGE|SKILLS)_DIR(?:\/[A-Za-z0-9._/-]+)?$/;
const SAFE_FORGE_PACKAGE_SPEC_PATTERN = /^@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?(?:@[A-Za-z0-9._+-]+)?$/;
const SAFE_FORGE_ARG_PATTERN = /^[A-Za-z0-9._:@%+=,/-]+$/;
const EXACT_VAULT_STORE_CREDENTIAL_PAYLOAD_PATTERN = /^Vault\.storeCredential\(\s*(['"])(?:\\.|(?!\1).)+\1\s*,\s*(['"])(?:\\.|(?!\2).)+\2\s*,\s*(['"])(?:\\.|(?!\3).)+\3\s*\)$/;

function extractShellExecutable(command: string): string | null {
    for (const token of command.trim().split(/\s+/)) {
        if (!token || token === 'env') continue;
        if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) continue;
        return token.replace(/^['"]|['"]$/g, '').toLowerCase();
    }
    return null;
}

function stripShellQuotes(token: string): string {
    return token.replace(/^['"]|['"]$/g, '');
}

function tokenizeShellCommand(command: string): string[] {
    return command.trim().split(/\s+/).map(stripShellQuotes).filter(Boolean);
}

function extractNodeEvalPayload(command: string, executable: string): string | null {
    if (executable !== 'node' && executable !== 'nodejs') return null;
    const match = command.match(/^(?:node|nodejs)\s+-e\s+(['"])(.*)\1$/);
    return match?.[2] ?? null;
}

function isSafeForgePathToken(token?: string): boolean {
    return !!token && SAFE_FORGE_PATH_PATTERN.test(stripShellQuotes(token));
}

function areSafeForgePackageSpecs(tokens: string[]): boolean {
    return tokens.length > 0 && tokens.every((token) => SAFE_FORGE_PACKAGE_SPEC_PATTERN.test(stripShellQuotes(token)));
}

function areSafeForgeArgs(tokens: string[]): boolean {
    return tokens.every((token) => SAFE_FORGE_ARG_PATTERN.test(stripShellQuotes(token)));
}

function isAllowedVaultRuntimeCommand(command: string, executable: string): boolean {
    const payload = extractNodeEvalPayload(command, executable);
    return !!payload && EXACT_VAULT_STORE_CREDENTIAL_PAYLOAD_PATTERN.test(payload);
}

function isAllowedForgePackageCommand(command: string, executable: string): boolean {
    if (!SAFE_PACKAGE_MANAGER_EXECUTABLES.has(executable)) return false;

    const tokens = tokenizeShellCommand(command);
    if (tokens.length < 4 || tokens[0] !== executable) return false;

    if (executable === 'npm') {
        if (tokens[1] === '--prefix' && SAFE_FORGE_PACKAGE_SUBCOMMANDS.has(tokens[3] || '')) {
            return isSafeForgePathToken(tokens[2]) && areSafeForgePackageSpecs(tokens.slice(4));
        }
        if (SAFE_FORGE_PACKAGE_SUBCOMMANDS.has(tokens[1] || '') && tokens[2] === '--prefix') {
            return isSafeForgePathToken(tokens[3]) && areSafeForgePackageSpecs(tokens.slice(4));
        }
        return false;
    }

    if (executable === 'pnpm') {
        if (!SAFE_FORGE_PACKAGE_SUBCOMMANDS.has(tokens[1] || '')) return false;
        const dirFlagIndex = tokens.findIndex((token) => token === '--dir');
        if (dirFlagIndex < 0 || !isSafeForgePathToken(tokens[dirFlagIndex + 1])) return false;
        const packageSpecs = tokens.filter((_, index) => index !== 0 && index !== 1 && index !== dirFlagIndex && index !== dirFlagIndex + 1);
        return areSafeForgePackageSpecs(packageSpecs);
    }

    if (executable === 'yarn') {
        if (!SAFE_FORGE_PACKAGE_SUBCOMMANDS.has(tokens[1] || '')) return false;
        const cwdFlagIndex = tokens.findIndex((token) => token === '--cwd');
        if (cwdFlagIndex < 0 || !isSafeForgePathToken(tokens[cwdFlagIndex + 1])) return false;
        const packageSpecs = tokens.filter((_, index) => index !== 0 && index !== 1 && index !== cwdFlagIndex && index !== cwdFlagIndex + 1);
        return areSafeForgePackageSpecs(packageSpecs);
    }

    return false;
}

function isAllowedForgeRuntimeCommand(command: string, executable: string): boolean {
    const tokens = tokenizeShellCommand(command);
    if (tokens.length < 2 || tokens[0] !== executable) return false;

    if (executable === 'uv') {
        return tokens[1] === 'run' && isSafeForgePathToken(tokens[2]) && areSafeForgeArgs(tokens.slice(3));
    }

    if (!['node', 'nodejs', 'python', 'python3', 'tsx'].includes(executable)) return false;
    return isSafeForgePathToken(tokens[1]) && areSafeForgeArgs(tokens.slice(2));
}

function toApprovalOrchestrationContext(context?: ToolExecutionContext | null): ApprovalOrchestrationContext | null {
    if (!context?.sessionId || !context.taskId) return null;
    return {
        sessionId: context.sessionId,
        taskId: context.taskId,
        mode: context.mode,
        actor: context.actor,
    };
}

function classifyRestrictedWorkerShellCommand(command: string, executable: string): string | null {
    if (isAllowedVaultRuntimeCommand(command, executable)) return 'vault runtime command';
    if (isAllowedForgePackageCommand(command, executable) || isAllowedForgeRuntimeCommand(command, executable)) {
        return 'forge runtime command';
    }
    return null;
}

export function registerToolExecutionContext(context: ToolExecutionContext): void {
    const toolCallId = context.toolCallId.trim();
    if (!toolCallId) return;

    toolExecutionContexts.set(toolCallId, {
        ...context,
        toolCallId,
        args: { ...context.args },
    });
}

export function getToolExecutionContext(toolCallId?: string | null): ToolExecutionContext | null {
    if (!toolCallId) return null;
    const context = toolExecutionContexts.get(toolCallId);
    if (!context) return null;
    return {
        ...context,
        args: { ...context.args },
    };
}

export function clearToolExecutionContext(toolCallId?: string | null): void {
    if (!toolCallId) return;
    toolExecutionContexts.delete(toolCallId);
}

export function clearAllToolExecutionContexts(): void {
    toolExecutionContexts.clear();
}

export function getRestrictedWorkerShellAutoApproval(
    command: string,
    executionContext?: ToolExecutionContext | null,
): { approved: boolean; rationale?: string } {
    if (!executionContext) return { approved: false };
    if (executionContext.toolName !== 'execute_shell_command') return { approved: false };
    if (executionContext.actor !== 'worker' || executionContext.mode !== 'collaborative') return { approved: false };
    if (!executionContext.sessionId || !executionContext.taskId) return { approved: false };

    const normalized = command.trim();
    if (!normalized || SIMPLE_SHELL_CONTROL_PATTERN.test(normalized)) return { approved: false };

    const executable = extractShellExecutable(normalized);
    if (!executable || !SAFE_WORKER_SHELL_EXECUTABLES.has(executable)) return { approved: false };

    const classification = classifyRestrictedWorkerShellCommand(normalized, executable);
    if (!classification) return { approved: false };

    return {
        approved: true,
        rationale: `worker collaborative ${classification}`,
    };
}

function getPendingApprovalContext() {
    const session = engineBus.getLatestActiveSession();
    if (!session) return null;

    return {
        sessionId: session.sessionId,
        taskId: session.taskId,
        mode: session.mode,
        actor: session.activeActor,
    };
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
        orchestrationContext?: ApprovalOrchestrationContext | null,
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
            orchestration: orchestrationContext ?? getPendingApprovalContext(),
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
        const orchestrationContext = request.orchestrationContext
            ?? toApprovalOrchestrationContext(getToolExecutionContext(request.toolCallId))
            ?? getPendingApprovalContext();
        const promise = this.register(record, DEFAULT_APPROVAL_TIMEOUT_MS, orchestrationContext);
        const entry = this.pending.get(record.id);
        if (entry?.orchestration) {
            engineBus.emitOrchestrationEvent({
                type: 'yield_requested',
                sessionId: entry.orchestration.sessionId,
                taskId: entry.orchestration.taskId,
                mode: entry.orchestration.mode,
                actor: entry.orchestration.actor,
                waitFor: 'awaiting_approval',
                reason: `${request.toolName}: ${request.description}`,
                timestamp: Date.now(),
            });
        }
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
        if (entry.orchestration) {
            const timestamp = Date.now();
            const preview = decision === 'deny' ? 'Approval denied' : decision === 'allow-always' ? 'Approval granted permanently' : 'Approval granted once';
            engineBus.emitOrchestrationEvent({
                type: 'user_reply_received',
                sessionId: entry.orchestration.sessionId,
                taskId: entry.orchestration.taskId,
                mode: entry.orchestration.mode,
                actor: 'user',
                replyPreview: preview,
                timestamp,
            });
            engineBus.emitOrchestrationEvent({
                type: 'resumed',
                sessionId: entry.orchestration.sessionId,
                taskId: entry.orchestration.taskId,
                mode: entry.orchestration.mode,
                actor: entry.orchestration.actor,
                reason: `Approval decision received for ${entry.record.request.toolName}.`,
                timestamp: timestamp + 1,
            });
        }
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
        if (entry.orchestration) {
            engineBus.emitOrchestrationEvent({
                type: 'resumed',
                sessionId: entry.orchestration.sessionId,
                taskId: entry.orchestration.taskId,
                mode: entry.orchestration.mode,
                actor: entry.orchestration.actor,
                reason: `Approval request for ${entry.record.request.toolName} expired without a user decision.`,
                timestamp: Date.now(),
            });
        }
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

