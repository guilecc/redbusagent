import { useEffect, useMemo, useState } from 'react';
import type { StudioSessionState, StudioSettings, StudioTunnelConfig } from '@redbusagent/shared/studio';
import {
    DEFAULT_CONNECTION_DRAFT,
    buildProfileFromDraft,
    draftFromProfile,
    parseConnectionDraft,
    removeProfile,
    type ConnectionDraft,
    upsertProfile,
} from './connectionProfilesModel';

interface ConnectionManagerProps {
    settings: StudioSettings;
    session: StudioSessionState;
    isConnecting: boolean;
    onConnect: (profileId: string | undefined, tunnel: StudioTunnelConfig) => Promise<void>;
    onSaveSettings: (settings: StudioSettings) => Promise<void>;
}

export default function ConnectionManager({
    settings,
    session,
    isConnecting,
    onConnect,
    onSaveSettings,
}: ConnectionManagerProps): JSX.Element {
    const [isExpanded, setIsExpanded] = useState(settings.profiles.length === 0);
    const [selectedProfileId, setSelectedProfileId] = useState(settings.lastProfileId ?? settings.profiles[0]?.id ?? '');
    const [draft, setDraft] = useState<ConnectionDraft>(() =>
        draftFromProfile(settings.profiles.find((profile) => profile.id === (settings.lastProfileId ?? settings.profiles[0]?.id))),
    );
    const [errors, setErrors] = useState<string[]>([]);

    useEffect(() => {
        if (settings.profiles.length === 0) {
            setSelectedProfileId('');
            setDraft(DEFAULT_CONNECTION_DRAFT);
            setIsExpanded(true);
            return;
        }

        const hasSelected = settings.profiles.some((profile) => profile.id === selectedProfileId);
        if (hasSelected) {
            return;
        }

        const fallbackId = settings.lastProfileId && settings.profiles.some((profile) => profile.id === settings.lastProfileId)
            ? settings.lastProfileId
            : settings.profiles[0]?.id ?? '';
        setSelectedProfileId(fallbackId);
        setDraft(draftFromProfile(settings.profiles.find((profile) => profile.id === fallbackId)));
    }, [selectedProfileId, settings.lastProfileId, settings.profiles]);

    const selectedProfile = useMemo(
        () => settings.profiles.find((profile) => profile.id === selectedProfileId),
        [selectedProfileId, settings.profiles],
    );

    const updateDraft = (field: keyof ConnectionDraft, value: string) => {
        setDraft((current) => ({ ...current, [field]: value }));
        setErrors([]);
    };

    const handleSelectProfile = (profileId: string) => {
        setSelectedProfileId(profileId);
        setDraft(draftFromProfile(settings.profiles.find((profile) => profile.id === profileId)));
        setErrors([]);
    };

    const handleSaveProfile = async () => {
        const parsed = parseConnectionDraft(draft, { requireLabel: true });
        if (parsed.errors.length > 0) {
            setErrors(parsed.errors);
            setIsExpanded(true);
            return;
        }

        const nextProfileId = selectedProfileId || crypto.randomUUID();
        const nextProfiles = upsertProfile(settings.profiles, buildProfileFromDraft(nextProfileId, draft));
        await onSaveSettings({
            ...settings,
            profiles: nextProfiles,
            lastProfileId: nextProfileId,
        });

        setSelectedProfileId(nextProfileId);
        setDraft(draftFromProfile(nextProfiles.find((profile) => profile.id === nextProfileId)));
        setErrors([]);
    };

    const handleDeleteProfile = async () => {
        if (!selectedProfileId) {
            setDraft(DEFAULT_CONNECTION_DRAFT);
            return;
        }

        const nextProfiles = removeProfile(settings.profiles, selectedProfileId);
        const nextLastProfileId = nextProfiles[0]?.id;
        await onSaveSettings({
            ...settings,
            profiles: nextProfiles,
            lastProfileId: nextLastProfileId,
        });

        setSelectedProfileId(nextLastProfileId ?? '');
        setDraft(draftFromProfile(nextProfiles[0]));
        setErrors([]);
    };

    const handleConnectSaved = async () => {
        if (!selectedProfile) {
            setIsExpanded(true);
            return;
        }

        await onSaveSettings({ ...settings, lastProfileId: selectedProfile.id });
        await onConnect(selectedProfile.id, selectedProfile.tunnel);
    };

    const handleConnectDraft = async () => {
        const parsed = parseConnectionDraft(draft, { requireLabel: false });
        if (parsed.errors.length > 0) {
            setErrors(parsed.errors);
            setIsExpanded(true);
            return;
        }

        const nextLastProfileId = selectedProfileId || settings.lastProfileId;
        if (nextLastProfileId !== settings.lastProfileId) {
            await onSaveSettings({ ...settings, lastProfileId: nextLastProfileId });
        }

        await onConnect(selectedProfileId || undefined, parsed.tunnel);
    };

    return (
        <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-[0.2em] text-studio-muted">Connections</span>

                <select
                    className="min-w-[220px] rounded border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-100 outline-none"
                    onChange={(event) => handleSelectProfile(event.target.value)}
                    value={selectedProfileId}
                >
                    <option value="">Ad-hoc connection</option>
                    {settings.profiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>{profile.label}</option>
                    ))}
                </select>

                <button
                    className="rounded bg-studio-accent/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-studio-accent disabled:opacity-40"
                    disabled={isConnecting || !selectedProfile}
                    onClick={() => void handleConnectSaved()}
                    type="button"
                >
                    {isConnecting ? 'Connecting…' : 'Connect saved'}
                </button>

                <button
                    className="rounded border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
                    onClick={() => setIsExpanded((current) => !current)}
                    type="button"
                >
                    {isExpanded ? 'Hide form' : 'Manage'}
                </button>

                {session.activeProfileId && (
                    <span className="rounded bg-emerald-500/15 px-2 py-1 text-[11px] text-emerald-300">
                        Active: {session.activeProfileId}
                    </span>
                )}
            </div>

            {isExpanded && (
                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                        <Field label="Profile name" value={draft.label} onChange={(value) => updateDraft('label', value)} />
                        <Field label="Host" value={draft.host} onChange={(value) => updateDraft('host', value)} />
                        <Field label="SSH port" value={draft.port} onChange={(value) => updateDraft('port', value)} />
                        <Field label="Username" value={draft.username} onChange={(value) => updateDraft('username', value)} />
                        <Field label="Private key path" value={draft.privateKeyPath} onChange={(value) => updateDraft('privateKeyPath', value)} />
                        <Field label="Passphrase (not saved)" type="password" value={draft.passphrase} onChange={(value) => updateDraft('passphrase', value)} />
                        <Field label="Daemon WS port" value={draft.daemonWsPort} onChange={(value) => updateDraft('daemonWsPort', value)} />
                        <Field label="Daemon API port" value={draft.daemonApiPort} onChange={(value) => updateDraft('daemonApiPort', value)} />
                        <Field label="Local WS port (optional)" value={draft.localWsPort} onChange={(value) => updateDraft('localWsPort', value)} />
                        <Field label="Local API port (optional)" value={draft.localApiPort} onChange={(value) => updateDraft('localApiPort', value)} />
                    </div>

                    {errors.length > 0 && (
                        <ul className="mt-3 space-y-1 text-xs text-red-300">
                            {errors.map((error) => (
                                <li key={error}>• {error}</li>
                            ))}
                        </ul>
                    )}

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                            className="rounded bg-studio-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                            disabled={isConnecting}
                            onClick={() => void handleConnectDraft()}
                            type="button"
                        >
                            Connect with current values
                        </button>
                        <button
                            className="rounded border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
                            onClick={() => void handleSaveProfile()}
                            type="button"
                        >
                            {selectedProfileId ? 'Update profile' : 'Save profile'}
                        </button>
                        <button
                            className="rounded border border-red-500/40 px-3 py-1.5 text-xs text-red-200 hover:bg-red-500/10 disabled:opacity-40"
                            disabled={!selectedProfileId}
                            onClick={() => void handleDeleteProfile()}
                            type="button"
                        >
                            Delete profile
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

function Field({
    label,
    onChange,
    type = 'text',
    value,
}: {
    label: string;
    onChange: (value: string) => void;
    type?: string;
    value: string;
}) {
    return (
        <label className="flex flex-col gap-1 text-xs text-studio-muted">
            <span>{label}</span>
            <input
                className="rounded border border-white/10 bg-studio-bg px-3 py-2 text-sm text-slate-100 outline-none focus:border-studio-accent/60"
                onChange={(event) => onChange(event.target.value)}
                type={type}
                value={value}
            />
        </label>
    );
}