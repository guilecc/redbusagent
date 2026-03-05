import { useStudioState } from '../hooks/useStudioStore';
import type {
    StudioConnectionStatus,
    StudioDaemonStatus,
    StudioRouteMode,
    StudioTunnelStatus,
} from '@redbusagent/shared/studio';

const CONNECTION_COLORS: Record<StudioConnectionStatus, string> = {
    disconnected: 'bg-slate-500',
    connecting: 'bg-yellow-500 animate-pulse',
    connected: 'bg-emerald-500',
    error: 'bg-red-500',
};

const TUNNEL_COLORS: Record<StudioTunnelStatus, string> = {
    idle: 'bg-slate-500',
    opening: 'bg-yellow-500 animate-pulse',
    open: 'bg-emerald-500',
    closing: 'bg-yellow-500',
    error: 'bg-red-500',
};

const DAEMON_COLORS: Record<StudioDaemonStatus, string> = {
    disconnected: 'bg-slate-500',
    connecting: 'bg-yellow-500 animate-pulse',
    connected: 'bg-emerald-500',
    error: 'bg-red-500',
};

function Badge({ label, status, color }: { label: string; status: string; color: string }) {
    return (
        <div className="flex items-center gap-1.5 rounded-md bg-white/5 px-2.5 py-1 text-xs">
            <span className={`h-2 w-2 rounded-full ${color}`} />
            <span className="text-studio-muted">{label}:</span>
            <span className="font-medium text-slate-200">{status}</span>
        </div>
    );
}

const ROUTE_MODE_LABELS: Record<StudioRouteMode, string> = {
    auto: 'Auto-route',
    live: 'Live pinned',
    cloud: 'Cloud pinned',
};

const DAEMON_STATE_LABELS: Record<string, string> = {
    IDLE: 'Idle',
    THINKING: 'Thinking',
    EXECUTING_TOOL: 'Executing',
    BLOCKED_WAITING_USER: 'Blocked',
};

function formatUptime(uptimeMs?: number): string {
    if (!uptimeMs) {
        return '—';
    }

    const totalSeconds = Math.floor(uptimeMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

export default function StatusBar(): JSX.Element {
    const { session, settings, telemetry, forge, yieldRequest } = useStudioState();
    const activeProfile = settings.profiles.find((profile) => profile.id === session.activeProfileId);

    return (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-studio-panel px-4 py-2">
            {/* Left: branding */}
            <div className="flex items-center gap-3">
                <span className="text-sm font-bold tracking-widest text-studio-accent">REDBUS STUDIO</span>
                {activeProfile && (
                    <span className="rounded bg-white/5 px-2 py-0.5 text-xs text-studio-muted">
                        {activeProfile.label}
                    </span>
                )}
            </div>

            {/* Center: status badges */}
            <div className="flex items-center gap-2">
                <Badge label="Conn" status={session.connection} color={CONNECTION_COLORS[session.connection]} />
                <Badge label="Tunnel" status={session.tunnel} color={TUNNEL_COLORS[session.tunnel]} />
                <Badge label="Daemon" status={session.daemon} color={DAEMON_COLORS[session.daemon]} />
                {session.daemonState && (
                    <span className="rounded-md bg-white/5 px-2.5 py-1 text-xs text-slate-200">
                        {DAEMON_STATE_LABELS[session.daemonState] ?? session.daemonState}
                    </span>
                )}
                <span className="rounded-md bg-white/5 px-2.5 py-1 text-xs text-slate-200">
                    {ROUTE_MODE_LABELS[settings.defaultRouteMode]}
                </span>
                {forge.status !== 'idle' && (
                    <Badge label="Forge" status={forge.status} color={forge.status === 'error' ? 'bg-red-500' : 'bg-blue-500 animate-pulse'} />
                )}
                {yieldRequest && (
                    <span className="rounded-md bg-amber-500/20 px-2.5 py-1 text-xs font-semibold text-amber-400 animate-pulse">
                        ⏳ Yield Pending
                    </span>
                )}
            </div>

            {/* Right: telemetry summary */}
            <div className="flex items-center gap-3 text-xs text-studio-muted">
                <span>Uptime {formatUptime(telemetry.uptimeMs)}</span>
                <span>Clients {telemetry.connectedClients ?? 0}</span>
                <span>Tick {telemetry.tick ?? 0}</span>
                {telemetry.workerStatus?.enabled && <span>Worker {telemetry.workerStatus.running}/{telemetry.workerStatus.pending}</span>}
                {session.error && <span className="text-red-400">{session.error}</span>}
            </div>
        </header>
    );
}

