import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react';
import type {
    StudioSessionState,
    StudioSettings,
    StudioTelemetrySnapshot,
    StudioForgeSnapshot,
    StudioYieldRequest,
} from '@redbusagent/shared/studio';

// ─── Local UI types ───────────────────────────────────────────────

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    streaming?: boolean;
    tier?: string;
    model?: string;
    timestamp: number;
}

export interface ThoughtEntry {
    id: string;
    kind: 'thought' | 'toolCall' | 'toolResult' | 'tunnelLog';
    text: string;
    status?: string;
    timestamp: number;
}

// ─── State shape ──────────────────────────────────────────────────

export interface StudioState {
    session: StudioSessionState;
    settings: StudioSettings;
    telemetry: StudioTelemetrySnapshot;
    forge: StudioForgeSnapshot;
    chat: ChatMessage[];
    thoughts: ThoughtEntry[];
    yieldRequest: StudioYieldRequest | null;
}

export const INITIAL_STATE: StudioState = {
    session: { connection: 'disconnected', tunnel: 'idle', daemon: 'disconnected' },
    settings: { theme: 'system', openDevtoolsOnLaunch: false, profiles: [] },
    telemetry: {},
    forge: { status: 'idle' },
    chat: [],
    thoughts: [],
    yieldRequest: null,
};

// ─── Actions ──────────────────────────────────────────────────────

export type StudioAction =
    | { type: 'SET_SESSION'; payload: StudioSessionState }
    | { type: 'SET_SETTINGS'; payload: StudioSettings }
    | { type: 'SET_TELEMETRY'; payload: StudioTelemetrySnapshot }
    | { type: 'SET_FORGE'; payload: StudioForgeSnapshot }
    | { type: 'ADD_CHAT'; payload: ChatMessage }
    | { type: 'UPDATE_STREAMING'; payload: { id: string; delta: string } }
    | { type: 'FINISH_STREAMING'; payload: { id: string; fullText: string; tier?: string; model?: string } }
    | { type: 'ADD_THOUGHT'; payload: ThoughtEntry }
    | { type: 'SET_YIELD'; payload: StudioYieldRequest | null };

function studioReducer(state: StudioState, action: StudioAction): StudioState {
    switch (action.type) {
        case 'SET_SESSION':
            return { ...state, session: action.payload };
        case 'SET_SETTINGS':
            return { ...state, settings: action.payload };
        case 'SET_TELEMETRY':
            return { ...state, telemetry: action.payload };
        case 'SET_FORGE':
            return { ...state, forge: action.payload };
        case 'ADD_CHAT':
            return { ...state, chat: [...state.chat, action.payload] };
        case 'UPDATE_STREAMING':
            return {
                ...state,
                chat: state.chat.map((m) =>
                    m.id === action.payload.id
                        ? { ...m, content: m.content + action.payload.delta }
                        : m,
                ),
            };
        case 'FINISH_STREAMING':
            return {
                ...state,
                chat: state.chat.map((m) =>
                    m.id === action.payload.id
                        ? { ...m, content: action.payload.fullText, streaming: false, tier: action.payload.tier, model: action.payload.model }
                        : m,
                ),
            };
        case 'ADD_THOUGHT':
            return { ...state, thoughts: [...state.thoughts, action.payload].slice(-200) };
        case 'SET_YIELD':
            return { ...state, yieldRequest: action.payload };
        default:
            return state;
    }
}

// ─── Context ──────────────────────────────────────────────────────

const StudioStateCtx = createContext<StudioState>(INITIAL_STATE);
const StudioDispatchCtx = createContext<Dispatch<StudioAction>>(() => {});

export function StudioProvider({ children }: { children: ReactNode }): JSX.Element {
    const [state, dispatch] = useReducer(studioReducer, INITIAL_STATE);
    return (
        <StudioStateCtx.Provider value={state}>
            <StudioDispatchCtx.Provider value={dispatch}>{children}</StudioDispatchCtx.Provider>
        </StudioStateCtx.Provider>
    );
}

export function useStudioState(): StudioState {
    return useContext(StudioStateCtx);
}

export function useStudioDispatch(): Dispatch<StudioAction> {
    return useContext(StudioDispatchCtx);
}

