import { useEffect, useMemo, useState } from 'react';
import {
    STUDIO_IPC_VERSION,
    type StudioMainEvent,
    type StudioSessionState,
    type StudioSettings,
} from '@redbusagent/shared/studio';

const DISCONNECTED_STATE: StudioSessionState = {
    connection: 'disconnected',
    tunnel: 'idle',
    daemon: 'disconnected',
};

const DEFAULT_SETTINGS: StudioSettings = {
    theme: 'system',
    openDevtoolsOnLaunch: false,
    profiles: [],
};

export default function App(): JSX.Element {
    const [session, setSession] = useState<StudioSessionState>(DISCONNECTED_STATE);
    const [settings, setSettings] = useState<StudioSettings>(DEFAULT_SETTINGS);
    const [events, setEvents] = useState<StudioMainEvent[]>([]);

    useEffect(() => {
        void window.redbusStudio
            .invoke({ version: STUDIO_IPC_VERSION, type: 'settings/load', payload: {} })
            .then((result) => {
                if (result.ok && result.type === 'settings/load') {
                    const payload = result.data as { settings?: StudioSettings } | undefined;
                    if (payload?.settings) {
                        setSettings(payload.settings);
                    }
                }
            });

        return window.redbusStudio.subscribe((event) => {
            setEvents((current) => [event, ...current].slice(0, 12));
            if (event.type === 'session/state') {
                setSession(event.payload);
            }
        });
    }, []);

    const connectLabel = useMemo(() => `${session.connection} / ${session.tunnel}`, [session]);

    const handleConnect = async (): Promise<void> => {
        await window.redbusStudio.invoke({
            version: STUDIO_IPC_VERSION,
            type: 'session/connect',
            payload: {
                profileId: 'default',
                tunnel: {
                    host: 'example-host',
                    port: 22,
                    username: 'redbus',
                    daemonWsPort: 8080,
                    daemonApiPort: 8765,
                    localWsPort: 18080,
                    localApiPort: 18765,
                },
            },
        });
    };

    const handleSend = async (): Promise<void> => {
        await window.redbusStudio.invoke({
            version: STUDIO_IPC_VERSION,
            type: 'chat/send',
            payload: {
                requestId: crypto.randomUUID(),
                content: 'Wave 1 desktop shell scaffold check',
            },
        });
    };

    return (
        <main className="min-h-screen bg-studio-bg text-slate-100">
            <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-6 py-8">
                <header className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-2xl shadow-black/30">
                    <p className="text-sm uppercase tracking-[0.3em] text-studio-muted">Redbus Studio</p>
                    <h1 className="mt-2 text-3xl font-semibold">Wave 1 desktop shell scaffold</h1>
                    <p className="mt-3 max-w-3xl text-sm text-slate-300">
                        Electron main owns Node/SSH access, preload exposes the typed bridge, and the
                        renderer stays browser-safe.
                    </p>
                    <div className="mt-5 flex flex-wrap gap-3">
                        <button className="rounded-lg bg-studio-accent px-4 py-2 text-sm font-medium" onClick={() => void handleConnect()}>
                            Connect scaffold
                        </button>
                        <button className="rounded-lg border border-white/15 px-4 py-2 text-sm" onClick={() => void handleSend()}>
                            Send sample chat
                        </button>
                        <button
                            className="rounded-lg border border-white/15 px-4 py-2 text-sm"
                            onClick={() => void window.redbusStudio.invoke({ version: STUDIO_IPC_VERSION, type: 'session/disconnect', payload: { reason: 'user' } })}
                        >
                            Disconnect
                        </button>
                    </div>
                </header>

                <section className="grid flex-1 gap-4 lg:grid-cols-[1.1fr_1.6fr_1fr]">
                    <article className="rounded-2xl border border-white/10 bg-studio-panel p-5">
                        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-studio-muted">Forge</h2>
                        <p className="mt-4 text-sm text-slate-300">Monaco/editor tooling will land here in Wave 2.</p>
                    </article>
                    <article className="rounded-2xl border border-white/10 bg-studio-panel p-5">
                        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-studio-muted">Chat</h2>
                        <p className="mt-4 text-sm text-slate-300">Session status: {connectLabel}</p>
                        <p className="mt-2 text-sm text-slate-400">Theme preference: {settings.theme}</p>
                    </article>
                    <article className="rounded-2xl border border-white/10 bg-studio-panel p-5">
                        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-studio-muted">Thought stream</h2>
                        <ul className="mt-4 space-y-3 text-sm text-slate-300">
                            {events.length === 0 ? <li>No IPC events yet.</li> : null}
                            {events.map((event, index) => (
                                <li className="rounded-lg border border-white/5 bg-white/5 p-3" key={`${event.type}-${index}`}>
                                    <span className="font-medium text-white">{event.type}</span>
                                </li>
                            ))}
                        </ul>
                    </article>
                </section>
            </div>
        </main>
    );
}