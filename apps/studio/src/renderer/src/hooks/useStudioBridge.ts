import { useEffect, useCallback } from 'react';
import {
    STUDIO_IPC_VERSION,
    type StudioMainEvent,
    type StudioSettings,
    type StudioTunnelConfig,
} from '@redbusagent/shared/studio';
import { useStudioDispatch, type StudioAction } from './useStudioStore';

/**
 * Subscribes to the preload bridge and dispatches events into the store.
 * Also returns command helpers so components never touch window.redbusStudio directly.
 */
export function useStudioBridge() {
    const dispatch = useStudioDispatch();

    // ─── Subscribe to main→renderer events ────────────────────────
    useEffect(() => {
        const handleEvent = (event: StudioMainEvent) => {
            const action = eventToAction(event);
            if (action) dispatch(action);
        };

        // Load initial settings
        void window.redbusStudio
            .invoke({ version: STUDIO_IPC_VERSION, type: 'settings/load', payload: {} })
            .then((result) => {
                if (result.ok && result.type === 'settings/load') {
                    const data = result.data as { settings?: StudioSettings } | undefined;
                    if (data?.settings) {
                        dispatch({ type: 'SET_SETTINGS', payload: data.settings });
                    }
                }
            });

        return window.redbusStudio.subscribe(handleEvent);
    }, [dispatch]);

    // ─── Command helpers ──────────────────────────────────────────
    const connect = useCallback(async (profileId: string, tunnel: StudioTunnelConfig) => {
        await window.redbusStudio.invoke({
            version: STUDIO_IPC_VERSION,
            type: 'session/connect',
            payload: { profileId, tunnel },
        });
    }, []);

    const disconnect = useCallback(async () => {
        await window.redbusStudio.invoke({
            version: STUDIO_IPC_VERSION,
            type: 'session/disconnect',
            payload: { reason: 'user' },
        });
    }, []);

    const sendChat = useCallback(async (content: string) => {
        const requestId = crypto.randomUUID();
        dispatch({
            type: 'ADD_CHAT',
            payload: { id: requestId, role: 'user', content, timestamp: Date.now() },
        });
        // Pre-create assistant message placeholder for streaming
        dispatch({
            type: 'ADD_CHAT',
            payload: { id: `${requestId}-reply`, role: 'assistant', content: '', streaming: true, timestamp: Date.now() },
        });
        await window.redbusStudio.invoke({
            version: STUDIO_IPC_VERSION,
            type: 'chat/send',
            payload: { requestId, content },
        });
    }, [dispatch]);

    const respondToYield = useCallback(
        async (yieldId: string, decision: 'allow-once' | 'allow-always' | 'deny' | 'submit', note?: string) => {
            await window.redbusStudio.invoke({
                version: STUDIO_IPC_VERSION,
                type: 'yield/respond',
                payload: { yieldId, decision, note },
            });
        },
        [],
    );

    return { connect, disconnect, sendChat, respondToYield };
}

// ─── Map IPC events → store actions ──────────────────────────────

function eventToAction(event: StudioMainEvent): StudioAction | null {
    switch (event.type) {
        case 'session/state':
            return { type: 'SET_SESSION', payload: event.payload };
        case 'telemetry/update':
            return { type: 'SET_TELEMETRY', payload: event.payload };
        case 'forge/update':
            return { type: 'SET_FORGE', payload: event.payload };
        case 'daemon/streamChunk':
            return { type: 'UPDATE_STREAMING', payload: { id: `${event.payload.requestId}-reply`, delta: event.payload.delta } };
        case 'daemon/streamDone':
            return { type: 'FINISH_STREAMING', payload: { id: `${event.payload.requestId}-reply`, fullText: event.payload.fullText, tier: event.payload.tier, model: event.payload.model } };
        case 'daemon/thought':
            return { type: 'ADD_THOUGHT', payload: { id: crypto.randomUUID(), kind: 'thought', text: event.payload.text, status: event.payload.status, timestamp: Date.now() } };
        case 'daemon/toolCall':
            return { type: 'ADD_THOUGHT', payload: { id: crypto.randomUUID(), kind: 'toolCall', text: `🔧 ${event.payload.toolName}`, timestamp: Date.now() } };
        case 'daemon/toolResult':
            return { type: 'ADD_THOUGHT', payload: { id: crypto.randomUUID(), kind: 'toolResult', text: `${event.payload.success ? '✅' : '❌'} ${event.payload.toolName}: ${event.payload.result.slice(0, 200)}`, timestamp: Date.now() } };
        case 'tunnel/log':
            return { type: 'ADD_THOUGHT', payload: { id: crypto.randomUUID(), kind: 'tunnelLog', text: `[${event.payload.level}] ${event.payload.message}`, status: event.payload.step, timestamp: Date.now() } };
        case 'yield/requested':
            return { type: 'SET_YIELD', payload: event.payload };
        case 'yield/resolved':
            return { type: 'SET_YIELD', payload: null };
        default:
            return null;
    }
}

