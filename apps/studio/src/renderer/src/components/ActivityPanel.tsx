import { useStudioState, type ActivityEntry } from '../hooks/useStudioStore';

const LEVEL_STYLES: Record<ActivityEntry['level'], string> = {
    info: 'border-l-sky-500 text-slate-200',
    warn: 'border-l-amber-400 text-amber-100',
    error: 'border-l-red-500 text-red-100',
    debug: 'border-l-slate-500 text-slate-300',
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

export default function ActivityPanel(): JSX.Element {
    const { activity, telemetry } = useStudioState();
    const entries = activity.slice(-40).reverse();

    return (
        <section className="flex h-full flex-col overflow-hidden rounded-lg border border-white/10 bg-studio-panel">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
                <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-studio-muted">Operator Activity</h2>
                <span className="text-xs text-studio-muted">{activity.length}</span>
            </div>

            <div className="grid grid-cols-2 gap-2 border-b border-white/5 px-4 py-2 text-[11px] text-studio-muted xl:grid-cols-4">
                <span>Uptime: <strong className="text-slate-200">{formatUptime(telemetry.uptimeMs)}</strong></span>
                <span>Clients: <strong className="text-slate-200">{telemetry.connectedClients ?? 0}</strong></span>
                <span>Tick: <strong className="text-slate-200">{telemetry.tick ?? 0}</strong></span>
                <span>Worker: <strong className="text-slate-200">{telemetry.workerStatus?.running ?? 0}/{telemetry.workerStatus?.pending ?? 0}</strong></span>
            </div>

            <div className="flex-1 min-h-0 space-y-2 overflow-y-auto p-3">
                {entries.length === 0 && (
                    <div className="flex h-full items-center justify-center">
                        <p className="text-xs text-studio-muted">Status requests, tunnel events, and command feedback appear here.</p>
                    </div>
                )}

                {entries.map((entry) => (
                    <div key={entry.id} className={`rounded-md border-l-2 bg-white/[0.03] px-3 py-2 text-xs ${LEVEL_STYLES[entry.level]}`}>
                        <div className="flex items-start justify-between gap-2">
                            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-studio-muted">
                                {entry.source}
                            </span>
                            <span className="text-[10px] text-studio-muted">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                        </div>
                        <div className="mt-1 break-words">{entry.message}</div>
                        {entry.detail && <div className="mt-1 text-[10px] text-studio-muted">{entry.detail}</div>}
                    </div>
                ))}
            </div>
        </section>
    );
}