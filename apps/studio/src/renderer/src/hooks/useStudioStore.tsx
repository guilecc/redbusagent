import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react';
import {
    DEFAULT_STUDIO_SETTINGS,
    normalizeStudioSettings,
    type StudioForgeSnapshot,
    type StudioForgedSkill,
    type StudioSessionState,
    type StudioSettings,
    type StudioTelemetrySnapshot,
    type StudioYieldRequest,
} from '@redbusagent/shared/studio';

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
    kind: 'thought' | 'toolCall' | 'toolResult';
    text: string;
    status?: string;
    timestamp: number;
}

export interface ActivityEntry {
    id: string;
    level: 'info' | 'warn' | 'error' | 'debug';
    source: string;
    message: string;
    detail?: string;
    timestamp: number;
}

export interface StudioState {
    session: StudioSessionState;
    settings: StudioSettings;
    telemetry: StudioTelemetrySnapshot;
    forge: StudioForgeSnapshot;
    library: {
        status: 'idle' | 'loading' | 'ready' | 'error';
        skills: readonly StudioForgedSkill[];
        error?: string;
        lastLoadedAt?: number;
    };
    chat: ChatMessage[];
    thoughts: ThoughtEntry[];
    activity: ActivityEntry[];
    yieldRequest: StudioYieldRequest | null;
}

export const INITIAL_STATE: StudioState = {
    session: { connection: 'disconnected', tunnel: 'idle', daemon: 'disconnected' },
    settings: DEFAULT_STUDIO_SETTINGS,
    telemetry: {},
    forge: { status: 'idle' },
    library: { status: 'idle', skills: [] },
    chat: [],
    thoughts: [],
    activity: [],
    yieldRequest: null,
};

export type StudioAction =
    | { type: 'SET_SESSION'; payload: StudioSessionState }
    | { type: 'SET_SETTINGS'; payload: StudioSettings }
    | { type: 'SET_TELEMETRY'; payload: StudioTelemetrySnapshot }
    | { type: 'SET_FORGE'; payload: StudioForgeSnapshot }
    | { type: 'SET_LIBRARY_LOADING' }
    | { type: 'SET_LIBRARY'; payload: { skills: readonly StudioForgedSkill[]; loadedAt: number } }
    | { type: 'SET_LIBRARY_ERROR'; payload: string }
    | { type: 'ADD_CHAT'; payload: ChatMessage }
    | { type: 'UPDATE_STREAMING'; payload: { id: string; delta: string } }
    | { type: 'FINISH_STREAMING'; payload: { id: string; fullText: string; tier?: string; model?: string } }
    | { type: 'ADD_THOUGHT'; payload: ThoughtEntry }
    | { type: 'ADD_ACTIVITY'; payload: ActivityEntry }
    | { type: 'SET_YIELD'; payload: StudioYieldRequest | null };

export function studioReducer(state: StudioState, action: StudioAction): StudioState {
    switch (action.type) {
        case 'SET_SESSION':
            return { ...state, session: action.payload };
        case 'SET_SETTINGS':
            return { ...state, settings: normalizeStudioSettings(action.payload) };
        case 'SET_TELEMETRY':
            return { ...state, telemetry: { ...state.telemetry, ...action.payload } };
        case 'SET_FORGE':
            return { ...state, forge: action.payload };
        case 'SET_LIBRARY_LOADING':
            return {
                ...state,
                library: {
                    ...state.library,
                    status: 'loading',
                    error: undefined,
                },
            };
        case 'SET_LIBRARY':
            return {
                ...state,
                library: {
                    status: 'ready',
                    skills: action.payload.skills,
                    error: undefined,
                    lastLoadedAt: action.payload.loadedAt,
                },
            };
        case 'SET_LIBRARY_ERROR':
            return {
                ...state,
                library: {
                    ...state.library,
                    status: 'error',
                    error: action.payload,
                },
            };
        case 'ADD_CHAT':
            return { ...state, chat: [...state.chat, action.payload] };
        case 'UPDATE_STREAMING':
            return {
                ...state,
                chat: state.chat.map((message) =>
                    message.id === action.payload.id
                        ? { ...message, content: message.content + action.payload.delta }
                        : message,
                ),
            };
        case 'FINISH_STREAMING':
            return {
                ...state,
                chat: state.chat.map((message) =>
                    message.id === action.payload.id
                        ? {
                            ...message,
                            content: action.payload.fullText,
                            streaming: false,
                            tier: action.payload.tier,
                            model: action.payload.model,
                        }
                        : message,
                ),
            };
        case 'ADD_THOUGHT':
            return { ...state, thoughts: [...state.thoughts, action.payload].slice(-200) };
        case 'ADD_ACTIVITY':
            return { ...state, activity: [...state.activity, action.payload].slice(-200) };
        case 'SET_YIELD':
            return { ...state, yieldRequest: action.payload };
        default:
            return state;
    }
}

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

