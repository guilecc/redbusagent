import { useMemo } from 'react';
import { useStudioState } from '../hooks/useStudioStore';

interface SkillLibraryProps {
    onRefresh: () => void;
    refreshDisabled?: boolean;
}

export default function SkillLibrary({ onRefresh, refreshDisabled = false }: SkillLibraryProps): JSX.Element {
    const { library } = useStudioState();

    const skills = useMemo(
        () => [...library.skills].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)),
        [library.skills],
    );

    return (
        <section className="flex h-full flex-col overflow-hidden rounded-lg border border-white/10 bg-studio-panel">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
                <div>
                    <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-studio-muted">Skill Library</h2>
                    <p className="mt-1 text-[11px] text-studio-muted">{skills.length} forged skill{skills.length === 1 ? '' : 's'}</p>
                </div>
                <button
                    className="rounded border border-white/15 px-2 py-1 text-[11px] text-slate-300 hover:bg-white/5 disabled:opacity-40"
                    disabled={refreshDisabled || library.status === 'loading'}
                    onClick={onRefresh}
                    type="button"
                >
                    {library.status === 'loading' ? 'Refreshing…' : 'Refresh'}
                </button>
            </div>

            {library.error && (
                <div className="border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-xs text-red-200">{library.error}</div>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto p-3">
                {skills.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-center text-xs text-studio-muted">
                        <p>{library.status === 'loading' ? 'Loading forged skills…' : 'Connect to a daemon and forge a skill to populate the library.'}</p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {skills.map((skill) => (
                            <article key={`${skill.skillName}-${skill.createdAt}`} className="rounded-lg border border-white/10 bg-black/10 p-3">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h3 className="text-sm font-semibold text-white">{skill.name}</h3>
                                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase text-studio-muted">{skill.language}</span>
                                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase text-studio-muted">{skill.source}</span>
                                </div>
                                <p className="mt-1 text-xs text-slate-300">{skill.description}</p>
                                <dl className="mt-3 space-y-2 text-[11px] text-studio-muted">
                                    <div>
                                        <dt className="font-semibold uppercase tracking-wide">Tool</dt>
                                        <dd>{skill.toolName}</dd>
                                    </div>
                                    <div>
                                        <dt className="font-semibold uppercase tracking-wide">Skill</dt>
                                        <dd>{skill.skillName}</dd>
                                    </div>
                                    <div>
                                        <dt className="font-semibold uppercase tracking-wide">Created</dt>
                                        <dd>{new Date(skill.createdAt).toLocaleString()}</dd>
                                    </div>
                                    {skill.forgingReason && (
                                        <div>
                                            <dt className="font-semibold uppercase tracking-wide text-amber-200">Forging reason</dt>
                                            <dd className="text-slate-200">{skill.forgingReason}</dd>
                                        </div>
                                    )}
                                </dl>
                            </article>
                        ))}
                    </div>
                )}
            </div>
        </section>
    );
}