/**
 * @redbusagent/tui — WebSocket Client
 *
 * Manages the WebSocket connection to the daemon, with automatic
 * reconnection logic. Decoupled from UI — emits parsed protocol
 * messages via a callback so React components stay pure.
 */

import WebSocket from 'ws';
import type { DaemonMessage } from '@redbusagent/shared';
import { WS_RECONNECT_DELAY_MS } from '@redbusagent/shared';

export interface WsClientOptions {
    readonly url: string;
    readonly onMessage: (message: DaemonMessage) => void;
    readonly onConnected?: () => void;
    readonly onDisconnected?: () => void;
    readonly onError?: (error: Error) => void;
}

export class TuiWsClient {
    private socket: WebSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private intentionalClose = false;

    constructor(private readonly options: WsClientOptions) { }

    /** Establish the WebSocket connection */
    connect(): void {
        this.intentionalClose = false;
        this.createSocket();
    }

    /** Gracefully close the connection (no auto-reconnect) */
    disconnect(): void {
        this.intentionalClose = true;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.socket) {
            this.socket.close(1000, 'TUI closing');
            this.socket = null;
        }
    }

    // ── Private ──────────────────────────────────────────────────────

    private createSocket(): void {
        this.socket = new WebSocket(this.options.url);

        this.socket.on('open', () => {
            this.options.onConnected?.();
        });

        this.socket.on('message', (raw) => {
            try {
                const message = JSON.parse(raw.toString()) as DaemonMessage;
                this.options.onMessage(message);
            } catch {
                // Ignore malformed messages in PoC; future: structured error handling
            }
        });

        this.socket.on('close', () => {
            this.options.onDisconnected?.();
            this.scheduleReconnect();
        });

        this.socket.on('error', (err) => {
            this.options.onError?.(err as Error);
            // 'close' event will fire after 'error', triggering reconnect
        });
    }

    private scheduleReconnect(): void {
        if (this.intentionalClose) return;

        this.reconnectTimer = setTimeout(() => {
            this.createSocket();
        }, WS_RECONNECT_DELAY_MS);
    }
}
