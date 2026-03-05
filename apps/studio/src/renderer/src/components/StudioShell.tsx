import StatusBar from './StatusBar';
import ForgePanel from './ForgePanel';
import ChatPanel from './ChatPanel';
import ThoughtStreamPanel from './ThoughtStreamPanel';
import YieldModal from './YieldModal';
import { useStudioBridge } from '../hooks/useStudioBridge';
import { useStudioState } from '../hooks/useStudioStore';
import { STUDIO_IPC_VERSION } from '@redbusagent/shared/studio';

export default function StudioShell(): JSX.Element {
    const { sendChat, respondToYield, connect, disconnect } = useStudioBridge();
    const { session } = useStudioState();

    const isConnected = session.connection === 'connected';
    const isConnecting = session.connection === 'connecting';

    const handleQuickConnect = async () => {
        await connect('default', {
            host: 'example-host',
            port: 22,
            username: 'redbus',
            daemonWsPort: 8080,
            daemonApiPort: 8765,
            localWsPort: 18080,
            localApiPort: 18765,
        });
    };

    const handleTestYield = async () => {
        // Fire a simulated yield event for demo/testing purposes
        // In production this comes from main process; here we invoke a chat that triggers it
        await window.redbusStudio.invoke({
            version: STUDIO_IPC_VERSION,
            type: 'chat/send',
            payload: { requestId: crypto.randomUUID(), content: '[demo] trigger yield test' },
        });
    };

    return (
        <div className="flex h-screen flex-col bg-studio-bg text-slate-100">
            <StatusBar />

            {/* Connection toolbar */}
            <div className="flex items-center gap-2 border-b border-white/5 px-4 py-1.5">
                {!isConnected ? (
                    <button
                        onClick={() => void handleQuickConnect()}
                        disabled={isConnecting}
                        className="rounded bg-studio-accent/80 px-3 py-1 text-xs font-medium text-white hover:bg-studio-accent disabled:opacity-50"
                    >
                        {isConnecting ? 'Connecting…' : 'Quick Connect'}
                    </button>
                ) : (
                    <>
                        <button
                            onClick={() => void disconnect()}
                            className="rounded border border-white/15 px-3 py-1 text-xs text-slate-300 hover:bg-white/5"
                        >
                            Disconnect
                        </button>
                        <button
                            onClick={() => void handleTestYield()}
                            className="rounded border border-white/15 px-3 py-1 text-xs text-slate-300 hover:bg-white/5"
                        >
                            Test Yield
                        </button>
                    </>
                )}
            </div>

            {/* Three-column cockpit */}
            <div className="flex flex-1 min-h-0 gap-1 p-1">
                {/* Left: Forge Visualizer */}
                <div className="w-[30%] min-w-[280px]">
                    <ForgePanel />
                </div>

                {/* Center: Chat */}
                <div className="flex-1 min-w-[320px]">
                    <ChatPanel onSend={sendChat} />
                </div>

                {/* Right: Thought Stream */}
                <div className="w-[25%] min-w-[240px]">
                    <ThoughtStreamPanel />
                </div>
            </div>

            {/* Yield & Ask interception modal */}
            <YieldModal onRespond={respondToYield} />
        </div>
    );
}

