/**
 * @redbusagent/daemon — WebSocket Server
 *
 * Manages the WebSocket server lifecycle, client connections,
 * message broadcasting, and incoming message routing.
 * This is the core infrastructure layer for daemon↔TUI communication.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { DaemonMessage, ClientMessage } from '@redbusagent/shared';

type DaemonWsMessage = DaemonMessage | {
    readonly type: 'forge:lifecycle';
    readonly timestamp: string;
    readonly payload: {
        readonly requestId: string;
        readonly event: 'FORGE_START' | 'FORGE_STREAM' | 'FORGE_SUCCESS' | 'FORGE_ERROR';
        readonly skillName?: string;
        readonly toolName?: string;
        readonly description?: string;
        readonly forgingReason?: string;
        readonly language?: 'javascript' | 'typescript' | 'python';
        readonly delta?: string;
        readonly result?: string;
        readonly error?: string;
    };
};

export interface WsServerOptions {
    readonly port: number;
    readonly host: string;
    readonly onConnection?: (clientId: string) => void;
    readonly onDisconnection?: (clientId: string) => void;
    readonly onClientMessage?: (clientId: string, message: ClientMessage) => void;
}

export class DaemonWsServer {
    private readonly wss: WebSocketServer;
    private readonly clients = new Map<string, WebSocket>();
    private clientCounter = 0;

    constructor(private readonly options: WsServerOptions) {
        this.wss = new WebSocketServer({
            port: options.port,
            host: options.host,
        });

        this.wss.on('connection', (socket) => {
            this.handleConnection(socket);
        });
    }

    /** Broadcast a typed message to all connected clients */
    broadcast(message: DaemonWsMessage): void {
        const payload = JSON.stringify(message);

        for (const [, socket] of this.clients) {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(payload);
            }
        }
    }

    /** Send a typed message to a specific client */
    sendTo(clientId: string, message: DaemonWsMessage): void {
        const socket = this.clients.get(clientId);
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(message));
        }
    }

    /** Number of currently connected clients */
    get connectionCount(): number {
        return this.clients.size;
    }

    /** Gracefully shut down the WebSocket server */
    async shutdown(): Promise<void> {
        for (const [, socket] of this.clients) {
            socket.close(1000, 'Daemon shutting down');
        }
        this.clients.clear();

        return new Promise((resolve, reject) => {
            this.wss.close((err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    // ── Private ──────────────────────────────────────────────────────

    private handleConnection(socket: WebSocket): void {
        const clientId = `tui-${++this.clientCounter}`;
        this.clients.set(clientId, socket);
        this.options.onConnection?.(clientId);

        socket.on('message', (raw) => {
            try {
                const message = JSON.parse(raw.toString()) as ClientMessage;
                this.options.onClientMessage?.(clientId, message);
            } catch {
                console.error(`[ws-server] Malformed message from ${clientId}`);
            }
        });

        socket.on('close', () => {
            this.clients.delete(clientId);
            this.options.onDisconnection?.(clientId);
        });

        socket.on('error', (err) => {
            console.error(`[ws-server] Error from ${clientId}:`, err.message);
            this.clients.delete(clientId);
        });
    }
}
