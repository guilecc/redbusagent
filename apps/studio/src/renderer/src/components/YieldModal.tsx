import { useEffect, useRef, useState, useCallback } from 'react';
import { useStudioState } from '../hooks/useStudioStore';
import type { StudioYieldRequest } from '@redbusagent/shared/studio';

interface YieldModalProps {
    onRespond: (yieldId: string, decision: 'allow-once' | 'allow-always' | 'deny' | 'submit', note?: string) => Promise<void>;
}

const KIND_LABELS: Record<StudioYieldRequest['kind'], string> = {
    approval: 'Tool Approval Required',
    question: 'Agent Question',
    credential: 'Credential Request',
    confirmation: 'Confirmation Required',
};

export default function YieldModal({ onRespond }: YieldModalProps): JSX.Element | null {
    const { yieldRequest } = useStudioState();
    const [note, setNote] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const dialogRef = useRef<HTMLDivElement>(null);
    const firstFocusRef = useRef<HTMLTextAreaElement>(null);

    // Focus trap: focus textarea on open
    useEffect(() => {
        if (yieldRequest) {
            setNote('');
            setSubmitting(false);
            // Defer focus to next frame so DOM is ready
            requestAnimationFrame(() => firstFocusRef.current?.focus());
        }
    }, [yieldRequest?.yieldId]);

    // Trap focus inside modal
    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === 'Escape') return; // don't dismiss — must respond
            if (e.key !== 'Tab' || !dialogRef.current) return;

            const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
                'button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            );
            if (focusable.length === 0) return;

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!first || !last) return;

            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        },
        [],
    );

    const respond = async (decision: 'allow-once' | 'allow-always' | 'deny' | 'submit') => {
        if (!yieldRequest || submitting) return;
        setSubmitting(true);
        try {
            await onRespond(yieldRequest.yieldId, decision, note || undefined);
        } finally {
            setSubmitting(false);
        }
    };

    if (!yieldRequest) return null;

    const isApproval = yieldRequest.kind === 'approval' || yieldRequest.kind === 'confirmation';

    return (
        // Backdrop — blocks interaction
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
            aria-modal="true"
            role="dialog"
            aria-labelledby="yield-title"
            aria-describedby="yield-body"
        >
            <div
                ref={dialogRef}
                onKeyDown={handleKeyDown}
                className="mx-4 w-full max-w-lg rounded-2xl border border-white/10 bg-studio-panel shadow-2xl shadow-black/50"
            >
                {/* Header */}
                <div className="border-b border-white/10 px-6 py-4">
                    <p className="text-xs font-semibold uppercase tracking-widest text-amber-400">
                        {KIND_LABELS[yieldRequest.kind]}
                    </p>
                    <h2 id="yield-title" className="mt-1 text-lg font-semibold text-slate-100">
                        {yieldRequest.title}
                    </h2>
                </div>

                {/* Body */}
                <div id="yield-body" className="max-h-60 overflow-y-auto px-6 py-4 text-sm text-slate-300 whitespace-pre-wrap">
                    {yieldRequest.body}
                    {yieldRequest.approval && (
                        <div className="mt-3 rounded-lg bg-white/5 p-3 text-xs">
                            <p><strong>Tool:</strong> {yieldRequest.approval.toolName}</p>
                            <p><strong>Reason:</strong> {yieldRequest.approval.reason}</p>
                            <p className="mt-1 text-studio-muted">{yieldRequest.approval.description}</p>
                        </div>
                    )}
                </div>

                {/* Freeform response */}
                <div className="px-6 pb-3">
                    <textarea
                        ref={firstFocusRef}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        disabled={submitting}
                        placeholder="Optional: add context or instructions…"
                        rows={2}
                        className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-studio-accent/50 disabled:opacity-50 resize-none"
                    />
                </div>

                {/* Actions */}
                <div className="flex items-center justify-end gap-2 border-t border-white/10 px-6 py-4">
                    {isApproval ? (
                        <>
                            <button disabled={submitting} onClick={() => void respond('deny')} className="rounded-lg border border-white/15 px-4 py-2 text-sm text-slate-300 hover:bg-white/5 disabled:opacity-40">
                                Deny
                            </button>
                            <button disabled={submitting} onClick={() => void respond('allow-once')} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40">
                                Allow Once
                            </button>
                            <button disabled={submitting} onClick={() => void respond('allow-always')} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-40">
                                Allow Always
                            </button>
                        </>
                    ) : (
                        <button disabled={submitting} onClick={() => void respond('submit')} className="rounded-lg bg-studio-accent px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-40">
                            Submit Response
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

