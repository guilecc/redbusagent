import { useEffect, useState } from 'react';
import StatusBar from './StatusBar';
import ForgePanel from './ForgePanel';
import SkillLibrary from './SkillLibrary';
import ChatPanel from './ChatPanel';
import ThoughtStreamPanel from './ThoughtStreamPanel';
import ActivityPanel from './ActivityPanel';
import ConnectionManager from './ConnectionManager';
import YieldModal from './YieldModal';
import { useStudioBridge } from '../hooks/useStudioBridge';
import { useStudioState } from '../hooks/useStudioStore';
import {
    normalizeStudioSettings,
    type StudioRouteMode,
    type StudioSettings,
    type StudioTunnelConfig,
    type YieldRespondCommand,
} from '@redbusagent/shared/studio';

const ROUTE_MODES: StudioRouteMode[] = ['auto', 'live', 'cloud'];

const ROUTE_MODE_LABELS: Record<StudioRouteMode, string> = {
    auto: 'Auto-route',
    live: 'Live',
    cloud: 'Cloud',
};

export default function StudioShell(): JSX.Element {
    const { sendChat, respondToYield, connect, disconnect, requestStatus, saveSettings, refreshSkills } = useStudioBridge();
    const { session, settings, yieldRequest, forge } = useStudioState();
    const isConnected = session.connection === 'connected';
    const isConnecting = session.connection === 'connecting';
    const [yieldPending, setYieldPending] = useState(false);
    const [leftView, setLeftView] = useState<'forge' | 'library'>('forge');

    useEffect(() => {
        if (forge.status === 'executing' || forge.status === 'streaming') {
            setLeftView('forge');
        }
    }, [forge.status]);

    const handleConnect = async (profileId: string | undefined, tunnel: StudioTunnelConfig) => {
        await connect(profileId, tunnel);
    };

    const handleSaveSettings = async (nextSettings: StudioSettings) => {
        await saveSettings(normalizeStudioSettings(nextSettings));
    };

    const handleRouteModeChange = async (defaultRouteMode: StudioRouteMode) => {
        await saveSettings({ ...settings, defaultRouteMode });
    };

    const handleYieldRespond = async (payload: YieldRespondCommand['payload']) => {
        setYieldPending(true);

        try {
            await respondToYield(payload.yieldId, payload.decision, payload.note);
        } finally {
            setYieldPending(false);
        }
    };

    return (
        <div className="flex h-screen flex-col bg-studio-bg text-slate-100">
            <StatusBar />

            <div className="border-b border-white/5 px-4 py-2">
                <div className="flex flex-wrap items-start gap-3">
                    <ConnectionManager
                        isConnecting={isConnecting}
                        onConnect={handleConnect}
                        onSaveSettings={handleSaveSettings}
                        session={session}
                        settings={settings}
                    />

                    <div className="flex min-w-[240px] flex-1 flex-wrap items-center justify-end gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-2">
                        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-studio-muted">Routing</span>
                        {ROUTE_MODES.map((mode) => {
                            const active = settings.defaultRouteMode === mode;
                            return (
                                <button
                                    key={mode}
                                    className={`rounded px-3 py-1.5 text-xs transition ${active ? 'bg-studio-accent text-white' : 'border border-white/10 text-slate-300 hover:bg-white/5'}`}
                                    onClick={() => void handleRouteModeChange(mode)}
                                    type="button"
                                >
                                    {ROUTE_MODE_LABELS[mode]}
                                </button>
                            );
                        })}

                        <button
                            className="rounded border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-40"
                            disabled={!isConnected}
                            onClick={() => void requestStatus()}
                            type="button"
                        >
                            Request status
                        </button>

                        {isConnected && (
                            <button
                                className="rounded border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
                                onClick={() => void disconnect()}
                                type="button"
                            >
                                Disconnect
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <div className="flex flex-1 min-h-0 gap-1 p-1">
                <div className="flex w-[28%] min-w-[280px] flex-col gap-1">
                    <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-studio-panel p-1 text-xs">
                        <button
                            className={`flex-1 rounded px-3 py-1.5 ${leftView === 'forge' ? 'bg-white/10 text-white' : 'text-studio-muted hover:bg-white/5'}`}
                            onClick={() => setLeftView('forge')}
                            type="button"
                        >
                            Forge
                        </button>
                        <button
                            className={`flex-1 rounded px-3 py-1.5 ${leftView === 'library' ? 'bg-white/10 text-white' : 'text-studio-muted hover:bg-white/5'}`}
                            onClick={() => setLeftView('library')}
                            type="button"
                        >
                            Skill Library
                        </button>
                    </div>

                    <div className="min-h-0 flex-1">
                        {leftView === 'forge' ? (
                            <ForgePanel />
                        ) : (
                            <SkillLibrary onRefresh={() => void refreshSkills()} refreshDisabled={!isConnected} />
                        )}
                    </div>
                </div>

                <div className="flex-1 min-w-[320px]">
                    <ChatPanel onSend={sendChat} />
                </div>

                <div className="flex w-[28%] min-w-[280px] flex-col gap-1">
                    <div className="h-[42%] min-h-[220px]">
                        <ActivityPanel />
                    </div>
                    <div className="min-h-0 flex-1">
                        <ThoughtStreamPanel />
                    </div>
                </div>
            </div>

            <YieldModal onRespond={handleYieldRespond} pending={yieldPending} request={yieldRequest} />
        </div>
    );
}

