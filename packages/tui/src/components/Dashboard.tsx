/**
 * @redbusagent/tui — Dashboard (Slim Orchestrator)
 *
 * Thin layout shell that composes modular sub-components:
 *   StatusBar  — daemon state, heartbeat, uptime
 *   ChatLog    — user/agent message history + streaming
 *   ApprovalGate — HITL Y/N interceptor (renders when BLOCKED_WAITING_USER)
 *   InputBox   — text input + slash command palette
 *   SystemLog  — compact daemon event log
 *
 * All rendering is delegated; Dashboard owns state, WebSocket lifecycle,
 * and message dispatch. Inspired by OpenClaw's modular TUI architecture.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import type {
    DaemonMessage,
    HeartbeatMessage,
    ChatRequestMessage,
    ApprovalRequestMessage,
} from '@redbusagent/shared';
import {
    APP_NAME,
    APP_VERSION,
    DEFAULT_HOST,
    DEFAULT_PORT,
    PersonaManager,
    Vault,
} from '@redbusagent/shared';
import { TuiWsClient } from '../infra/ws-client.js';
import { StatusBar } from './StatusBar.js';
import { ChatLog, MAX_CHAT_LINES } from './ChatLog.js';
import { SystemLog, MAX_LOG_ENTRIES } from './SystemLog.js';
import type { LogEntry } from './SystemLog.js';
import { ApprovalGate } from './ApprovalGate.js';
import { InputBox } from './InputBox.js';

// ─── Helpers ──────────────────────────────────────────────────────

function generateRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Formats tool arguments into a short human-readable summary for the chat log */
function formatToolArgs(toolName: string, args: Record<string, unknown>): string {
    try {
        // Common patterns: show the most relevant arg in a compact way
        if (args['url']) return `${args['url']}`;
        if (args['query']) return `"${String(args['query']).slice(0, 60)}"`;
        if (args['path']) return `${args['path']}`;
        if (args['message']) return `"${String(args['message']).slice(0, 60)}"`;
        if (args['input']) return `"${String(args['input']).slice(0, 60)}"`;
        if (args['command']) return `$ ${String(args['command']).slice(0, 60)}`;

        // Fallback: show first key=value pair
        const keys = Object.keys(args);
        if (keys.length === 0) return '';
        const first = keys[0]!;
        const val = String(args[first]).slice(0, 50);
        return `${first}: ${val}`;
    } catch {
        return '';
    }
}

/** Maps internal tier protocol values to user-friendly engine labels */
function tierToEngineLabel(tier: string): string {
    switch (tier) {
        case 'tier1': return 'Live Engine';
        case 'tier2': return 'Cloud Engine';
        case 'worker': return 'Worker Engine';
        default: return tier;
    }
}

/** Maps tool names to user-friendly action labels for the chat display */
function getToolActivityLabel(toolName: string): string {
    if (toolName.startsWith('core_memory_') || toolName === 'memorize') return '💭 saving to memory...';
    if (toolName === 'search_memory' || toolName === 'search_memory_all') return '🔍 searching memory...';
    if (toolName === 'forget_memory') return '🗑️ removing from memory...';
    if (toolName.startsWith('web_') || toolName === 'visual_inspect_page') return '🌐 accessing the web...';
    if (toolName === 'create_and_run_tool') return '🔨 forging tool...';
    if (toolName === 'run_shell_command' || toolName === 'start_background_process') return '⚙️ executing command...';
    if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'edit_file_blocks') return '📄 manipulating file...';
    if (toolName === 'install_mcp') return '🔌 installing MCP...';
    if (toolName === 'send_whatsapp_message') return '📱 sending message...';
    if (toolName === 'schedule_recurring_task') return '⏰ scheduling task...';
    if (toolName === 'update_persona') return '👤 updating persona...';
    if (toolName === 'ask_user_for_input') return '❓ waiting for your input...';
    // MCP or forged tools
    return `🔧 using ${toolName}...`;
}

/** Formats a tool result into a compact, friendly summary instead of raw JSON */
function formatToolResultSummary(toolName: string, result: string, success: boolean): string {
    if (!success) {
        // For errors, extract the key message
        try {
            const parsed = JSON.parse(result);
            const errMsg = parsed.error || parsed.message || result;
            return String(errMsg).slice(0, 120);
        } catch {
            return result.slice(0, 120);
        }
    }

    // Try to parse JSON results and extract meaningful info
    try {
        const parsed = JSON.parse(result);

        // Handle { success: true, output: "..." } pattern
        if (parsed.output) {
            const output = String(parsed.output);
            const firstLine = output.split('\n')[0] ?? '';
            return firstLine.length > 100
                ? firstLine.slice(0, 100) + '…'
                : firstLine || 'done';
        }

        // Handle { success: true, text: "..." } pattern (web tools)
        if (parsed.text) {
            const text = String(parsed.text);
            return text.length > 100 ? text.slice(0, 100) + '…' : text;
        }

        // Handle { success: true, message: "..." } pattern (memory tools)
        if (parsed.message) return String(parsed.message).slice(0, 120);

        // Handle arrays (search results, etc.)
        if (Array.isArray(parsed)) return `${parsed.length} result${parsed.length !== 1 ? 's' : ''}`;

        // Generic object: show key count
        const keys = Object.keys(parsed);
        if (keys.length <= 3) {
            return keys.map(k => `${k}: ${String(parsed[k]).slice(0, 30)}`).join(' | ');
        }
        return `done (${keys.length} fields)`;
    } catch {
        // Plain text result
        if (result.length <= 120) return result;
        const firstLine = result.split('\n')[0] ?? '';
        return firstLine.length > 100 ? firstLine.slice(0, 100) + '…' : firstLine;
    }
}

// ─── Component ────────────────────────────────────────────────────

export function Dashboard(): React.ReactElement {
    // ── Core state ────────────────────────────────────────────
    const [connected, setConnected] = useState(false);
    const [lastHeartbeat, setLastHeartbeat] = useState<HeartbeatMessage | null>(null);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [chatLines, setChatLines] = useState<string[]>([]);
    const [streamingText, setStreamingText] = useState('');
    const [isStreaming, setIsStreaming] = useState(false);
    const [inputValue, setInputValue] = useState('');
    const [currentModel, setCurrentModel] = useState<string | null>(null);
    const [proactiveThought, setProactiveThought] = useState<{ text: string; status: 'thinking' | 'action' | 'done' } | null>(null);

    const [isOnboarding, setIsOnboarding] = useState(!PersonaManager.exists());

    // ── Approval Gate state ───────────────────────────────────
    const [pendingApproval, setPendingApproval] = useState<ApprovalRequestMessage | null>(null);

    const [defaultTier, setDefaultTier] = useState<1 | 2>(() => {
        const config = Vault.read();
        return config?.default_chat_tier ?? 2;
    });

    // ── Ephemeral tool activity indicators ──────────────────
    const [activeTools, setActiveTools] = useState<string[]>([]);

    const clientRef = useRef<TuiWsClient | null>(null);
    const currentRequestIdRef = useRef<string | null>(null);

    // ── Streaming typewriter buffer ───────────────────────
    const streamBufferRef = useRef<string>('');
    const streamDrainTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Is the approval gate active? (blocks standard input)
    const isApprovalActive = pendingApproval !== null;

    // ── Logging ───────────────────────────────────────────────

    const addLog = useCallback((text: string, color = 'white') => {
        const time = new Date().toLocaleTimeString('en-US');
        setLogs((prev) => [...prev.slice(-(MAX_LOG_ENTRIES - 1)), { time, text, color }]);
    }, []);

    // ── Message Submission ────────────────────────────────────

    const submitMessage = useCallback((text: string) => {
        let finalMessage = text.trim();
        let requestContent = finalMessage;
        if (!finalMessage || !clientRef.current || isStreaming) return;

        let currentTierForLog = defaultTier;

        if (finalMessage.startsWith('/')) {
            let handled = false;
            let actualCmd = '';
            let rest = '';
            let shouldForceWorker = false;

            const commands = ['/toggle-tier', '/model', '/switch-cloud', '/auto-route', '/status', '/worker', '/deep'];
            for (const c of commands) {
                if (finalMessage.startsWith(c)) {
                    actualCmd = c;
                    rest = finalMessage.slice(c.length).trim();
                    handled = true;
                    break;
                }
            }

            if (handled) {
                if (actualCmd === '/worker' || actualCmd === '/deep') {
                    // Delegate the rest of the message to the Worker Engine
                    if (!rest) {
                        setChatLines((prev) => [
                            ...prev.slice(-(MAX_CHAT_LINES - 1)),
                            `⚠️ Usage: /worker <your prompt>  — Sends the prompt to the Worker Engine for deep processing.`
                        ]);
                        return;
                    }
                    const config = Vault.read();
                    if (!config?.worker_engine?.enabled) {
                        setChatLines((prev) => [
                            ...prev.slice(-(MAX_CHAT_LINES - 1)),
                            `❌ Worker Engine is disabled. Run ${'\x1b[1m'}redbus config${'\x1b[0m'} to enable it.`
                        ]);
                        return;
                    }
                    setChatLines((prev) => [
                        ...prev.slice(-(MAX_CHAT_LINES - 1)),
                        `🏗️ Delegating to Worker Engine: "${rest.slice(0, 80)}${rest.length > 80 ? '...' : ''}"`
                    ]);
                    shouldForceWorker = true;
                    currentTierForLog = 1;
                } else if (actualCmd === '/toggle-tier') {
                    const nextTier = defaultTier === 1 ? 2 : 1;
                    const config = Vault.read();
                    if (nextTier === 2 && config?.tier2_enabled === false) {
                        setChatLines((prev) => [
                            ...prev.slice(-(MAX_CHAT_LINES - 1)),
                            `❌ Cloud is disabled. Run redbus config to configure an API key.`
                        ]);
                        return;
                    }
                    setDefaultTier(nextTier);
                    currentTierForLog = nextTier;
                    const modeText = nextTier === 1 ? 'Live Engine (Local)' : 'Cloud';
                    const warning = nextTier === 2 ? ' Warning: API costs will now apply.' : '';
                    setChatLines((prev) => [
                        ...prev.slice(-(MAX_CHAT_LINES - 1)),
                        `🔄 Default routing switched to ${modeText}.${warning}`
                    ]);
                    clientRef.current?.send({
                        type: 'system:command',
                        timestamp: new Date().toISOString(),
                        payload: { command: 'set-default-tier', args: { value: nextTier } }
                    });
                } else if (actualCmd === '/model' || actualCmd === '/switch-cloud') {
                    clientRef.current?.send({
                        type: 'system:command',
                        timestamp: new Date().toISOString(),
                        payload: { command: 'switch-cloud' as any }
                    });
                } else if (actualCmd === '/auto-route') {
                    clientRef.current?.send({
                        type: 'system:command',
                        timestamp: new Date().toISOString(),
                        payload: { command: 'auto-route' }
                    });
                } else if (actualCmd === '/status') {
                    clientRef.current?.send({
                        type: 'system:command',
                        timestamp: new Date().toISOString(),
                        payload: { command: 'status' }
                    });
                }

                if (!rest) return;
                finalMessage = rest;
                requestContent = shouldForceWorker ? `${actualCmd} ${rest}` : rest;
            }
        }

        const requestId = generateRequestId();
        currentRequestIdRef.current = requestId;

        // Add user message to chat
        setChatLines((prev) => [
            ...prev.slice(-(MAX_CHAT_LINES - 2)),
            '',
            `🧑 User: ${finalMessage}`,
        ]);

        // Reset streaming state
        streamBufferRef.current = '';
        stopDrain();
        setStreamingText('');
        setActiveTools([]);
        setIsStreaming(true);

        // Send to daemon
        const chatRequest: ChatRequestMessage = {
            type: 'chat:request',
            timestamp: new Date().toISOString(),
            payload: {
                requestId,
                content: requestContent,
                isOnboarding,
            },
        };

        if (isOnboarding) {
            setIsOnboarding(false);
        }

        clientRef.current.send(chatRequest);
        addLog(`Sent to ${currentTierForLog === 1 ? 'Live Engine' : 'Cloud'}: "${finalMessage.slice(0, 50)}${finalMessage.length > 50 ? '...' : ''}"`, 'cyan');
    }, [isStreaming, addLog, isOnboarding, defaultTier]);

    // ── Approval Gate Handler ─────────────────────────────────
    const handleApprovalRespond = useCallback((approvalId: string, decision: 'allow-once' | 'deny') => {
        clientRef.current?.send({
            type: 'approval:response',
            timestamp: new Date().toISOString(),
            payload: { approvalId, decision },
        });
        setPendingApproval(null);
        addLog(`Approval ${approvalId}: ${decision}`, decision === 'allow-once' ? 'green' : 'red');
    }, [addLog]);

    // ── Input Handler (locked when approval gate is active) ──
    useInput((input, key) => {
        // When approval gate is active, ApprovalGate component handles Y/N via its own useInput
        if (isApprovalActive) return;

        if (key.return) {
            submitMessage(inputValue);
            setInputValue('');
            return;
        }

        if (key.backspace || key.delete) {
            setInputValue((prev) => prev.slice(0, -1));
            return;
        }

        // Ignore control keys
        if (key.ctrl || key.meta || key.escape || key.tab) return;
        if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;

        // Append printable characters
        if (input) {
            setInputValue((prev) => prev + input);
        }
    });

    // ── Streaming typewriter drain effect ───────────────────
    // Drains the buffer at a natural pace (~40 chars per tick, every 30ms ≈ ~1300 chars/sec).
    // If buffer is small or model is slow, characters pass through nearly instantly.
    const DRAIN_INTERVAL_MS = 30;
    const DRAIN_CHARS_PER_TICK = 40;

    const startDrain = useCallback(() => {
        if (streamDrainTimerRef.current) return; // already running
        streamDrainTimerRef.current = setInterval(() => {
            const buf = streamBufferRef.current;
            if (buf.length === 0) return;

            // Drain a chunk from the buffer
            const chunkSize = Math.min(DRAIN_CHARS_PER_TICK, buf.length);
            const chunk = buf.slice(0, chunkSize);
            streamBufferRef.current = buf.slice(chunkSize);
            setStreamingText((prev) => prev + chunk);
        }, DRAIN_INTERVAL_MS);
    }, []);

    const stopDrain = useCallback(() => {
        if (streamDrainTimerRef.current) {
            clearInterval(streamDrainTimerRef.current);
            streamDrainTimerRef.current = null;
        }
    }, []);

    const flushBuffer = useCallback(() => {
        const remaining = streamBufferRef.current;
        if (remaining) {
            setStreamingText((prev) => prev + remaining);
            streamBufferRef.current = '';
        }
        stopDrain();
    }, [stopDrain]);

    // Cleanup drain on unmount
    useEffect(() => {
        return () => stopDrain();
    }, [stopDrain]);

    // ── WebSocket Connection ──────────────────────────────────

    useEffect(() => {
        const url = `ws://${DEFAULT_HOST}:${DEFAULT_PORT}`;
        const client = new TuiWsClient({
            url,
            onConnected: () => {
                setConnected(true);
                addLog('Connected to Daemon', 'green');

                if (!PersonaManager.exists()) {
                    setChatLines((prev) => [
                        ...prev,
                        '',
                        "🔴 redbusagent: Hi there! I'm your new autonomous agent, but I'm currently a blank slate. Before we start working, tell me: What should my name be? What do you do, and how do you want me to behave (e.g., formal, sarcastic, concise)?",
                    ]);
                }
            },

            onDisconnected: () => {
                setConnected(false);
                addLog('❌ Daemon is offline. Run \'redbus daemon\' in another terminal.', 'red');
            },
            onError: (err) => {
                addLog(`Error: ${err.message}`, 'red');
            },
            onMessage: (message: DaemonMessage) => {
                handleDaemonMessage(message);
            },
        });

        clientRef.current = client;
        client.connect();
        addLog(`Connecting to ${url}...`, 'gray');

        return () => {
            client.disconnect();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Message Handler ───────────────────────────────────────

    const handleDaemonMessage = useCallback((message: DaemonMessage) => {
        switch (message.type) {
            case 'heartbeat':
                setLastHeartbeat(message);
                break;

            case 'log':
                addLog(
                    `[${message.payload.level.toUpperCase()}] ${message.payload.source}: ${message.payload.message}`,
                    message.payload.level === 'error' ? 'red' : 'cyan',
                );
                break;

            case 'system:status':
                addLog(`System: ${message.payload.status}`, 'blue');
                break;

            case 'system:alert':
                setChatLines((prev) => [
                    ...prev.slice(-(MAX_CHAT_LINES - 2)),
                    '',
                    `⏰ SCHEDULED ALERT: ${message.payload.message}`,
                ]);
                addLog(`Alert triggered: ${message.payload.id}`, 'yellow');
                break;

            case 'proactive:thought':
                if (message.payload.status === 'done' || !message.payload.text) {
                    setProactiveThought(null);
                } else {
                    setProactiveThought({ text: message.payload.text, status: message.payload.status });
                }
                break;

            case 'chat:stream:chunk':
                // Push delta into buffer; drain effect renders it progressively
                streamBufferRef.current += message.payload.delta;
                startDrain();
                break;

            case 'chat:stream:done': {
                setIsStreaming(false);
                setCurrentModel(message.payload.model);
                // Flush any remaining buffer immediately
                flushBuffer();
                // Clear ephemeral tool indicators
                setActiveTools([]);
                // Move streaming text to permanent chat lines
                setStreamingText((currentStreaming) => {
                    if (currentStreaming) {
                        setChatLines((prev) => [
                            ...prev.slice(-(MAX_CHAT_LINES - 2)),
                            `🔴 redbusagent [${tierToEngineLabel(message.payload.tier)}/${message.payload.model}]:`,
                            currentStreaming,
                        ]);
                    }
                    return '';
                });
                addLog(`Full response via ${tierToEngineLabel(message.payload.tier)}/${message.payload.model}`, 'green');
                break;
            }

            case 'chat:error':
                setIsStreaming(false);
                flushBuffer();
                setActiveTools([]);
                setChatLines((prev) => [
                    ...prev.slice(-(MAX_CHAT_LINES - 1)),
                    `❌ Error: ${message.payload.error}`,
                ]);
                addLog(`LLM Error: ${message.payload.error}`, 'red');
                break;

            case 'chat:tool:call': {
                // Ephemeral: add to activeTools (transient indicators, not permanent chat)
                const activityLabel = getToolActivityLabel(message.payload.toolName);
                setActiveTools((prev) => [...prev, activityLabel]);
                addLog(`Tool call: ${message.payload.toolName}`, 'magenta');
                break;
            }

            case 'chat:tool:result': {
                const resultActivityLabel = getToolActivityLabel(message.payload.toolName);
                // Remove the ephemeral activity indicator
                setActiveTools((prev) => prev.filter((l) => l !== resultActivityLabel));

                if (!message.payload.success) {
                    // Distinguish between real errors and soft "no results" outcomes:
                    // Real errors have an "error" field; soft failures only have "message"
                    let isHardError = true;
                    try {
                        const parsed = JSON.parse(message.payload.result);
                        // Soft failure: has message but no error field (e.g. "No memories found")
                        if (parsed.message && !parsed.error) {
                            isHardError = false;
                        }
                    } catch {
                        // Not JSON — treat as hard error
                    }

                    if (isHardError) {
                        const summary = formatToolResultSummary(message.payload.toolName, message.payload.result, false);
                        setChatLines((prev) => [
                            ...prev.slice(-(MAX_CHAT_LINES - 1)),
                            `❌ ${message.payload.toolName}: ${summary}`,
                        ]);
                        addLog(`Tool result: ${message.payload.toolName} — error`, 'red');
                    } else {
                        // Soft failure: log silently, don't pollute chat
                        addLog(`Tool result: ${message.payload.toolName} — no results`, 'gray');
                    }
                } else {
                    // Success: log silently
                    addLog(`Tool result: ${message.payload.toolName} — success`, 'green');
                }
                break;
            }

            case 'approval:request':
                setPendingApproval(message);
                addLog(`Approval requested: ${message.payload.toolName} (${message.payload.reason})`, 'yellow');
                break;

            case 'approval:resolved':
                setPendingApproval(null);
                addLog(`Approval resolved: ${message.payload.approvalId} → ${message.payload.decision}`, 'green');
                break;

            case 'worker_task_completed':
                setChatLines((prev) => [
                    ...prev.slice(-(MAX_CHAT_LINES - 1)),
                    `🏗️ Worker Engine completed: ${message.payload.description} (${message.payload.resultLength} chars)`,
                ]);
                addLog(`Worker done: ${message.payload.description} [${message.payload.taskType}]`, 'blue');
                break;

            case 'worker_task_failed':
                setChatLines((prev) => [
                    ...prev.slice(-(MAX_CHAT_LINES - 1)),
                    `❌ Worker Engine failed: ${message.payload.description} — ${message.payload.error}`,
                ]);
                addLog(`Worker failed: ${message.payload.description}`, 'red');
                break;
        }
    }, [addLog]);

    // ── Render (Modular Composition) ──────────────────────────

    return (
        <Box flexDirection="column" padding={1}>
            {/* ── App Header ──────────────────────────────────────── */}
            <Box borderStyle="double" borderColor="red" paddingX={2} justifyContent="space-between">
                <Box>
                    <Text bold color="red">🔴 {APP_NAME}</Text>
                    <Text color="gray"> v{APP_VERSION}</Text>
                </Box>
            </Box>

            {/* ── StatusBar: Daemon State + Heartbeat ─────────────── */}
            <StatusBar
                connected={connected}
                heartbeat={lastHeartbeat}
                currentModel={currentModel}
            />

            {/* ── ChatLog: Conversation History ───────────────────── */}
            <ChatLog
                chatLines={chatLines}
                streamingText={streamingText}
                isStreaming={isStreaming}
                activeTools={activeTools}
            />

            {/* ── ApprovalGate: HITL Y/N Interceptor ──────────────── */}
            <ApprovalGate
                pending={pendingApproval}
                onRespond={handleApprovalRespond}
                active={isApprovalActive}
            />

            {/* ── InputBox: Text Input ─────────────────────────────── */}
            <InputBox
                inputValue={inputValue}
                isStreaming={isStreaming}
                locked={isApprovalActive}
            />

            {/* ── SystemLog: Compact Event Log ────────────────────── */}
            <SystemLog logs={logs} displayCount={5} />

            {/* ── Proactive Thoughts ──────────────────────────────── */}
            {proactiveThought && (
                <Box
                    marginTop={1}
                    borderStyle="round"
                    borderColor={proactiveThought.status === 'thinking' ? 'magenta' : 'green'}
                    paddingX={1}
                >
                    <Text bold color={proactiveThought.status === 'thinking' ? 'magenta' : 'green'}>
                        {proactiveThought.status === 'thinking' ? '⏳ [Background Process: Thinking] ' : '⚡ [Background Process: Acting] '}
                    </Text>
                    <Text italic color="gray">{proactiveThought.text}</Text>
                </Box>
            )}

            {/* ── Footer ──────────────────────────────────────────── */}
            <Box marginTop={1} gap={2}>
                <Text color="gray" italic dimColor>
                    {isApprovalActive ? 'Y: approve  •  N: deny  •  Esc: deny' : 'Enter: send  •  Ctrl+C: exit'}
                </Text>
            </Box>
        </Box>
    );
}
