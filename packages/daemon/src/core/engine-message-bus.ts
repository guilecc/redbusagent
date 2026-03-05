/**
 * @redbusagent/daemon — Engine-to-Engine Message Bus
 *
 * MAS Foundation:
 *   The daemon now tracks orchestration sessions instead of only a single
 *   worker-active bit. Legacy `worker:*` events remain available as aliases
 *   so existing observers keep working while the router/heartbeat upgrade to
 *   a typed orchestration lifecycle.
 */

import { EventEmitter } from 'node:events';

// ─── MAS Session Types ────────────────────────────────────────────

export type OrchestrationExecutionMode = 'local-only' | 'cloud-only' | 'collaborative';
export type OrchestrationActor = 'system' | 'live' | 'cloud' | 'worker' | 'user';
export type OrchestrationSessionState = 'running' | 'paused' | 'completed' | 'failed';
export type OrchestrationPauseKind = 'awaiting_user_reply' | 'awaiting_approval' | 'external_input';
export type OrchestrationSessionResolution = 'success' | 'blocked' | 'bounded_failure';

interface OrchestrationEventBase {
    sessionId: string;
    taskId: string;
    mode: OrchestrationExecutionMode;
    actor: OrchestrationActor;
    timestamp: number;
}

export interface OrchestrationTaskCreatedEvent extends OrchestrationEventBase {
    type: 'task_created';
    prompt: string;
}

export interface OrchestrationDelegatedEvent extends OrchestrationEventBase {
    type: 'delegated';
    from: OrchestrationActor;
    to: OrchestrationActor;
    summary: string;
}

export interface OrchestrationToolCalledEvent extends OrchestrationEventBase {
    type: 'tool_called';
    toolName: string;
    args: Record<string, unknown>;
}

export interface OrchestrationToolResultEvent extends OrchestrationEventBase {
    type: 'tool_result';
    toolName: string;
    success: boolean;
    durationMs: number;
    resultPreview?: string;
}

export interface OrchestrationProgressUpdatedEvent extends OrchestrationEventBase {
    type: 'progress_updated';
    charsGenerated: number;
    toolCallCount: number;
    elapsed: number;
    detail?: string;
}

export interface OrchestrationCriticFeedbackEvent extends OrchestrationEventBase {
    type: 'critic_feedback';
    critic: OrchestrationActor;
    target: OrchestrationActor;
    verdict: 'approved' | 'revise' | 'blocked';
    feedback: string;
}

export interface OrchestrationRepairRequestedEvent extends OrchestrationEventBase {
    type: 'repair_requested';
    critic: OrchestrationActor;
    target: OrchestrationActor;
    attempt: number;
    reason: string;
    toolName?: string;
}

export interface OrchestrationYieldRequestedEvent extends OrchestrationEventBase {
    type: 'yield_requested';
    waitFor: OrchestrationPauseKind;
    reason: string;
}

export interface OrchestrationUserReplyReceivedEvent extends OrchestrationEventBase {
    type: 'user_reply_received';
    replyPreview: string;
}

export interface OrchestrationResumedEvent extends OrchestrationEventBase {
    type: 'resumed';
    reason: string;
}

export interface OrchestrationCompletedEvent extends OrchestrationEventBase {
    type: 'completed';
    summary: string;
    totalChars?: number;
    totalToolCalls?: number;
    totalDurationMs?: number;
}

export interface OrchestrationFailedEvent extends OrchestrationEventBase {
    type: 'failed';
    error: string;
    failureKind?: Exclude<OrchestrationSessionResolution, 'success'>;
}

export type OrchestrationEvent =
    | OrchestrationTaskCreatedEvent
    | OrchestrationDelegatedEvent
    | OrchestrationToolCalledEvent
    | OrchestrationToolResultEvent
    | OrchestrationProgressUpdatedEvent
    | OrchestrationCriticFeedbackEvent
    | OrchestrationRepairRequestedEvent
    | OrchestrationYieldRequestedEvent
    | OrchestrationUserReplyReceivedEvent
    | OrchestrationResumedEvent
    | OrchestrationCompletedEvent
    | OrchestrationFailedEvent;

export interface OrchestrationSessionSnapshot {
    sessionId: string;
    taskId: string;
    mode: OrchestrationExecutionMode;
    state: OrchestrationSessionState;
    activeActor: OrchestrationActor;
    promptPreview: string;
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
    failedAt?: number;
    pauseKind?: OrchestrationPauseKind;
    pauseReason?: string;
    lastError?: string;
    lastEventType?: OrchestrationEvent['type'];
    resolution?: OrchestrationSessionResolution;
    toolCallCount: number;
    charsGenerated: number;
    delegationCount: number;
    critiqueCount: number;
    repairCount: number;
    lastCritiqueVerdict?: OrchestrationCriticFeedbackEvent['verdict'];
    lastCritiqueFeedback?: string;
    history: OrchestrationEvent[];
}

export interface OrchestrationSessionCounts {
    running: number;
    paused: number;
    completed: number;
    failed: number;
}

// ─── Legacy Worker Events ─────────────────────────────────────────

export interface WorkerStartEvent {
    taskId: string;
    prompt: string;
    timestamp: number;
}

export interface WorkerToolCallEvent {
    taskId: string;
    toolName: string;
    args: Record<string, unknown>;
    timestamp: number;
}

export interface WorkerToolResultEvent {
    taskId: string;
    toolName: string;
    success: boolean;
    durationMs: number;
    timestamp: number;
}

export interface WorkerProgressEvent {
    taskId: string;
    charsGenerated: number;
    toolCallCount: number;
    elapsed: number;
    timestamp: number;
}

export interface WorkerDoneEvent {
    taskId: string;
    totalChars: number;
    totalToolCalls: number;
    totalDurationMs: number;
    timestamp: number;
}

export interface WorkerErrorEvent {
    taskId: string;
    error: string;
    timestamp: number;
}

// ─── Bus Event Map ────────────────────────────────────────────────

export interface EngineEventMap {
    'worker:start': WorkerStartEvent;
    'worker:tool_call': WorkerToolCallEvent;
    'worker:tool_result': WorkerToolResultEvent;
    'worker:progress': WorkerProgressEvent;
    'worker:done': WorkerDoneEvent;
    'worker:error': WorkerErrorEvent;
    'orchestration:task_created': OrchestrationTaskCreatedEvent;
    'orchestration:delegated': OrchestrationDelegatedEvent;
    'orchestration:tool_called': OrchestrationToolCalledEvent;
    'orchestration:tool_result': OrchestrationToolResultEvent;
    'orchestration:progress_updated': OrchestrationProgressUpdatedEvent;
    'orchestration:critic_feedback': OrchestrationCriticFeedbackEvent;
    'orchestration:repair_requested': OrchestrationRepairRequestedEvent;
    'orchestration:yield_requested': OrchestrationYieldRequestedEvent;
    'orchestration:user_reply_received': OrchestrationUserReplyReceivedEvent;
    'orchestration:resumed': OrchestrationResumedEvent;
    'orchestration:completed': OrchestrationCompletedEvent;
    'orchestration:failed': OrchestrationFailedEvent;
    'orchestration:session_updated': OrchestrationSessionSnapshot;
}

type EventKey = keyof EngineEventMap;

// ─── Helpers ──────────────────────────────────────────────────────

const MAX_SESSION_HISTORY = 40;

function cloneSession(session: OrchestrationSessionSnapshot): OrchestrationSessionSnapshot {
    return {
        ...session,
        history: [...session.history],
    };
}

function toOrchestrationEventKey(type: OrchestrationEvent['type']): EventKey {
    return `orchestration:${type}` as EventKey;
}

// ─── The Bus ──────────────────────────────────────────────────────

export class EngineMessageBus extends EventEmitter {
    private activeSessionId: string | null = null;
    private readonly sessions = new Map<string, OrchestrationSessionSnapshot>();

    private ensureSession(event: OrchestrationEvent): OrchestrationSessionSnapshot {
        const existing = this.sessions.get(event.sessionId);
        if (existing) return existing;

        const snapshot: OrchestrationSessionSnapshot = {
            sessionId: event.sessionId,
            taskId: event.taskId,
            mode: event.mode,
            state: 'running',
            activeActor: event.actor,
            promptPreview: event.type === 'task_created' ? event.prompt.slice(0, 200) : '',
            createdAt: event.timestamp,
            updatedAt: event.timestamp,
            toolCallCount: 0,
            charsGenerated: 0,
            delegationCount: 0,
            critiqueCount: 0,
            repairCount: 0,
            history: [],
        };

        this.sessions.set(event.sessionId, snapshot);
        return snapshot;
    }

    private emitLegacyAliases(event: OrchestrationEvent): void {
        switch (event.type) {
            case 'task_created':
                this.emit('worker:start', {
                    taskId: event.taskId,
                    prompt: event.prompt.slice(0, 200),
                    timestamp: event.timestamp,
                } satisfies WorkerStartEvent);
                break;
            case 'tool_called':
                this.emit('worker:tool_call', {
                    taskId: event.taskId,
                    toolName: event.toolName,
                    args: event.args,
                    timestamp: event.timestamp,
                } satisfies WorkerToolCallEvent);
                break;
            case 'tool_result':
                this.emit('worker:tool_result', {
                    taskId: event.taskId,
                    toolName: event.toolName,
                    success: event.success,
                    durationMs: event.durationMs,
                    timestamp: event.timestamp,
                } satisfies WorkerToolResultEvent);
                break;
            case 'progress_updated':
                this.emit('worker:progress', {
                    taskId: event.taskId,
                    charsGenerated: event.charsGenerated,
                    toolCallCount: event.toolCallCount,
                    elapsed: event.elapsed,
                    timestamp: event.timestamp,
                } satisfies WorkerProgressEvent);
                break;
            case 'completed':
                this.emit('worker:done', {
                    taskId: event.taskId,
                    totalChars: event.totalChars ?? 0,
                    totalToolCalls: event.totalToolCalls ?? 0,
                    totalDurationMs: event.totalDurationMs ?? 0,
                    timestamp: event.timestamp,
                } satisfies WorkerDoneEvent);
                break;
            case 'failed':
                this.emit('worker:error', {
                    taskId: event.taskId,
                    error: event.error,
                    timestamp: event.timestamp,
                } satisfies WorkerErrorEvent);
                break;
        }
    }

    /** Create or refresh a session envelope without changing lifecycle state. */
    createSession(input: {
        sessionId?: string;
        taskId: string;
        prompt?: string;
        mode: OrchestrationExecutionMode;
        actor?: OrchestrationActor;
    }): OrchestrationSessionSnapshot {
        const sessionId = input.sessionId ?? input.taskId;
        const now = Date.now();
        const existing = this.sessions.get(sessionId);
        if (existing) {
            existing.mode = input.mode;
            existing.activeActor = input.actor ?? existing.activeActor;
            if (input.prompt) existing.promptPreview = input.prompt.slice(0, 200);
            existing.updatedAt = now;
            this.activeSessionId = sessionId;
            return cloneSession(existing);
        }

        const snapshot: OrchestrationSessionSnapshot = {
            sessionId,
            taskId: input.taskId,
            mode: input.mode,
            state: 'running',
            activeActor: input.actor ?? 'system',
            promptPreview: input.prompt?.slice(0, 200) ?? '',
            createdAt: now,
            updatedAt: now,
            toolCallCount: 0,
            charsGenerated: 0,
            delegationCount: 0,
            critiqueCount: 0,
            repairCount: 0,
            history: [],
        };

        this.sessions.set(sessionId, snapshot);
        this.activeSessionId = sessionId;
        return cloneSession(snapshot);
    }

    /** Backward-compatible worker start helper. */
    startTask(taskId: string, prompt: string, mode: OrchestrationExecutionMode = 'collaborative'): void {
        this.createSession({
            sessionId: taskId,
            taskId,
            prompt,
            mode,
            actor: mode === 'local-only' ? 'live' : 'worker',
        });

        this.emitOrchestrationEvent({
            type: 'task_created',
            sessionId: taskId,
            taskId,
            mode,
            actor: mode === 'local-only' ? 'live' : 'worker',
            prompt: prompt.slice(0, 200),
            timestamp: Date.now(),
        });
    }

    /** Emit a typed orchestration event and update the session snapshot. */
    emitOrchestrationEvent(event: OrchestrationEvent): OrchestrationSessionSnapshot {
        const session = this.ensureSession(event);

        session.taskId = event.taskId;
        session.mode = event.mode;
        session.activeActor = event.actor;
        session.updatedAt = event.timestamp;
        session.lastEventType = event.type;
        session.history.push(event);
        if (session.history.length > MAX_SESSION_HISTORY) {
            session.history.splice(0, session.history.length - MAX_SESSION_HISTORY);
        }

        switch (event.type) {
            case 'task_created':
                session.state = 'running';
                session.resolution = undefined;
                session.promptPreview = event.prompt.slice(0, 200);
                break;
            case 'delegated':
                session.state = 'running';
                session.resolution = undefined;
                session.delegationCount += 1;
                break;
            case 'tool_called':
                session.state = 'running';
                session.resolution = undefined;
                session.toolCallCount += 1;
                break;
            case 'tool_result':
                session.state = 'running';
                session.resolution = undefined;
                if (!event.success) {
                    session.lastError = event.resultPreview;
                }
                break;
            case 'progress_updated':
                session.state = 'running';
                session.resolution = undefined;
                session.charsGenerated = Math.max(session.charsGenerated, event.charsGenerated);
                session.toolCallCount = Math.max(session.toolCallCount, event.toolCallCount);
                break;
            case 'critic_feedback':
                session.state = 'running';
                session.resolution = undefined;
                session.critiqueCount += 1;
                session.lastCritiqueVerdict = event.verdict;
                session.lastCritiqueFeedback = event.feedback;
                if (event.verdict === 'blocked') {
                    session.lastError = event.feedback;
                }
                break;
            case 'repair_requested':
                session.state = 'running';
                session.resolution = undefined;
                session.repairCount += 1;
                session.lastCritiqueFeedback = event.reason;
                break;
            case 'yield_requested':
                session.state = 'paused';
                session.pauseKind = event.waitFor;
                session.pauseReason = event.reason;
                break;
            case 'user_reply_received':
                session.pauseReason = `User replied: ${event.replyPreview}`;
                break;
            case 'resumed':
                session.state = 'running';
                session.pauseKind = undefined;
                session.pauseReason = event.reason;
                break;
            case 'completed':
                session.state = 'completed';
                session.resolution = 'success';
                session.completedAt = event.timestamp;
                session.pauseKind = undefined;
                session.pauseReason = undefined;
                session.charsGenerated = Math.max(session.charsGenerated, event.totalChars ?? session.charsGenerated);
                session.toolCallCount = Math.max(session.toolCallCount, event.totalToolCalls ?? session.toolCallCount);
                break;
            case 'failed':
                session.state = 'failed';
                session.resolution = event.failureKind ?? 'bounded_failure';
                session.failedAt = event.timestamp;
                session.lastError = event.error;
                session.pauseKind = undefined;
                break;
        }

        this.activeSessionId = session.state === 'running' || session.state === 'paused'
            ? session.sessionId
            : this.activeSessionId === session.sessionId
                ? null
                : this.activeSessionId;

        this.emit(toOrchestrationEventKey(event.type), event as EngineEventMap[EventKey]);
        this.emitLegacyAliases(event);
        this.emit('orchestration:session_updated', cloneSession(session));
        return cloneSession(session);
    }

    /** Emit a typed event on the bus */
    emitEvent<K extends EventKey>(event: K, data: EngineEventMap[K]): void {
        this.emit(event, data);
    }

    /** Subscribe to a typed event */
    onEvent<K extends EventKey>(event: K, handler: (data: EngineEventMap[K]) => void): void {
        this.on(event, handler);
    }

    getSession(sessionId: string): OrchestrationSessionSnapshot | null {
        const session = this.sessions.get(sessionId);
        return session ? cloneSession(session) : null;
    }

    getSessions(): OrchestrationSessionSnapshot[] {
        return Array.from(this.sessions.values())
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(cloneSession);
    }

    getLatestSession(): OrchestrationSessionSnapshot | null {
        return this.getSessions()[0] ?? null;
    }

    getLatestActiveSession(): OrchestrationSessionSnapshot | null {
        return this.getSessions().find(session => session.state === 'running' || session.state === 'paused') ?? null;
    }

    getSessionCounts(): OrchestrationSessionCounts {
        const counts: OrchestrationSessionCounts = {
            running: 0,
            paused: 0,
            completed: 0,
            failed: 0,
        };

        for (const session of this.sessions.values()) {
            counts[session.state] += 1;
        }

        return counts;
    }

    hasRunningSessions(): boolean {
        return this.getSessionCounts().running > 0;
    }

    hasPausedSessions(): boolean {
        return this.getSessionCounts().paused > 0;
    }

    /** Get the currently active Worker task ID */
    getActiveTaskId(): string | null {
        if (this.activeSessionId) {
            return this.sessions.get(this.activeSessionId)?.taskId ?? null;
        }
        return this.getLatestActiveSession()?.taskId ?? null;
    }

    /** Clear the active task pointer without deleting session history. */
    clearTask(taskId?: string): void {
        if (!taskId) {
            this.activeSessionId = null;
            return;
        }

        const activeTaskId = this.activeSessionId ? this.sessions.get(this.activeSessionId)?.taskId : null;
        if (activeTaskId === taskId) {
            this.activeSessionId = null;
        }
    }

    /** Check if the Worker is currently processing */
    isWorkerActive(): boolean {
        return this.getSessions().some(session =>
            session.state === 'running'
            && session.mode !== 'local-only'
            && (session.activeActor === 'worker' || session.activeActor === 'cloud' || session.mode === 'collaborative'),
        );
    }

    /** Test helper: clear tracked sessions and listeners. */
    reset(): void {
        this.activeSessionId = null;
        this.sessions.clear();
        this.removeAllListeners();
    }
}

export const engineBus = new EngineMessageBus();

