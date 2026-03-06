/**
 * @redbusagent/shared — Redbus Studio IPC Contract
 *
 * Additive, versioned IPC types shared by Electron main, preload, and
 * renderer. These do not replace the existing daemon WebSocket protocol;
 * they wrap and reuse it where the desktop app needs a preload-safe bridge.
 */

import { DEFAULT_PORT } from '../constants.js';
import type {
    ApprovalRequestMessage,
    ApprovalResolvedMessage,
    ChatStreamChunkMessage,
    ChatStreamDoneMessage,
    ChatToolCallMessage,
    ChatToolResultMessage,
    DaemonState,
    ForgeLifecycleEventName,
    ForgeLifecycleMessage,
    ProactiveThoughtMessage,
    WorkerQueueStatus,
} from './protocol.js';

export const STUDIO_IPC_VERSION = '1.0.0' as const;
export const STUDIO_IPC_COMMAND_CHANNEL = 'redbus-studio:command' as const;
export const STUDIO_IPC_EVENT_CHANNEL = 'redbus-studio:event' as const;
export const DEFAULT_STUDIO_SSH_PORT = 22 as const;
export const DEFAULT_DAEMON_WS_PORT = DEFAULT_PORT;
export const DEFAULT_DAEMON_API_PORT = 8765 as const;

export type StudioConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type StudioTunnelStatus = 'idle' | 'opening' | 'open' | 'closing' | 'error';
export type StudioDaemonStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type StudioTunnelLogLevel = 'info' | 'warn' | 'error' | 'debug';
export type StudioYieldKind = 'approval' | 'question' | 'credential' | 'confirmation';
export type StudioYieldResolution = 'submitted' | 'cancelled' | 'timed-out' | 'approved' | 'denied';
export type StudioRouteMode = 'auto' | 'live' | 'cloud';

export interface StudioEnvelope {
    readonly version: typeof STUDIO_IPC_VERSION;
}

export interface StudioTunnelConfig {
    readonly host: string;
    readonly port: number;
    readonly username: string;
    readonly privateKeyPath?: string;
    readonly passphrase?: string;
    readonly daemonWsPort: number;
    readonly daemonApiPort: number;
    readonly localWsPort?: number;
    readonly localApiPort?: number;
}

export interface StudioConnectionProfile {
    readonly id: string;
    readonly label: string;
    readonly tunnel: StudioTunnelConfig;
}

export interface StudioSettings {
    readonly lastProfileId?: string;
    readonly profiles: readonly StudioConnectionProfile[];
    readonly theme: 'system' | 'dark' | 'light';
    readonly openDevtoolsOnLaunch: boolean;
    readonly defaultRouteMode: StudioRouteMode;
}

export const DEFAULT_STUDIO_SETTINGS: StudioSettings = {
    theme: 'system',
    openDevtoolsOnLaunch: false,
    profiles: [],
    defaultRouteMode: 'auto',
};

export function normalizeStudioSettings(settings?: Partial<StudioSettings> | null): StudioSettings {
    return {
        theme: settings?.theme ?? DEFAULT_STUDIO_SETTINGS.theme,
        openDevtoolsOnLaunch: settings?.openDevtoolsOnLaunch ?? DEFAULT_STUDIO_SETTINGS.openDevtoolsOnLaunch,
        profiles: Array.isArray(settings?.profiles) ? settings.profiles : DEFAULT_STUDIO_SETTINGS.profiles,
        lastProfileId: settings?.lastProfileId,
        defaultRouteMode: settings?.defaultRouteMode ?? DEFAULT_STUDIO_SETTINGS.defaultRouteMode,
    };
}

export interface StudioConversationMessage {
    readonly role: 'system' | 'assistant' | 'user';
    readonly content: string;
}

export interface StudioSessionState {
    readonly sessionId?: string;
    readonly connection: StudioConnectionStatus;
    readonly tunnel: StudioTunnelStatus;
    readonly daemon: StudioDaemonStatus;
    readonly daemonState?: DaemonState;
    readonly activeProfileId?: string;
    readonly error?: string;
}

export interface StudioTelemetrySnapshot {
    readonly cpuPercent?: number;
    readonly memoryPercent?: number;
    readonly latencyMs?: number;
    readonly throughputTokensPerMinute?: number;
    readonly uptimeMs?: number;
    readonly connectedClients?: number;
    readonly tick?: number;
    readonly daemonPort?: number;
    readonly workerStatus?: WorkerQueueStatus;
}

export interface StudioForgeSnapshot {
    readonly status: 'idle' | 'streaming' | 'executing' | 'success' | 'error';
    readonly requestId?: string;
    readonly event?: ForgeLifecycleEventName;
    readonly skillName?: string;
    readonly activeFile?: string;
    readonly summary?: string;
    readonly selectedTool?: string;
    readonly forgingReason?: string;
    readonly language?: StudioForgedSkill['language'];
    readonly content?: string;
    readonly result?: string;
    readonly error?: string;
}

export interface StudioForgedSkill {
    readonly skillName: string;
    readonly name: string;
    readonly toolName: string;
    readonly description: string;
    readonly forgingReason?: string;
    readonly source: 'forge' | 'forge-tdd';
    readonly createdAt: string;
    readonly language: 'javascript' | 'typescript' | 'python';
    readonly entrypoint: string;
    readonly skillPackagePath: string;
}

export interface DaemonSkillsResponse {
    readonly count: number;
    readonly skills: readonly StudioForgedSkill[];
}

export interface StudioYieldRequest {
    readonly yieldId: string;
    readonly kind: StudioYieldKind;
    readonly title: string;
    readonly body: string;
    readonly approval?: ApprovalRequestMessage['payload'];
}

export interface StudioYieldOutcome {
    readonly yieldId: string;
    readonly resolution: StudioYieldResolution;
    readonly approval?: ApprovalResolvedMessage['payload'];
}

export interface SessionConnectCommand extends StudioEnvelope {
    readonly type: 'session/connect';
    readonly payload: {
        readonly profileId?: string;
        readonly tunnel: StudioTunnelConfig;
    };
}

export interface SessionDisconnectCommand extends StudioEnvelope {
    readonly type: 'session/disconnect';
    readonly payload: {
        readonly reason?: 'user' | 'network-error' | 'daemon-error' | 'shutdown';
    };
}

export interface ChatSendCommand extends StudioEnvelope {
    readonly type: 'chat/send';
    readonly payload: {
        readonly requestId: string;
        readonly content: string;
        readonly tier?: 'live' | 'cloud';
        readonly messages?: readonly StudioConversationMessage[];
    };
}

export interface YieldRespondCommand extends StudioEnvelope {
    readonly type: 'yield/respond';
    readonly payload: {
        readonly yieldId: string;
        readonly decision: 'allow-once' | 'allow-always' | 'deny' | 'submit';
        readonly note?: string;
    };
}

export interface SettingsLoadCommand extends StudioEnvelope {
    readonly type: 'settings/load';
    readonly payload: Record<string, never>;
}

export interface SettingsSaveCommand extends StudioEnvelope {
    readonly type: 'settings/save';
    readonly payload: {
        readonly settings: StudioSettings;
    };
}

export interface SkillsListCommand extends StudioEnvelope {
    readonly type: 'skills/list';
    readonly payload: Record<string, never>;
}

export interface SystemCommandCommand extends StudioEnvelope {
    readonly type: 'system/command';
    readonly payload: {
        readonly command: 'status';
    };
}

export type StudioRendererCommand =
    | SessionConnectCommand
    | SessionDisconnectCommand
    | ChatSendCommand
    | YieldRespondCommand
    | SettingsLoadCommand
    | SettingsSaveCommand
    | SkillsListCommand
    | SystemCommandCommand;

export interface SessionStateEvent extends StudioEnvelope {
    readonly type: 'session/state';
    readonly payload: StudioSessionState;
}

export interface DaemonStreamChunkEvent extends StudioEnvelope {
    readonly type: 'daemon/streamChunk';
    readonly payload: ChatStreamChunkMessage['payload'];
}

export interface DaemonStreamDoneEvent extends StudioEnvelope {
    readonly type: 'daemon/streamDone';
    readonly payload: ChatStreamDoneMessage['payload'];
}

export interface DaemonToolCallEvent extends StudioEnvelope {
    readonly type: 'daemon/toolCall';
    readonly payload: ChatToolCallMessage['payload'];
}

export interface DaemonToolResultEvent extends StudioEnvelope {
    readonly type: 'daemon/toolResult';
    readonly payload: ChatToolResultMessage['payload'];
}

export interface DaemonThoughtEvent extends StudioEnvelope {
    readonly type: 'daemon/thought';
    readonly payload: ProactiveThoughtMessage['payload'];
}

export interface DaemonForgeLifecycleEvent extends StudioEnvelope {
    readonly type: 'daemon/forge';
    readonly payload: ForgeLifecycleMessage['payload'];
}

export interface TelemetryUpdateEvent extends StudioEnvelope {
    readonly type: 'telemetry/update';
    readonly payload: StudioTelemetrySnapshot;
}

export interface ForgeUpdateEvent extends StudioEnvelope {
    readonly type: 'forge/update';
    readonly payload: StudioForgeSnapshot;
}

export interface YieldRequestedEvent extends StudioEnvelope {
    readonly type: 'yield/requested';
    readonly payload: StudioYieldRequest;
}

export interface YieldResolvedEvent extends StudioEnvelope {
    readonly type: 'yield/resolved';
    readonly payload: StudioYieldOutcome;
}

export interface TunnelLogEvent extends StudioEnvelope {
    readonly type: 'tunnel/log';
    readonly payload: {
        readonly level: StudioTunnelLogLevel;
        readonly message: string;
        readonly step?: 'ssh/connect' | 'tunnel/open' | 'daemon/connect' | 'daemon/disconnect';
        readonly localPort?: number;
        readonly remotePort?: number;
    };
}

export interface OperatorLogEvent extends StudioEnvelope {
    readonly type: 'operator/log';
    readonly payload: {
        readonly kind: 'daemon' | 'status' | 'session';
        readonly level: StudioTunnelLogLevel;
        readonly source: string;
        readonly message: string;
    };
}

export type StudioMainEvent =
    | SessionStateEvent
    | DaemonStreamChunkEvent
    | DaemonStreamDoneEvent
    | DaemonToolCallEvent
    | DaemonToolResultEvent
    | DaemonThoughtEvent
    | DaemonForgeLifecycleEvent
    | TelemetryUpdateEvent
    | ForgeUpdateEvent
    | YieldRequestedEvent
    | YieldResolvedEvent
    | TunnelLogEvent
    | OperatorLogEvent;

export type StudioContractMessage = StudioRendererCommand | StudioMainEvent;
export type StudioCommandType = StudioRendererCommand['type'];
export type StudioEventType = StudioMainEvent['type'];

export interface StudioCommandSuccess {
    readonly ok: true;
    readonly type: StudioCommandType;
    readonly data?: unknown;
}

export interface StudioCommandFailure {
    readonly ok: false;
    readonly type: StudioCommandType;
    readonly error: string;
}

export type StudioCommandResult = StudioCommandSuccess | StudioCommandFailure;
export type StudioEventListener = (event: StudioMainEvent) => void;

export interface StudioBridgeApi {
    invoke(command: StudioRendererCommand): Promise<StudioCommandResult>;
    subscribe(listener: StudioEventListener): () => void;
}