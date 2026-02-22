/**
 * @redbusagent/shared — Protocol Types
 *
 * Defines the contract for all WebSocket messages exchanged between
 * the Daemon (server) and TUI (client). Every message must conform
 * to the DaemonMessage discriminated union.
 */

// ─── Base Envelope ────────────────────────────────────────────────

export interface BaseMessage {
    /** ISO-8601 timestamp of when the message was created */
    readonly timestamp: string;
}

// ─── Server → Client Messages ─────────────────────────────────────

export interface HeartbeatMessage extends BaseMessage {
    readonly type: 'heartbeat';
    readonly payload: {
        readonly uptimeMs: number;
        readonly pid: number;
        readonly port: number;
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

// ─── Client → Server Messages ─────────────────────────────────────

export interface PingMessage extends BaseMessage {
    readonly type: 'ping';
}

// ─── Discriminated Union ──────────────────────────────────────────

export type DaemonMessage =
    | HeartbeatMessage
    | LogMessage
    | SystemStatusMessage;

export type ClientMessage =
    | PingMessage;

/** All possible message types flowing through the WebSocket */
export type ProtocolMessage = DaemonMessage | ClientMessage;

/** Extracts the `type` literal from a message union */
export type MessageType = ProtocolMessage['type'];
