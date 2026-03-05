import { useStudioState } from '../hooks/useStudioStore';
import type { StudioConnectionStatus, StudioTunnelStatus, StudioDaemonStatus } from '@redbusagent/shared/studio';

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

export default function StatusBar(): JSX.Element {
    const { session, telemetry, forge, yieldRequest } = useStudioState();

    return (
        <header className="flex items-center justify-between border-b border-white/10 bg-studio-panel px-4 py-2">
            {/* Left: branding */}
            <div className="flex items-center gap-3">
                <span className="text-sm font-bold tracking-widest text-studio-accent">REDBUS STUDIO</span>
                {session.activeProfileId && (
                    <span className="rounded bg-white/5 px-2 py-0.5 text-xs text-studio-muted">
                        {session.activeProfileId}
                    </span>
                )}
            </div>

            {/* Center: status badges */}
            <div className="flex items-center gap-2">
                <Badge label="Conn" status={session.connection} color={CONNECTION_COLORS[session.connection]} />
                <Badge label="Tunnel" status={session.tunnel} color={TUNNEL_COLORS[session.tunnel]} />
                <Badge label="Daemon" status={session.daemon} color={DAEMON_COLORS[session.daemon]} />
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
                {telemetry.latencyMs != null && <span>{telemetry.latencyMs}ms</span>}
                {telemetry.cpuPercent != null && <span>CPU {telemetry.cpuPercent}%</span>}
                {telemetry.throughputTokensPerMinute != null && (
                    <span>{telemetry.throughputTokensPerMinute} tok/min</span>
                )}
                {session.error && <span className="text-red-400">{session.error}</span>}
            </div>
        </header>
    );
}

