import { useEffect, useCallback } from 'react';
import {
    type DaemonSkillsResponse,
    normalizeStudioSettings,
    STUDIO_IPC_VERSION,
    type StudioMainEvent,
    type StudioSettings,
    type StudioTunnelConfig,
} from '@redbusagent/shared/studio';
import { useStudioDispatch, useStudioState, type StudioAction } from './useStudioStore';

/**
 * Subscribes to the preload bridge and dispatches events into the store.
 * Also returns command helpers so components never touch window.redbusStudio directly.
 */
export function useStudioBridge() {
    const dispatch = useStudioDispatch();
    const { settings } = useStudioState();

    const invokeCommand = useCallback(
        async (command: Parameters<typeof window.redbusStudio.invoke>[0]) => {
            const result = await window.redbusStudio.invoke(command);
            if (!result.ok) {
                dispatch({
                    type: 'ADD_ACTIVITY',
                    payload: {
                        id: crypto.randomUUID(),
                        level: 'error',
                        source: 'Studio',
                        message: result.error,
                        timestamp: Date.now(),
                    },
                });
                throw new Error(result.error);
            }

            return result;
        },
        [dispatch],
    );

    const loadSkills = useCallback(async () => {
        dispatch({ type: 'SET_LIBRARY_LOADING' });

        try {
            const result = await invokeCommand({ version: STUDIO_IPC_VERSION, type: 'skills/list', payload: {} });
            if (result.ok && result.type === 'skills/list') {
                const data = result.data as DaemonSkillsResponse | undefined;
                dispatch({
                    type: 'SET_LIBRARY',
                    payload: {
                        skills: data?.skills ?? [],
                        loadedAt: Date.now(),
                    },
                });
            }
        } catch (error) {
            dispatch({
                type: 'SET_LIBRARY_ERROR',
                payload: error instanceof Error ? error.message : 'Failed to load forged skills.',
            });
        }
    }, [dispatch, invokeCommand]);

    // ─── Subscribe to main→renderer events ────────────────────────
    useEffect(() => {
        const handleEvent = (event: StudioMainEvent) => {
            if (event.type === 'daemon/forge' && event.payload.event === 'FORGE_SUCCESS') {
                void loadSkills();
            }

            for (const action of eventToActions(event)) {
                dispatch(action);
            }
        };

        // Load initial settings
        void invokeCommand({ version: STUDIO_IPC_VERSION, type: 'settings/load', payload: {} })
            .then((result) => {
                if (result.ok && result.type === 'settings/load') {
                    const data = result.data as { settings?: StudioSettings } | undefined;
                    if (data?.settings) {
                        dispatch({ type: 'SET_SETTINGS', payload: normalizeStudioSettings(data.settings) });
                    }
                }
            });

        return window.redbusStudio.subscribe(handleEvent);
    }, [dispatch, invokeCommand, loadSkills]);

    // ─── Command helpers ──────────────────────────────────────────
    const connect = useCallback(async (profileId: string | undefined, tunnel: StudioTunnelConfig) => {
        await invokeCommand({
            version: STUDIO_IPC_VERSION,
            type: 'session/connect',
            payload: { profileId, tunnel },
        });
        await loadSkills();
    }, [invokeCommand, loadSkills]);

    const disconnect = useCallback(async () => {
        await invokeCommand({
            version: STUDIO_IPC_VERSION,
            type: 'session/disconnect',
            payload: { reason: 'user' },
        });
    }, [invokeCommand]);

    const sendChat = useCallback(async (content: string) => {
        const requestId = crypto.randomUUID();
        const tier = settings.defaultRouteMode === 'auto' ? undefined : settings.defaultRouteMode;
        dispatch({
            type: 'ADD_CHAT',
            payload: { id: requestId, role: 'user', content, timestamp: Date.now() },
        });
        // Pre-create assistant message placeholder for streaming
        dispatch({
            type: 'ADD_CHAT',
            payload: { id: `${requestId}-reply`, role: 'assistant', content: '', streaming: true, timestamp: Date.now() },
        });
        await invokeCommand({
            version: STUDIO_IPC_VERSION,
            type: 'chat/send',
            payload: { requestId, content, tier },
        });
    }, [dispatch, invokeCommand, settings.defaultRouteMode]);

    const respondToYield = useCallback(
        async (yieldId: string, decision: 'allow-once' | 'allow-always' | 'deny' | 'submit', note?: string) => {
            await invokeCommand({
                version: STUDIO_IPC_VERSION,
                type: 'yield/respond',
                payload: { yieldId, decision, note },
            });
        },
        [invokeCommand],
    );

    const saveSettings = useCallback(async (nextSettings: StudioSettings) => {
        const normalized = normalizeStudioSettings(nextSettings);
        await invokeCommand({
            version: STUDIO_IPC_VERSION,
            type: 'settings/save',
            payload: { settings: normalized },
        });
        dispatch({ type: 'SET_SETTINGS', payload: normalized });
    }, [dispatch, invokeCommand]);

    const requestStatus = useCallback(async () => {
        await invokeCommand({
            version: STUDIO_IPC_VERSION,
            type: 'system/command',
            payload: { command: 'status' },
        });
    }, [invokeCommand]);

    return { connect, disconnect, sendChat, respondToYield, requestStatus, saveSettings, refreshSkills: loadSkills };
}

// ─── Map IPC events → store actions ──────────────────────────────

export function eventToActions(event: StudioMainEvent): StudioAction[] {
    switch (event.type) {
        case 'session/state':
            return [
                { type: 'SET_SESSION', payload: event.payload },
                ...(event.payload.error
                    ? [{
                        type: 'ADD_ACTIVITY' as const,
                        payload: {
                            id: crypto.randomUUID(),
                            level: 'error' as const,
                            source: 'Session',
                            message: event.payload.error,
                            timestamp: Date.now(),
                        },
                    }]
                    : []),
            ];
        case 'telemetry/update':
            return [{ type: 'SET_TELEMETRY', payload: event.payload }];
        case 'forge/update':
            return [{ type: 'SET_FORGE', payload: event.payload }];
        case 'daemon/forge': {
            const detail = event.payload.event === 'FORGE_ERROR'
                ? event.payload.error
                : event.payload.event === 'FORGE_SUCCESS'
                  ? event.payload.result
                  : event.payload.forgingReason ?? event.payload.description;

            return [{
                type: 'ADD_ACTIVITY',
                payload: {
                    id: crypto.randomUUID(),
                    level: event.payload.event === 'FORGE_ERROR' ? 'error' : 'info',
                    source: 'Forge',
                    message: `${event.payload.event}${event.payload.skillName ? ` · ${event.payload.skillName}` : ''}`,
                    detail,
                    timestamp: Date.now(),
                },
            }];
        }
        case 'daemon/streamChunk':
            return [{ type: 'UPDATE_STREAMING', payload: { id: `${event.payload.requestId}-reply`, delta: event.payload.delta } }];
        case 'daemon/streamDone':
            return [{ type: 'FINISH_STREAMING', payload: { id: `${event.payload.requestId}-reply`, fullText: event.payload.fullText, tier: event.payload.tier, model: event.payload.model } }];
        case 'daemon/thought':
            return [{ type: 'ADD_THOUGHT', payload: { id: crypto.randomUUID(), kind: 'thought', text: event.payload.text, status: event.payload.status, timestamp: Date.now() } }];
        case 'daemon/toolCall':
            return [{ type: 'ADD_THOUGHT', payload: { id: crypto.randomUUID(), kind: 'toolCall', text: `🔧 ${event.payload.toolName}`, timestamp: Date.now() } }];
        case 'daemon/toolResult':
            return [{ type: 'ADD_THOUGHT', payload: { id: crypto.randomUUID(), kind: 'toolResult', text: `${event.payload.success ? '✅' : '❌'} ${event.payload.toolName}: ${event.payload.result.slice(0, 200)}`, timestamp: Date.now() } }];
        case 'tunnel/log':
            return [{
                type: 'ADD_ACTIVITY',
                payload: {
                    id: crypto.randomUUID(),
                    level: event.payload.level,
                    source: event.payload.step ?? 'Tunnel',
                    message: event.payload.message,
                    detail: event.payload.localPort ? `Local ${event.payload.localPort} → Remote ${event.payload.remotePort ?? 'n/a'}` : undefined,
                    timestamp: Date.now(),
                },
            }];
        case 'operator/log':
            return [{
                type: 'ADD_ACTIVITY',
                payload: {
                    id: crypto.randomUUID(),
                    level: event.payload.level,
                    source: event.payload.source,
                    message: event.payload.message,
                    detail: event.payload.kind,
                    timestamp: Date.now(),
                },
            }];
        case 'yield/requested':
            return [
                { type: 'SET_YIELD', payload: event.payload },
                {
                    type: 'ADD_ACTIVITY',
                    payload: {
                        id: crypto.randomUUID(),
                        level: 'warn',
                        source: 'Yield',
                        message: event.payload.title,
                        detail: event.payload.body,
                        timestamp: Date.now(),
                    },
                },
            ];
        case 'yield/resolved':
            return [
                { type: 'SET_YIELD', payload: null },
                {
                    type: 'ADD_ACTIVITY',
                    payload: {
                        id: crypto.randomUUID(),
                        level: event.payload.resolution === 'denied' ? 'error' : 'info',
                        source: 'Yield',
                        message: `Yield ${event.payload.yieldId} ${event.payload.resolution}`,
                        timestamp: Date.now(),
                    },
                },
            ];
        default:
            return [];
    }
}

