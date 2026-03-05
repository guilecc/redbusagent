import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { StudioYieldRequest, YieldRespondCommand } from '@redbusagent/shared/studio';
import {
    buildYieldDialogModel,
    formatApprovalReason,
    formatYieldExpiry,
    requiresYieldFreeformInput,
} from './yieldModalModel';

const FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    'a[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

interface YieldModalProps {
    readonly request: StudioYieldRequest | null;
    readonly pending?: boolean;
    readonly allowEscapeDismiss?: boolean;
    readonly onRespond: (payload: YieldRespondCommand['payload']) => Promise<void> | void;
    readonly onRequestClose?: () => void;
}

function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
    if (!container) {
        return [];
    }

    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true',
    );
}

function lockBackground(portalRoot: HTMLDivElement): () => void {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const restoreCallbacks = Array.from(document.body.children)
        .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== portalRoot)
        .map((element) => {
            const previousAriaHidden = element.getAttribute('aria-hidden');
            const hadInert = element.hasAttribute('inert');

            element.setAttribute('aria-hidden', 'true');
            element.setAttribute('inert', '');

            return () => {
                if (previousAriaHidden == null) {
                    element.removeAttribute('aria-hidden');
                } else {
                    element.setAttribute('aria-hidden', previousAriaHidden);
                }

                if (hadInert) {
                    element.setAttribute('inert', '');
                } else {
                    element.removeAttribute('inert');
                }
            };
        });

    return () => {
        document.body.style.overflow = previousOverflow;
        restoreCallbacks.reverse().forEach((restore) => restore());
    };
}

function focusPreferredElement(container: HTMLElement | null): void {
    if (!container) {
        return;
    }

    const preferred = container.querySelector<HTMLElement>('[data-autofocus="true"]');
    const fallback = getFocusableElements(container)[0] ?? container;
    (preferred ?? fallback).focus();
}

function getButtonClassName(tone: 'primary' | 'secondary' | 'danger'): string {
    switch (tone) {
        case 'primary':
            return 'bg-studio-accent text-white hover:bg-cyan-400';
        case 'secondary':
            return 'border border-white/15 bg-white/5 text-slate-100 hover:bg-white/10';
        case 'danger':
            return 'border border-red-400/25 bg-red-500/10 text-red-100 hover:bg-red-500/20';
        default:
            return '';
    }
}

export default function YieldModal({
    request,
    pending = false,
    allowEscapeDismiss = false,
    onRespond,
    onRequestClose,
}: YieldModalProps): JSX.Element | null {
    const [responseText, setResponseText] = useState('');
    const dialogRef = useRef<HTMLDivElement>(null);
    const restoreFocusRef = useRef<HTMLElement | null>(null);
    const titleId = useId();
    const descriptionId = useId();
    const portalRoot = useMemo(() => {
        if (typeof document === 'undefined') {
            return null;
        }

        const element = document.createElement('div');
        element.setAttribute('data-redbus-yield-modal-root', 'true');
        return element;
    }, []);

    useEffect(() => {
        setResponseText('');
    }, [request?.yieldId]);

    useEffect(() => {
        if (!request || !portalRoot) {
            return;
        }

        document.body.appendChild(portalRoot);
        restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const releaseBackground = lockBackground(portalRoot);

        queueMicrotask(() => {
            focusPreferredElement(dialogRef.current);
        });

        return () => {
            releaseBackground();
            portalRoot.remove();
            if (restoreFocusRef.current?.isConnected) {
                restoreFocusRef.current.focus();
            }
        };
    }, [portalRoot, request]);

    if (!request || !portalRoot) {
        return null;
    }

    const model = buildYieldDialogModel(request);
    const approvalReason = formatApprovalReason(request.approval?.reason);
    const expiryLabel = formatYieldExpiry(request.approval?.expiresAtMs);
    const responseValue = responseText.trim();

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            if (allowEscapeDismiss) {
                onRequestClose?.();
            }
            return;
        }

        if (event.key !== 'Tab') {
            return;
        }

        const focusableElements = getFocusableElements(dialogRef.current);
        if (focusableElements.length === 0) {
            event.preventDefault();
            dialogRef.current?.focus();
            return;
        }

        const currentTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const first = focusableElements[0];
        const last = focusableElements[focusableElements.length - 1];
        if (!first || !last) {
            return;
        }

        if (event.shiftKey && (currentTarget === first || !currentTarget || !dialogRef.current?.contains(currentTarget))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && currentTarget === last) {
            event.preventDefault();
            first.focus();
        }
    };

    const handleRespond = async (decision: YieldRespondCommand['payload']['decision']) => {
        const requiresInput = requiresYieldFreeformInput(model, decision);

        if (pending || (requiresInput && responseValue.length === 0)) {
            return;
        }

        await onRespond({
            yieldId: request.yieldId,
            decision,
            note: requiresInput ? responseValue : undefined,
        });
    };

    return createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6" onKeyDown={handleKeyDown}>
            <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" />
            <div
                aria-describedby={descriptionId}
                aria-labelledby={titleId}
                aria-modal="true"
                className="relative z-10 flex max-h-[min(92vh,48rem)] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#09101f] shadow-2xl shadow-black/60"
                ref={dialogRef}
                role="dialog"
                tabIndex={-1}
            >
                <div className="border-b border-white/10 bg-white/[0.03] px-6 py-5">
                    <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-300">{model.badge}</p>
                    <h2 className="mt-2 text-2xl font-semibold text-white" id={titleId}>
                        {request.title}
                    </h2>
                    <p className="mt-2 text-sm text-slate-300" id={descriptionId}>
                        {model.interruptionLabel}
                    </p>
                </div>

                <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
                    <section className="rounded-2xl border border-amber-400/15 bg-amber-400/10 p-4 text-sm text-amber-100">
                        <p className="font-medium">This interaction is blocking the current Studio run.</p>
                        <p className="mt-1 text-amber-100/80">Respond here to let the agent continue safely.</p>
                    </section>

                    <section className="space-y-3 text-sm text-slate-200">
                        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                            <p className="whitespace-pre-wrap leading-6 text-slate-200">{request.body}</p>
                        </div>

                        {request.approval ? (
                            <div className="grid gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:grid-cols-2">
                                <div>
                                    <p className="text-xs uppercase tracking-[0.18em] text-studio-muted">Tool</p>
                                    <p className="mt-1 font-medium text-white">{request.approval.toolName}</p>
                                </div>
                                {approvalReason ? (
                                    <div>
                                        <p className="text-xs uppercase tracking-[0.18em] text-studio-muted">Why approval is needed</p>
                                        <p className="mt-1 font-medium text-white">{approvalReason}</p>
                                    </div>
                                ) : null}
                                <div className="sm:col-span-2">
                                    <p className="text-xs uppercase tracking-[0.18em] text-studio-muted">Requested action</p>
                                    <p className="mt-1 text-slate-200">{request.approval.description}</p>
                                </div>
                                {expiryLabel ? (
                                    <div>
                                        <p className="text-xs uppercase tracking-[0.18em] text-studio-muted">Expiry</p>
                                        <p className="mt-1 text-slate-200">{expiryLabel}</p>
                                    </div>
                                ) : null}
                                {Object.keys(request.approval.args).length > 0 ? (
                                    <div className="sm:col-span-2">
                                        <p className="text-xs uppercase tracking-[0.18em] text-studio-muted">Arguments</p>
                                        <pre className="mt-2 max-h-40 overflow-auto rounded-xl bg-slate-950/70 p-3 text-xs text-slate-300">{JSON.stringify(request.approval.args, null, 2)}</pre>
                                    </div>
                                ) : null}
                            </div>
                        ) : null}

                        {model.responseLabel ? (
                            <label className="block" htmlFor={`${titleId}-response`}>
                                <span className="text-xs font-semibold uppercase tracking-[0.18em] text-studio-muted">{model.responseLabel}</span>
                                <textarea
                                    autoComplete="off"
                                    className="mt-2 min-h-32 w-full resize-y rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-studio-accent/60"
                                    data-autofocus="true"
                                    disabled={pending}
                                    id={`${titleId}-response`}
                                    onChange={(event) => setResponseText(event.target.value)}
                                    placeholder={model.responsePlaceholder ?? undefined}
                                    value={responseText}
                                />
                            </label>
                        ) : null}
                    </section>
                </div>

                <div className="flex flex-col gap-3 border-t border-white/10 bg-white/[0.03] px-6 py-4 sm:flex-row sm:items-center sm:justify-end">
                    {model.actions.map((action, index) => {
                        const isPrimaryAction = model.responseRequired
                            ? action.decision === 'submit'
                            : action.decision === 'allow-once';

                        return (
                            <button
                                className={`rounded-xl px-4 py-2.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${getButtonClassName(action.tone)}`}
                                data-autofocus={isPrimaryAction && !model.responseRequired ? 'true' : undefined}
                                disabled={pending || (requiresYieldFreeformInput(model, action.decision) && responseValue.length === 0)}
                                key={`${action.decision}-${index}`}
                                onClick={() => void handleRespond(action.decision)}
                                type="button"
                            >
                                {pending && isPrimaryAction ? 'Sending…' : action.label}
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>,
        portalRoot,
    );
}