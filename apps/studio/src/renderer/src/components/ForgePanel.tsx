import Editor from '@monaco-editor/react';
import { useStudioState } from '../hooks/useStudioStore';

const FORGE_PLACEHOLDER = `// Redbus Studio — Forge Visualizer
// 
// This panel displays the active file content
// streamed from the daemon's Forge toolchain.
//
// Connect to a remote host to see live code here.
`;

export default function ForgePanel(): JSX.Element {
    const { forge } = useStudioState();

    const statusColor =
        forge.status === 'error'
            ? 'text-red-400'
            : forge.status === 'idle'
              ? 'text-studio-muted'
              : 'text-blue-400';

    return (
        <section className="flex h-full flex-col overflow-hidden rounded-lg border border-white/10 bg-studio-panel">
            {/* Panel header */}
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
                <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-studio-muted">
                    Forge
                </h2>
                <div className="flex items-center gap-2 text-xs">
                    <span className={statusColor}>{forge.status}</span>
                    {forge.selectedTool && (
                        <span className="rounded bg-white/5 px-1.5 py-0.5 text-studio-muted">
                            🔧 {forge.selectedTool}
                        </span>
                    )}
                </div>
            </div>

            {/* Active file indicator */}
            {forge.activeFile && (
                <div className="border-b border-white/5 bg-white/[0.02] px-4 py-1.5 text-xs text-slate-300">
                    📄 {forge.activeFile}
                </div>
            )}

            {/* Summary strip */}
            {forge.summary && (
                <div className="border-b border-white/5 bg-white/[0.02] px-4 py-1.5 text-xs text-studio-muted">
                    {forge.summary}
                </div>
            )}

            {/* Monaco editor */}
            <div className="flex-1 min-h-0">
                <Editor
                    height="100%"
                    defaultLanguage="typescript"
                    theme="vs-dark"
                    value={FORGE_PLACEHOLDER}
                    options={{
                        readOnly: true,
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        fontSize: 13,
                        lineNumbers: 'on',
                        wordWrap: 'on',
                        renderLineHighlight: 'none',
                        overviewRulerLanes: 0,
                        hideCursorInOverviewRuler: true,
                        contextmenu: false,
                        scrollbar: {
                            vertical: 'auto',
                            horizontal: 'auto',
                        },
                    }}
                />
            </div>
        </section>
    );
}

