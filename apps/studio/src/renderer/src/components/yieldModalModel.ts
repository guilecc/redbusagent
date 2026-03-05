import type { StudioYieldRequest, YieldRespondCommand } from '@redbusagent/shared/studio';

export type StudioYieldResponsePayload = YieldRespondCommand['payload'];
export type StudioYieldDecision = StudioYieldResponsePayload['decision'];

export interface YieldActionDescriptor {
    readonly decision: StudioYieldDecision;
    readonly label: string;
    readonly tone: 'primary' | 'secondary' | 'danger';
}

export interface YieldDialogModel {
    readonly badge: string;
    readonly interruptionLabel: string;
    readonly responseLabel: string | null;
    readonly responsePlaceholder: string | null;
    readonly responseRequired: boolean;
    readonly actions: readonly YieldActionDescriptor[];
}

export function requiresYieldFreeformInput(
    model: YieldDialogModel,
    decision: StudioYieldDecision,
): boolean {
    return model.responseRequired && decision === 'submit';
}

const KIND_BADGES: Record<StudioYieldRequest['kind'], string> = {
    approval: 'Approval required',
    confirmation: 'Confirmation required',
    question: 'Response requested',
    credential: 'Credential requested',
};

const APPROVAL_REASON_LABELS: Record<NonNullable<StudioYieldRequest['approval']>['reason'], string> = {
    destructive: 'Destructive action',
    intrusive: 'Intrusive action',
};

export function buildYieldDialogModel(request: StudioYieldRequest): YieldDialogModel {
    if (request.kind === 'question') {
        return {
            badge: KIND_BADGES.question,
            interruptionLabel: 'The session is paused until you send a response.',
            responseLabel: 'Your response',
            responsePlaceholder: 'Type the guidance you want Redbus Studio to send back…',
            responseRequired: true,
            actions: [
                { decision: 'deny', label: 'Decline', tone: 'danger' },
                { decision: 'submit', label: 'Send response', tone: 'primary' },
            ],
        };
    }

    if (request.kind === 'credential') {
        return {
            badge: KIND_BADGES.credential,
            interruptionLabel: 'The session is paused until you provide the requested secret.',
            responseLabel: 'Credential value',
            responsePlaceholder: 'Paste the credential or secret that should be submitted…',
            responseRequired: true,
            actions: [
                { decision: 'deny', label: 'Decline', tone: 'danger' },
                { decision: 'submit', label: 'Provide credential', tone: 'primary' },
            ],
        };
    }

    const actions: YieldActionDescriptor[] = [
        { decision: 'deny', label: 'Deny', tone: 'danger' },
        { decision: 'allow-once', label: request.kind === 'confirmation' ? 'Confirm once' : 'Allow once', tone: 'primary' },
    ];

    if (request.approval) {
        actions.push({ decision: 'allow-always', label: 'Always allow', tone: 'secondary' });
    }

    return {
        badge: KIND_BADGES[request.kind],
        interruptionLabel: 'The session is paused until you approve or deny this request.',
        responseLabel: null,
        responsePlaceholder: null,
        responseRequired: false,
        actions,
    };
}

export function formatApprovalReason(reason: NonNullable<StudioYieldRequest['approval']>['reason'] | undefined): string | null {
    return reason ? APPROVAL_REASON_LABELS[reason] : null;
}

export function formatYieldExpiry(expiresAtMs: number | undefined, now = Date.now()): string | null {
    if (!expiresAtMs) {
        return null;
    }

    const deltaSeconds = Math.max(0, Math.round((expiresAtMs - now) / 1000));

    if (deltaSeconds === 0) {
        return 'Expires now';
    }

    if (deltaSeconds < 60) {
        return `Expires in ${deltaSeconds}s`;
    }

    const minutes = Math.floor(deltaSeconds / 60);
    const seconds = deltaSeconds % 60;
    return seconds === 0 ? `Expires in ${minutes}m` : `Expires in ${minutes}m ${seconds}s`;
}