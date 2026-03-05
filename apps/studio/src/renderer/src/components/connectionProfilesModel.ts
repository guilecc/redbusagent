import type { StudioConnectionProfile, StudioTunnelConfig } from '@redbusagent/shared/studio';

const DEFAULT_STUDIO_SSH_PORT = 22;
const DEFAULT_DAEMON_WS_PORT = 6600;
const DEFAULT_DAEMON_API_PORT = 8765;

export interface ConnectionDraft {
    label: string;
    host: string;
    port: string;
    username: string;
    privateKeyPath: string;
    passphrase: string;
    daemonWsPort: string;
    daemonApiPort: string;
    localWsPort: string;
    localApiPort: string;
}

export const DEFAULT_CONNECTION_DRAFT: ConnectionDraft = {
    label: '',
    host: '',
    port: String(DEFAULT_STUDIO_SSH_PORT),
    username: '',
    privateKeyPath: '',
    passphrase: '',
    daemonWsPort: String(DEFAULT_DAEMON_WS_PORT),
    daemonApiPort: String(DEFAULT_DAEMON_API_PORT),
    localWsPort: '',
    localApiPort: '',
};

export function draftFromProfile(profile?: StudioConnectionProfile): ConnectionDraft {
    if (!profile) {
        return { ...DEFAULT_CONNECTION_DRAFT };
    }

    return {
        label: profile.label,
        host: profile.tunnel.host,
        port: String(profile.tunnel.port),
        username: profile.tunnel.username,
        privateKeyPath: profile.tunnel.privateKeyPath ?? '',
        passphrase: '',
        daemonWsPort: String(profile.tunnel.daemonWsPort),
        daemonApiPort: String(profile.tunnel.daemonApiPort),
        localWsPort: profile.tunnel.localWsPort == null ? '' : String(profile.tunnel.localWsPort),
        localApiPort: profile.tunnel.localApiPort == null ? '' : String(profile.tunnel.localApiPort),
    };
}

export function buildProfileFromDraft(id: string, draft: ConnectionDraft): StudioConnectionProfile {
    const parsed = parseConnectionDraft(draft, { requireLabel: true });
    return {
        id,
        label: draft.label.trim(),
        tunnel: {
            ...parsed.tunnel,
            passphrase: undefined,
        },
    };
}

export function upsertProfile(
    profiles: readonly StudioConnectionProfile[],
    profile: StudioConnectionProfile,
): StudioConnectionProfile[] {
    const existingIndex = profiles.findIndex((candidate) => candidate.id === profile.id);
    if (existingIndex === -1) {
        return [...profiles, profile];
    }

    return profiles.map((candidate) => (candidate.id === profile.id ? profile : candidate));
}

export function removeProfile(
    profiles: readonly StudioConnectionProfile[],
    profileId: string,
): StudioConnectionProfile[] {
    return profiles.filter((profile) => profile.id !== profileId);
}

export function parseConnectionDraft(
    draft: ConnectionDraft,
    options: { requireLabel: boolean },
): { tunnel: StudioTunnelConfig; errors: string[] } {
    const errors: string[] = [];
    const label = draft.label.trim();
    const host = draft.host.trim();
    const username = draft.username.trim();

    if (options.requireLabel && label.length === 0) {
        errors.push('Profile name is required to save a connection.');
    }
    if (host.length === 0) {
        errors.push('Host is required.');
    }
    if (username.length === 0) {
        errors.push('Username is required.');
    }

    const port = parsePort(draft.port, 'SSH port', errors, true);
    const daemonWsPort = parsePort(draft.daemonWsPort, 'Daemon WebSocket port', errors, true);
    const daemonApiPort = parsePort(draft.daemonApiPort, 'Daemon API port', errors, true);
    const localWsPort = parsePort(draft.localWsPort, 'Local WebSocket port', errors, false);
    const localApiPort = parsePort(draft.localApiPort, 'Local API port', errors, false);

    return {
        errors,
        tunnel: {
            host,
            port: port ?? DEFAULT_STUDIO_SSH_PORT,
            username,
            privateKeyPath: emptyToUndefined(draft.privateKeyPath),
            passphrase: emptyToUndefined(draft.passphrase),
            daemonWsPort: daemonWsPort ?? DEFAULT_DAEMON_WS_PORT,
            daemonApiPort: daemonApiPort ?? DEFAULT_DAEMON_API_PORT,
            localWsPort,
            localApiPort,
        },
    };
}

function emptyToUndefined(value: string): string | undefined {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
}

function parsePort(
    rawValue: string,
    label: string,
    errors: string[],
    required: boolean,
): number | undefined {
    const value = rawValue.trim();
    if (value.length === 0) {
        if (required) {
            errors.push(`${label} is required.`);
        }
        return undefined;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        errors.push(`${label} must be a whole number between 1 and 65535.`);
        return undefined;
    }

    return parsed;
}