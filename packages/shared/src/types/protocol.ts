/**
 * @redbusagent/shared — Protocol Types
 *
 * Defines the contract for all WebSocket messages exchanged between
 * the Daemon (server) and TUI (client). Every message must conform
 * to a discriminated union keyed on `type`.
 */

// ─── Base Envelope ────────────────────────────────────────────────

export interface BaseMessage {
    /** ISO-8601 timestamp of when the message was created */
    readonly timestamp: string;
}

// ─── Server → Client Messages ─────────────────────────────────────

/** Global daemon state machine states */
export type DaemonState = 'IDLE' | 'THINKING' | 'EXECUTING_TOOL' | 'BLOCKED_WAITING_USER';

/** Worker Engine queue status (Dual-Local Architecture) */
export interface WorkerQueueStatus {
    /** Whether the Worker Engine is configured and enabled */
    readonly enabled: boolean;
    /** Worker Engine model name (e.g. "qwen2.5-coder:14b") */
    readonly model: string;
    /** Number of tasks waiting to be processed */
    readonly pending: number;
    /** Number of tasks currently being processed (0 or 1) */
    readonly running: number;
    /** Number of tasks completed since daemon start */
    readonly completed: number;
    /** Number of tasks that failed since daemon start */
    readonly failed: number;
}

export interface HeartbeatMessage extends BaseMessage {
    readonly type: 'heartbeat';
    readonly payload: {
        readonly uptimeMs: number;
        readonly pid: number;
        readonly port: number;
        /** Current global state machine state */
        readonly state: DaemonState;
        /** Number of tasks actively executing across all lanes */
        readonly activeTasks: number;
        /** Total tasks waiting in all queue lanes */
        readonly pendingTasks: number;
        /** Whether HITL approval is currently blocking */
        readonly awaitingApproval: boolean;
        /** Number of connected WS clients */
        readonly connectedClients: number;
        /** Monotonic tick counter */
        readonly tick: number;
        /** Worker Engine queue status (Dual-Local Architecture) */
        readonly workerStatus?: WorkerQueueStatus;
    };
}

export interface LogMessage extends BaseMessage {
    readonly type: 'log';
    readonly payload: {
        readonly level: 'info' | 'warn' | 'error' | 'debug';
        readonly source: string;
        readonly message: string;
    };
}

export interface SystemStatusMessage extends BaseMessage {
    readonly type: 'system:status';
    readonly payload: {
        readonly status: 'starting' | 'ready' | 'shutting_down';
    };
}

/** A chunk of streamed text from the LLM response */
export interface ChatStreamChunkMessage extends BaseMessage {
    readonly type: 'chat:stream:chunk';
    readonly payload: {
        /** Unique ID for this conversation turn */
        readonly requestId: string;
        /** The text delta (partial token) */
        readonly delta: string;
    };
}

/** Signals the end of a streaming response */
export interface ChatStreamDoneMessage extends BaseMessage {
    readonly type: 'chat:stream:done';
    readonly payload: {
        readonly requestId: string;
        /** Full accumulated response text */
        readonly fullText: string;
        /** Which engine handled this request (tier1=Live, tier2=Cloud, worker=Worker) */
        readonly tier: 'tier1' | 'tier2' | 'worker';
        /** Model identifier used */
        readonly model: string;
    };
}

/** Signals an error during chat processing */
export interface ChatErrorMessage extends BaseMessage {
    readonly type: 'chat:error';
    readonly payload: {
        readonly requestId: string;
        readonly error: string;
    };
}

/** The LLM decided to call a tool (Forge action) */
export interface ChatToolCallMessage extends BaseMessage {
    readonly type: 'chat:tool:call';
    readonly payload: {
        readonly requestId: string;
        readonly toolName: string;
        readonly args: Record<string, unknown>;
    };
}

/** A tool execution completed */
export interface ChatToolResultMessage extends BaseMessage {
    readonly type: 'chat:tool:result';
    readonly payload: {
        readonly requestId: string;
        readonly toolName: string;
        readonly success: boolean;
        readonly result: string;
    };
}

// ─── Proactive Messages (Heartbeat extensions) ──────────────────────

export interface ProactiveThoughtMessage extends BaseMessage {
    readonly type: 'proactive:thought';
    readonly payload: {
        readonly text: string;
        readonly status: 'thinking' | 'action' | 'done';
    };
}

export interface SystemAlertMessage extends BaseMessage {
    readonly type: 'system:alert';
    readonly payload: {
        readonly id: string;
        readonly message: string;
    };
}

// ─── Worker Engine Messages (Dual-Local Architecture) ────────────

/** A heavy background task completed on the Worker Engine */
export interface WorkerTaskCompletedMessage extends BaseMessage {
    readonly type: 'worker_task_completed';
    readonly payload: {
        readonly taskId: string;
        readonly description: string;
        readonly taskType: string;
        readonly resultLength: number;
    };
}

/** A heavy background task failed on the Worker Engine */
export interface WorkerTaskFailedMessage extends BaseMessage {
    readonly type: 'worker_task_failed';
    readonly payload: {
        readonly taskId: string;
        readonly description: string;
        readonly error: string;
    };
}

// ─── Approval Gate Messages (HITL) ────────────────────────────────

/** Daemon requests user approval for a destructive/intrusive tool */
export interface ApprovalRequestMessage extends BaseMessage {
    readonly type: 'approval:request';
    readonly payload: {
        /** Unique approval ID (matches ExecApprovalRecord.id) */
        readonly approvalId: string;
        /** Tool requesting approval */
        readonly toolName: string;
        /** Human-readable description of the action */
        readonly description: string;
        /** Why approval is needed */
        readonly reason: 'destructive' | 'intrusive';
        /** Tool arguments for context */
        readonly args: Record<string, unknown>;
        /** When this approval expires (epoch ms) */
        readonly expiresAtMs: number;
    };
}

/** Daemon signals an approval was resolved (by any client or expiry) */
export interface ApprovalResolvedMessage extends BaseMessage {
    readonly type: 'approval:resolved';
    readonly payload: {
        readonly approvalId: string;
        readonly decision: 'allow-once' | 'allow-always' | 'deny' | 'expired';
    };
}

// ─── Client → Server Messages ─────────────────────────────────────

export interface PingMessage extends BaseMessage {
    readonly type: 'ping';
}

/** User sends a chat message to the daemon for LLM processing */
export interface ChatRequestMessage extends BaseMessage {
    readonly type: 'chat:request';
    readonly payload: {
        /** Unique ID for this request (generated by client) */
        readonly requestId: string;
        /** The user's message text */
        readonly content: string;
        /** Optional: force a specific tier */
        readonly tier?: 'tier1' | 'tier2';
        /** Optional: flag for persona onboarding */
        readonly isOnboarding?: boolean;
        /** Unified conversational history array from the frontend */
        readonly messages?: any[];
    };
}


/** User selects a command from the slash palette */
export interface SystemCommandMessage extends BaseMessage {
    readonly type: 'system:command';
    readonly payload: {
        readonly command: 'force-local' | 'auto-route' | 'switch-cloud' | 'status' | 'set-default-tier' | 'force-worker';
        readonly args?: Record<string, unknown>;
    };
}

/** User responds to an approval request (Y/N) */
export interface ApprovalResponseMessage extends BaseMessage {
    readonly type: 'approval:response';
    readonly payload: {
        readonly approvalId: string;
        readonly decision: 'allow-once' | 'deny';
    };
}

// ─── Discriminated Unions ─────────────────────────────────────────

export type DaemonMessage =
    | HeartbeatMessage
    | LogMessage
    | SystemStatusMessage
    | ChatStreamChunkMessage
    | ChatStreamDoneMessage
    | ChatErrorMessage
    | ChatToolCallMessage
    | ChatToolResultMessage
    | ProactiveThoughtMessage
    | SystemAlertMessage
    | ApprovalRequestMessage
    | ApprovalResolvedMessage
    | WorkerTaskCompletedMessage
    | WorkerTaskFailedMessage;

export type ClientMessage =
    | PingMessage
    | ChatRequestMessage
    | SystemCommandMessage
    | ApprovalResponseMessage;

/** All possible message types flowing through the WebSocket */
export type ProtocolMessage = DaemonMessage | ClientMessage;

/** Extracts the `type` literal from a message union */
export type MessageType = ProtocolMessage['type'];
