import { useRef, useEffect } from 'react';
import { useStudioState, type ThoughtEntry } from '../hooks/useStudioStore';

const KIND_STYLES: Record<ThoughtEntry['kind'], { icon: string; color: string }> = {
    thought: { icon: '💭', color: 'border-l-purple-500' },
    toolCall: { icon: '🔧', color: 'border-l-blue-500' },
    toolResult: { icon: '📋', color: 'border-l-emerald-500' },
};

function ThoughtItem({ entry }: { entry: ThoughtEntry }) {
    const style = KIND_STYLES[entry.kind];
    return (
        <div className={`border-l-2 ${style.color} bg-white/[0.03] px-3 py-2 text-xs`}>
            <div className="flex items-start gap-1.5">
                <span>{style.icon}</span>
                <span className="flex-1 text-slate-300 break-words">{entry.text}</span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[10px] text-studio-muted">
                {entry.status && <span className="rounded bg-white/5 px-1">{entry.status}</span>}
                <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
            </div>
        </div>
    );
}

export default function ThoughtStreamPanel(): JSX.Element {
    const { thoughts, telemetry } = useStudioState();
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, [thoughts.length]);

    const workerStatus = telemetry.workerStatus;

    return (
        <section className="flex h-full flex-col overflow-hidden rounded-lg border border-white/10 bg-studio-panel">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
                <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-studio-muted">
                    Thought Stream
                </h2>
                <span className="text-xs text-studio-muted">{thoughts.length}</span>
            </div>

            {/* Worker queue status */}
            {workerStatus?.enabled && (
                <div className="flex items-center gap-3 border-b border-white/5 px-4 py-1.5 text-[10px] text-studio-muted">
                    <span>Worker: {workerStatus.model}</span>
                    <span>P:{workerStatus.pending} R:{workerStatus.running} ✓:{workerStatus.completed} ✗:{workerStatus.failed}</span>
                </div>
            )}

            {/* Stream */}
            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto space-y-1 p-2">
                {thoughts.length === 0 && (
                    <div className="flex h-full items-center justify-center">
                        <p className="text-xs text-studio-muted">No activity yet.</p>
                    </div>
                )}
                {thoughts.map((entry) => (
                    <ThoughtItem key={entry.id} entry={entry} />
                ))}
            </div>
        </section>
    );
}

