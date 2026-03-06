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

    const statusBadgeClass =
        forge.status === 'error'
            ? 'border-red-500/30 bg-red-500/10 text-red-300'
            : forge.status === 'success'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : forge.status === 'idle'
                ? 'border-white/10 bg-white/5 text-studio-muted'
                : 'border-blue-500/30 bg-blue-500/10 text-blue-300';

    const editorLanguage = forge.language === 'python'
        ? 'python'
        : forge.language === 'javascript'
          ? 'javascript'
          : 'typescript';

    const editorValue = forge.content && forge.content.length > 0 ? forge.content : FORGE_PLACEHOLDER;

    return (
        <section className="flex h-full flex-col overflow-hidden rounded-lg border border-white/10 bg-studio-panel">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
                <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-studio-muted">
                    Forge
                </h2>
                <div className="flex items-center gap-2 text-xs">
                    <span className={`rounded border px-1.5 py-0.5 font-medium uppercase tracking-wide ${statusBadgeClass}`}>
                        {forge.event ?? forge.status}
                    </span>
                    {forge.selectedTool && (
                        <span className="rounded bg-white/5 px-1.5 py-0.5 text-studio-muted">
                            🔧 {forge.selectedTool}
                        </span>
                    )}
                </div>
            </div>

            {(forge.skillName || forge.activeFile) && (
                <div className="flex flex-wrap gap-2 border-b border-white/5 bg-white/[0.02] px-4 py-1.5 text-xs text-slate-300">
                    {forge.skillName && <span>🧠 {forge.skillName}</span>}
                    {forge.activeFile && <span>📄 {forge.activeFile}</span>}
                    {forge.language && <span className="rounded bg-white/5 px-1.5 py-0.5 uppercase">{forge.language}</span>}
                </div>
            )}

            {forge.forgingReason && (
                <div className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-200">Forging reason</p>
                    <p className="mt-1 text-xs text-amber-50">{forge.forgingReason}</p>
                </div>
            )}

            {forge.summary && (
                <div className="border-b border-white/5 bg-white/[0.02] px-4 py-1.5 text-xs text-studio-muted">
                    {forge.summary}
                </div>
            )}

            {forge.error && (
                <div className="border-b border-red-500/20 bg-red-500/10 px-4 py-1.5 text-xs text-red-200">
                    {forge.error}
                </div>
            )}

            {forge.result && forge.status === 'success' && (
                <div className="border-b border-emerald-500/20 bg-emerald-500/10 px-4 py-1.5 text-xs text-emerald-200">
                    {forge.result}
                </div>
            )}

            <div className="flex-1 min-h-0">
                <Editor
                    height="100%"
                    language={editorLanguage}
                    theme="vs-dark"
                    value={editorValue}
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

