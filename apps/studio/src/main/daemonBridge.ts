import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net';
import type { ClientMessage, DaemonMessage } from '@redbusagent/shared';
import {
    STUDIO_IPC_VERSION,
    type ChatSendCommand,
    type StudioForgeSnapshot,
    type StudioMainEvent,
    type StudioSessionState,
    type SystemCommandCommand,
    type StudioTunnelConfig,
    type StudioYieldKind,
    type StudioYieldRequest,
    type YieldRespondCommand,
} from '@redbusagent/shared/studio';

const require = createRequire(import.meta.url);
const Ssh2Client = require('ssh2').Client as new () => SshClientLike;
const WsClient = require('ws') as new (url: string) => WsClientLike;

const WS_OPEN = 1;
const COMPAT_QUESTION_PREFIX = '❓ **Agent needs your input:**\n';
const COMPAT_APPROVAL_MARKERS = ['Approve? (Y/N)', 'SECURITY ALERT:', 'INTRUSIVE ACTION:'];

interface SshClientLike {
    connect(config: Record<string, unknown>): void;
    end(): void;
    destroy(): void;
    forwardOut(
        srcIP: string,
        srcPort: number,
        dstIP: string,
        dstPort: number,
        callback: (error: Error | undefined, stream: NodeJS.ReadWriteStream | undefined) => void,
    ): void;
    on(event: 'ready' | 'error' | 'close', listener: (...args: unknown[]) => void): this;
    once(event: 'ready' | 'error', listener: (...args: unknown[]) => void): this;
}

interface WsClientLike {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, data?: string): void;
    terminate(): void;
    on(event: 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): this;
    once(event: 'open' | 'error', listener: (...args: unknown[]) => void): this;
}

interface ForwardedPort {
    readonly label: 'ws' | 'api';
    readonly localPort: number;
    readonly remotePort: number;
    readonly server: NetServer;
}

type ForwardedStream = NodeJS.ReadWriteStream & {
    destroy(): void;
    on(event: 'error', listener: () => void): unknown;
    pipe(destination: Socket): unknown;
};

export function buildCompatibilityYieldRequest(requestId: string, delta: string): StudioYieldRequest | null {
    if (delta.startsWith(COMPAT_QUESTION_PREFIX)) {
        const body = delta.slice(COMPAT_QUESTION_PREFIX.length).trim();
        return {
            yieldId: requestId,
            kind: classifyYieldKind(body),
            title: 'Agent input required',
            body,
        };
    }

    if (COMPAT_APPROVAL_MARKERS.some((marker) => delta.includes(marker))) {
        return {
            yieldId: requestId,
            kind: 'approval',
            title: 'Approval required',
            body: delta.replace(/\n\nApprove\? \(Y\/N\)\s*$/u, '').trim(),
        };
    }

    return null;
}

export function classifyYieldKind(body: string): StudioYieldKind {
    return /(credential|token|secret|password|passphrase|api key)/iu.test(body) ? 'credential' : 'question';
}

export function extractActiveFile(args: Record<string, unknown>): string | undefined {
    const candidates = [args['filePath'], args['path'], args['file'], args['targetPath']];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate;
        }
    }
    return undefined;
}

function approvalDecisionToResolution(decision: YieldRespondCommand['payload']['decision']): 'approved' | 'denied' | 'submitted' {
    if (decision === 'deny') {
        return 'denied';
    }
    if (decision === 'submit') {
        return 'submitted';
    }
    return 'approved';
}

function buildYieldResponseText(request: StudioYieldRequest, decision: YieldRespondCommand['payload']['decision'], note?: string): string {
    const trimmedNote = note?.trim();

    if (request.kind === 'approval' || request.kind === 'confirmation') {
        const prefix = decision === 'deny' ? 'no' : 'yes';
        return trimmedNote ? `${prefix}\n${trimmedNote}` : prefix;
    }

    if (decision === 'deny') {
        return trimmedNote ? `decline\n${trimmedNote}` : 'decline';
    }

    if (!trimmedNote) {
        throw new Error('A response is required before resuming this yield.');
    }

    return trimmedNote;
}

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
}

export class StudioDaemonBridge {
    private sessionState: StudioSessionState = {
        sessionId: 'studio-shell',
        connection: 'disconnected',
        tunnel: 'idle',
        daemon: 'disconnected',
    };

    private forgeState: StudioForgeSnapshot = { status: 'idle' };
    private sshClient: SshClientLike | null = null;
    private daemonSocket: WsClientLike | null = null;
    private forwardedPorts: ForwardedPort[] = [];
    private readonly streamBuffers = new Map<string, string>();
    private readonly pendingYields = new Map<string, StudioYieldRequest>();
    private intentionalDisconnect = false;

    constructor(private readonly emit: (event: StudioMainEvent) => void) {}

    get currentSessionState(): StudioSessionState {
        return this.sessionState;
    }

    async connect(profileId: string | undefined, tunnel: StudioTunnelConfig): Promise<{ connected: true }> {
        await this.cleanup(true);
        this.intentionalDisconnect = false;
        this.streamBuffers.clear();
        this.pendingYields.clear();

        this.updateSessionState({
            sessionId: `studio-${profileId ?? tunnel.host}`,
            activeProfileId: profileId,
            connection: 'connecting',
            tunnel: 'opening',
            daemon: 'connecting',
            daemonState: undefined,
            error: undefined,
        });
        this.emitTunnelLog('info', `Opening SSH tunnel to ${tunnel.host}:${tunnel.port}`, 'ssh/connect', undefined, tunnel.port);

        try {
            const privateKey = tunnel.privateKeyPath ? await readFile(tunnel.privateKeyPath, 'utf8') : undefined;
            if (!privateKey && !process.env['SSH_AUTH_SOCK']) {
                throw new Error('Studio requires privateKeyPath or SSH_AUTH_SOCK for SSH authentication.');
            }

            const ssh = new Ssh2Client();
            await this.connectSshClient(ssh, tunnel, privateKey);
            this.sshClient = ssh;

            const wsTunnel = await this.createForwardedPort(ssh, 'ws', tunnel.localWsPort, tunnel.daemonWsPort);
            const apiTunnel = await this.createForwardedPort(ssh, 'api', tunnel.localApiPort, tunnel.daemonApiPort);
            this.forwardedPorts = [wsTunnel, apiTunnel];

            this.emitTunnelLog('info', `Forwarded daemon WebSocket to 127.0.0.1:${wsTunnel.localPort}`, 'tunnel/open', wsTunnel.localPort, wsTunnel.remotePort);
            this.emitTunnelLog('info', `Forwarded daemon API to 127.0.0.1:${apiTunnel.localPort}`, 'tunnel/open', apiTunnel.localPort, apiTunnel.remotePort);

            await this.connectDaemonSocket(wsTunnel.localPort);

            this.updateSessionState({
                connection: 'connected',
                tunnel: 'open',
                daemon: 'connected',
                error: undefined,
            });

            return { connected: true };
        } catch (error) {
            await this.cleanup(true);
            const message = errorMessage(error, 'Failed to connect Studio to the remote daemon.');
            this.updateSessionState({
                connection: 'error',
                tunnel: 'error',
                daemon: 'error',
                error: message,
            });
            this.emitTunnelLog('error', message, 'daemon/connect');
            throw error instanceof Error ? error : new Error(message);
        }
    }

    async disconnect(reason: 'user' | 'network-error' | 'daemon-error' | 'shutdown' = 'user'): Promise<{ disconnected: true }> {
        await this.cleanup(true);
        if (reason === 'user' || reason === 'shutdown') {
            this.updateSessionState({
                connection: 'disconnected',
                tunnel: 'idle',
                daemon: 'disconnected',
                daemonState: undefined,
                error: undefined,
            });
        } else {
            this.updateSessionState({
                connection: 'error',
                tunnel: 'error',
                daemon: 'error',
                daemonState: undefined,
                error: `Connection closed (${reason}).`,
            });
        }
        this.updateForge({ status: 'idle' });

        return { disconnected: true };
    }

    sendChat(command: ChatSendCommand['payload']): { requestId: string } {
        this.sendClientMessage({
            type: 'chat:request',
            timestamp: new Date().toISOString(),
            payload: {
                requestId: command.requestId,
                content: command.content,
                tier: command.tier,
                messages: command.messages ? [...command.messages] : undefined,
            },
        });

        return { requestId: command.requestId };
    }

    sendSystemCommand(command: SystemCommandCommand['payload']): { command: string } {
        this.sendClientMessage({
            type: 'system:command',
            timestamp: new Date().toISOString(),
            payload: {
                command: command.command,
            },
        });

        return { command: command.command };
    }

    respondToYield(command: YieldRespondCommand['payload']): { yieldId: string } {
        const request = this.pendingYields.get(command.yieldId);
        if (!request) {
            throw new Error(`Yield ${command.yieldId} is no longer pending.`);
        }

        const content = buildYieldResponseText(request, command.decision, command.note);
        this.sendClientMessage({
            type: 'chat:request',
            timestamp: new Date().toISOString(),
            payload: {
                requestId: `yield-response-${Date.now()}`,
                content,
                tier: 'live',
            },
        });

        this.pendingYields.delete(command.yieldId);
        this.emit({
            version: STUDIO_IPC_VERSION,
            type: 'yield/resolved',
            payload: {
                yieldId: command.yieldId,
                resolution: approvalDecisionToResolution(command.decision),
                approval: request.approval
                    ? {
                        approvalId: request.approval.approvalId,
                        decision: command.decision === 'allow-always' ? 'allow-always' : command.decision === 'deny' ? 'deny' : 'allow-once',
                    }
                    : undefined,
            },
        });

        return { yieldId: command.yieldId };
    }

    async shutdown(): Promise<void> {
        await this.cleanup(true);
    }

    private async connectSshClient(ssh: SshClientLike, tunnel: StudioTunnelConfig, privateKey?: string): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const onReady = () => resolve();
            const onError = (error: unknown) => reject(error);
            ssh.once('ready', onReady);
            ssh.once('error', onError);
            ssh.connect({
                host: tunnel.host,
                port: tunnel.port,
                username: tunnel.username,
                privateKey,
                passphrase: tunnel.passphrase,
                agent: privateKey ? undefined : process.env['SSH_AUTH_SOCK'],
                readyTimeout: 10_000,
            });
        });
    }

    private async createForwardedPort(
        ssh: SshClientLike,
        label: 'ws' | 'api',
        requestedPort: number | undefined,
        remotePort: number,
    ): Promise<ForwardedPort> {
        const server = createServer((socket) => {
            void this.bridgeSocketThroughSsh(ssh, socket, remotePort);
        });

        server.listen(requestedPort ?? 0, '127.0.0.1');
        await once(server, 'listening');

        const address = server.address() as AddressInfo;
        return {
            label,
            localPort: address.port,
            remotePort,
            server,
        };
    }

    private async bridgeSocketThroughSsh(ssh: SshClientLike, socket: Socket, remotePort: number): Promise<void> {
        try {
            const stream = await new Promise<ForwardedStream>((resolve, reject) => {
                ssh.forwardOut(
                    socket.localAddress ?? '127.0.0.1',
                    socket.localPort ?? 0,
                    '127.0.0.1',
                    remotePort,
                    (error, forwardedStream) => {
                        if (error || !forwardedStream) {
                            reject(error ?? new Error(`Failed to forward remote port ${remotePort}.`));
                            return;
                        }
                        resolve(forwardedStream as ForwardedStream);
                    },
                );
            });

            socket.pipe(stream);
            stream.pipe(socket);
            socket.on('error', () => stream.destroy());
            stream.on('error', () => socket.destroy());
        } catch (error) {
            socket.destroy(error instanceof Error ? error : undefined);
        }
    }

    private async connectDaemonSocket(localPort: number): Promise<void> {
        const socket = new WsClient(`ws://127.0.0.1:${localPort}`);
        this.daemonSocket = socket;

        socket.on('message', (raw) => {
            this.handleRawMessage(raw);
        });
        socket.on('close', () => {
            if (!this.intentionalDisconnect) {
                void this.disconnect('daemon-error');
            }
        });
        socket.on('error', (error) => {
            if (socket.readyState === WS_OPEN && !this.intentionalDisconnect) {
                const message = errorMessage(error, 'Remote daemon socket failed.');
                this.emitTunnelLog('error', message, 'daemon/disconnect');
                void this.disconnect('network-error');
            }
        });

        await new Promise<void>((resolve, reject) => {
            socket.once('open', () => resolve());
            socket.once('error', (error) => reject(error));
        });
    }

    private handleRawMessage(raw: unknown): void {
        try {
            const message = JSON.parse(String(raw)) as DaemonMessage;
            this.handleDaemonMessage(message);
        } catch {
            this.emitTunnelLog('warn', 'Received malformed daemon payload.', 'daemon/connect');
        }
    }

    private handleDaemonMessage(message: DaemonMessage): void {
        switch (message.type) {
            case 'heartbeat':
                this.updateSessionState({ daemon: 'connected', daemonState: message.payload.state, error: undefined });
                this.emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'telemetry/update',
                    payload: {
                        uptimeMs: message.payload.uptimeMs,
                        connectedClients: message.payload.connectedClients,
                        tick: message.payload.tick,
                        daemonPort: message.payload.port,
                        workerStatus: message.payload.workerStatus,
                    },
                });
                return;

            case 'chat:stream:chunk': {
                const compatibilityYield = buildCompatibilityYieldRequest(message.payload.requestId, message.payload.delta);
                if (compatibilityYield) {
                    if (!this.pendingYields.has(compatibilityYield.yieldId)) {
                        this.pendingYields.set(compatibilityYield.yieldId, compatibilityYield);
                        this.emit({
                            version: STUDIO_IPC_VERSION,
                            type: 'yield/requested',
                            payload: compatibilityYield,
                        });
                    }
                    return;
                }

                const previous = this.streamBuffers.get(message.payload.requestId) ?? '';
                this.streamBuffers.set(message.payload.requestId, previous + message.payload.delta);
                this.emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'daemon/streamChunk',
                    payload: message.payload,
                });
                this.updateForge({
                    ...this.forgeState,
                    status: this.forgeState.status === 'executing' ? 'executing' : 'streaming',
                });
                return;
            }

            case 'chat:stream:done': {
                if (this.pendingYields.has(message.payload.requestId)) {
                    return;
                }

                const buffered = this.streamBuffers.get(message.payload.requestId) ?? '';
                this.streamBuffers.delete(message.payload.requestId);
                this.emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'daemon/streamDone',
                    payload: {
                        ...message.payload,
                        fullText: message.payload.fullText || buffered,
                    },
                });
                this.updateForge({
                    status: 'idle',
                    activeFile: this.forgeState.activeFile,
                    summary: buffered ? buffered.slice(0, 180) : this.forgeState.summary,
                    selectedTool: this.forgeState.selectedTool,
                });
                return;
            }

            case 'chat:error':
                this.streamBuffers.delete(message.payload.requestId);
                this.emitTunnelLog('error', message.payload.error, 'daemon/disconnect');
                this.emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'daemon/streamDone',
                    payload: {
                        requestId: message.payload.requestId,
                        fullText: `⚠️ ${message.payload.error}`,
                        tier: 'live',
                        model: 'daemon-error',
                    },
                });
                this.updateForge({ ...this.forgeState, status: 'error', summary: message.payload.error });
                return;

            case 'chat:tool:call':
                this.emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'daemon/toolCall',
                    payload: message.payload,
                });
                this.updateForge({
                    status: 'executing',
                    selectedTool: message.payload.toolName,
                    activeFile: extractActiveFile(message.payload.args),
                    summary: `Running ${message.payload.toolName}`,
                });
                return;

            case 'chat:tool:result':
                this.emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'daemon/toolResult',
                    payload: message.payload,
                });
                this.updateForge({
                    status: message.payload.success ? 'streaming' : 'error',
                    selectedTool: message.payload.toolName,
                    activeFile: this.forgeState.activeFile,
                    summary: message.payload.result.slice(0, 180),
                });
                return;

            case 'proactive:thought':
                this.emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'daemon/thought',
                    payload: message.payload,
                });
                return;

            case 'log':
                this.emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'operator/log',
                    payload: {
                        kind: 'daemon',
                        level: message.payload.level,
                        source: message.payload.source,
                        message: message.payload.message,
                    },
                });
                return;

            case 'system:status':
                this.emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'operator/log',
                    payload: {
                        kind: 'status',
                        level: 'info',
                        source: 'Daemon',
                        message: `Daemon status: ${message.payload.status}`,
                    },
                });
                return;

            case 'system:alert':
                this.emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'daemon/thought',
                    payload: {
                        text: message.payload.message,
                        status: 'action',
                    },
                });
                return;

            case 'approval:request': {
                const request: StudioYieldRequest = {
                    yieldId: message.payload.approvalId,
                    kind: 'approval',
                    title: 'Approval required',
                    body: message.payload.description,
                    approval: message.payload,
                };
                this.pendingYields.set(request.yieldId, request);
                this.emit({ version: STUDIO_IPC_VERSION, type: 'yield/requested', payload: request });
                return;
            }

            case 'approval:resolved':
                this.pendingYields.delete(message.payload.approvalId);
                this.emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'yield/resolved',
                    payload: {
                        yieldId: message.payload.approvalId,
                        resolution: message.payload.decision === 'deny' ? 'denied' : message.payload.decision === 'expired' ? 'timed-out' : 'approved',
                        approval: message.payload,
                    },
                });
                return;

            case 'worker_task_completed':
                this.emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'daemon/thought',
                    payload: {
                        text: `Worker completed ${message.payload.description}`,
                        status: 'done',
                    },
                });
                this.updateForge({ ...this.forgeState, status: 'idle', summary: message.payload.description });
                return;

            case 'worker_task_failed':
                this.emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'daemon/thought',
                    payload: {
                        text: `Worker failed ${message.payload.description}: ${message.payload.error}`,
                        status: 'action',
                    },
                });
                this.updateForge({ ...this.forgeState, status: 'error', summary: message.payload.error });
                return;
        }
    }

    private sendClientMessage(message: ClientMessage): void {
        if (!this.daemonSocket || this.daemonSocket.readyState !== WS_OPEN) {
            throw new Error('Studio is not connected to a remote daemon.');
        }

        this.daemonSocket.send(JSON.stringify(message));
    }

    private updateSessionState(patch: Partial<StudioSessionState>): void {
        this.sessionState = {
            ...this.sessionState,
            ...patch,
        };

        this.emit({
            version: STUDIO_IPC_VERSION,
            type: 'session/state',
            payload: this.sessionState,
        });
    }

    private updateForge(snapshot: StudioForgeSnapshot): void {
        this.forgeState = snapshot;
        this.emit({
            version: STUDIO_IPC_VERSION,
            type: 'forge/update',
            payload: snapshot,
        });
    }

    private emitTunnelLog(
        level: 'info' | 'warn' | 'error' | 'debug',
        message: string,
        step?: 'ssh/connect' | 'tunnel/open' | 'daemon/connect' | 'daemon/disconnect',
        localPort?: number,
        remotePort?: number,
    ): void {
        this.emit({
            version: STUDIO_IPC_VERSION,
            type: 'tunnel/log',
            payload: {
                level,
                message,
                step,
                localPort,
                remotePort,
            },
        });
    }

    private async cleanup(silent: boolean): Promise<void> {
        this.intentionalDisconnect = true;

        for (const [yieldId] of this.pendingYields) {
            if (!silent) {
                this.emit({
                    version: STUDIO_IPC_VERSION,
                    type: 'yield/resolved',
                    payload: {
                        yieldId,
                        resolution: 'cancelled',
                    },
                });
            }
        }

        this.pendingYields.clear();
        this.streamBuffers.clear();

        const socket = this.daemonSocket;
        this.daemonSocket = null;
        if (socket) {
            try {
                socket.close(1000, 'Studio disconnect');
            } catch {
                socket.terminate();
            }
        }

        await Promise.all(this.forwardedPorts.map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))));
        this.forwardedPorts = [];

        if (this.sshClient) {
            this.sshClient.end();
            this.sshClient.destroy();
            this.sshClient = null;
        }
    }
}