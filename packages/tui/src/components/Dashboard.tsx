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
    fetchTier2Models,
    Tier2Provider,
    getMCPSuggestion,
    checkForUpdates,
    performUpdate
} from '@redbusagent/shared';
import { TuiWsClient } from '../infra/ws-client.js';
import { StatusBar } from './StatusBar.js';
import { ChatLog, MAX_CHAT_LINES } from './ChatLog.js';
import { SystemLog, MAX_LOG_ENTRIES } from './SystemLog.js';
import type { LogEntry } from './SystemLog.js';
import { ApprovalGate } from './ApprovalGate.js';
import { InputBox } from './InputBox.js';
import type { ActiveMenu } from './InputBox.js';

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

    // ── Slash menu state ──────────────────────────────────────
    const [isSlashMenuOpen, setIsSlashMenuOpen] = useState(false);
    const [activeMenu, setActiveMenu] = useState<ActiveMenu>('main');

    // ── MCP Installation State ────────────────────────────────
    const [mcpInputStr, setMcpInputStr] = useState('');
    const [mcpTargetId, setMcpTargetId] = useState('');
    const [mcpEnvQueue, setMcpEnvQueue] = useState<string[]>([]);
    const [mcpCurrentEnvKey, setMcpCurrentEnvKey] = useState('');
    const [mcpCollectedEnv, setMcpCollectedEnv] = useState<Record<string, string>>({});

    // ── Cloud/Model state ─────────────────────────────────────
    const [isFetchingModels, setIsFetchingModels] = useState(false);
    const [cloudModels, setCloudModels] = useState<{ label: string, value: string, hint?: string, id: string }[]>([]);
    const [selectedProvider, setSelectedProvider] = useState<Tier2Provider | null>(null);
    const [isOnboarding, setIsOnboarding] = useState(!PersonaManager.exists());
    const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);
    const [isUpdating, setIsUpdating] = useState(false);

    // ── Approval Gate state ───────────────────────────────────
    const [pendingApproval, setPendingApproval] = useState<ApprovalRequestMessage | null>(null);

    const [defaultTier, setDefaultTier] = useState<1 | 2>(() => {
        const config = Vault.read();
        return config?.default_chat_tier ?? 2;
    });

    const clientRef = useRef<TuiWsClient | null>(null);
    const currentRequestIdRef = useRef<string | null>(null);

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
        if (!finalMessage || !clientRef.current || isStreaming) return;

        let currentTierForLog = defaultTier;

        if (finalMessage.startsWith('/')) {
            let handled = false;
            let actualCmd = '';
            let rest = '';

            const commands = ['/toggle-tier', '/model', '/switch-cloud', '/auto-route', '/status', '/update', '/worker', '/deep'];
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
                    clientRef.current?.send({
                        type: 'system:command',
                        timestamp: new Date().toISOString(),
                        payload: { command: 'force-worker' as any, args: { content: rest } }
                    });
                    return;
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
                    setIsSlashMenuOpen(true);
                    setActiveMenu('cloud');
                    return;
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
                } else if (actualCmd === '/update') {
                    setIsUpdating(true);
                    setChatLines((prev) => [
                        ...prev.slice(-(MAX_CHAT_LINES - 1)),
                        `🔄 Downloading and installing new version... This may take a while.`
                    ]);
                    performUpdate().then(() => {
                        setChatLines((prev) => [
                            ...prev.slice(-(MAX_CHAT_LINES - 1)),
                            `✅ Update successfully completed! Please restart Redbus Agent by pressing Ctrl+C and starting again.`
                        ]);
                        setIsUpdating(false);
                        setUpdateAvailable(null);
                    }).catch((err) => {
                        setChatLines((prev) => [
                            ...prev.slice(-(MAX_CHAT_LINES - 1)),
                            `❌ Update failed: ${err.message}`
                        ]);
                        setIsUpdating(false);
                    });
                    return;
                }

                if (!rest) return;
                finalMessage = rest;
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
        setStreamingText('');
        setIsStreaming(true);

        // Send to daemon
        const chatRequest: ChatRequestMessage = {
            type: 'chat:request',
            timestamp: new Date().toISOString(),
            payload: {
                requestId,
                content: finalMessage,
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

        if (isSlashMenuOpen) {
            if (key.escape) {
                setIsSlashMenuOpen(false);
            }
            return;
        }

        if (input === '/' && inputValue === '' && !isStreaming) {
            setIsSlashMenuOpen(true);
            setActiveMenu('main');
            return;
        }

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

    // ── Update Checker ─────────────────────────────────────────

    useEffect(() => {
        checkForUpdates().then((info) => {
            if (info.updateAvailable) {
                setUpdateAvailable(info.latestVersion);
                addLog(`Update missing: v${info.latestVersion} is available. Use /update to install.`, 'yellow');
            }
        }).catch(() => {
            // Silently ignore update checks failing
        });
    }, [addLog]);

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
                setStreamingText((prev) => prev + message.payload.delta);
                break;

            case 'chat:stream:done': {
                setIsStreaming(false);
                setCurrentModel(message.payload.model);
                // Move streaming text to permanent chat lines
                setStreamingText((currentStreaming) => {
                    if (currentStreaming) {
                        setChatLines((prev) => [
                            ...prev.slice(-(MAX_CHAT_LINES - 2)),
                            `🔴 redbusagent [${message.payload.tier}/${message.payload.model}]:`,
                            currentStreaming,
                        ]);
                    }
                    return '';
                });
                addLog(`Full response via ${message.payload.tier}/${message.payload.model}`, 'green');
                break;
            }

            case 'chat:error':
                setIsStreaming(false);
                setChatLines((prev) => [
                    ...prev.slice(-(MAX_CHAT_LINES - 1)),
                    `❌ Error: ${message.payload.error}`,
                ]);
                addLog(`LLM Error: ${message.payload.error}`, 'red');
                break;

            case 'chat:tool:call': {
                const argsSummary = formatToolArgs(message.payload.toolName, message.payload.args);
                setChatLines((prev) => [
                    ...prev.slice(-(MAX_CHAT_LINES - 1)),
                    `🔧 ${message.payload.toolName}${argsSummary ? ` → ${argsSummary}` : '...'}`,
                ]);
                addLog(`Tool call: ${message.payload.toolName}`, 'magenta');
                break;
            }

            case 'chat:tool:result': {
                const icon = message.payload.success ? '✅' : '❌';
                const status = message.payload.success ? 'success' : 'failed';
                const summary = formatToolResultSummary(message.payload.toolName, message.payload.result, message.payload.success);

                setChatLines((prev) => [
                    ...prev.slice(-(MAX_CHAT_LINES - 1)),
                    `${icon} ${message.payload.toolName}: ${summary}`,
                ]);
                addLog(`Tool result: ${message.payload.toolName} — ${status}`, message.payload.success ? 'green' : 'red');
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

    // ── Slash Menu Callbacks ─────────────────────────────────

    const handleMenuSelect = useCallback((value: string) => {
        if (value === 'close') {
            setIsSlashMenuOpen(false);
        } else if (value === 'mcp-install') {
            setActiveMenu('mcp-install-id');
            setMcpInputStr('');
        } else if (value === 'switch-cloud') {
            setActiveMenu('cloud');
        } else if (value === 'worker') {
            // /worker from slash menu — close menu and show usage hint
            setIsSlashMenuOpen(false);
            setChatLines((prev) => [
                ...prev.slice(-(MAX_CHAT_LINES - 1)),
                `💡 Type: /worker <your prompt> to send a task to the Worker Engine.`
            ]);
        } else if (value === 'toggle-tier') {
            const nextTier = defaultTier === 1 ? 2 : 1;
            const config = Vault.read();
            if (nextTier === 2 && config?.tier2_enabled === false) {
                setChatLines((prev) => [
                    ...prev.slice(-(MAX_CHAT_LINES - 1)),
                    `❌ Cloud is disabled. Run redbus config to configure an API key.`
                ]);
                setIsSlashMenuOpen(false);
                return;
            }
            setDefaultTier(nextTier);
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
            setIsSlashMenuOpen(false);
        } else if (value === 'update') {
            setIsSlashMenuOpen(false);
            setIsUpdating(true);
            setChatLines((prev) => [
                ...prev.slice(-(MAX_CHAT_LINES - 1)),
                `🔄 Downloading and installing new version... This may take a while.`
            ]);
            performUpdate().then(() => {
                setChatLines((prev) => [
                    ...prev.slice(-(MAX_CHAT_LINES - 1)),
                    `✅ Update successfully completed! Please restart Redbus Agent by pressing Ctrl+C and starting again.`
                ]);
                setIsUpdating(false);
                setUpdateAvailable(null);
            }).catch((err) => {
                setChatLines((prev) => [
                    ...prev.slice(-(MAX_CHAT_LINES - 1)),
                    `❌ Update failed: ${err.message}`
                ]);
                setIsUpdating(false);
            });
        } else {
            clientRef.current?.send({
                type: 'system:command',
                timestamp: new Date().toISOString(),
                payload: { command: value as any }
            });
            setIsSlashMenuOpen(false);
        }
    }, [defaultTier]);

    const handleCloudProviderSelect = useCallback(async (value: string) => {
        if (value === 'back') {
            setActiveMenu('main');
        } else {
            const provider = value as Tier2Provider;
            setSelectedProvider(provider);
            setActiveMenu('cloud-models');
            setIsFetchingModels(true);
            try {
                const config = Vault.read();
                const result = await fetchTier2Models(provider, {
                    apiKey: config?.tier2?.apiKey,
                    authToken: config?.tier2?.authToken
                });
                setCloudModels(result.models as any);
            } catch {
                setCloudModels([]);
            } finally {
                setIsFetchingModels(false);
            }
        }
    }, []);

    const handleCloudModelSelect = useCallback((value: string) => {
        if (value === 'back') {
            setActiveMenu('cloud');
        } else {
            clientRef.current?.send({
                type: 'system:command',
                timestamp: new Date().toISOString(),
                payload: { command: 'switch-cloud', args: { provider: selectedProvider, model: value } }
            });
            setIsSlashMenuOpen(false);
        }
    }, [selectedProvider]);

    const handleMcpInputSubmit = useCallback((val: string) => {
        const trimmed = val.trim();
        if (!trimmed) return;

        const suggestion = getMCPSuggestion(trimmed);
        setMcpTargetId(trimmed);
        setMcpCollectedEnv({});

        if (suggestion && suggestion.requiredEnvVars && suggestion.requiredEnvVars.length > 0) {
            setMcpEnvQueue([...suggestion.requiredEnvVars]);
            setMcpCurrentEnvKey(suggestion.requiredEnvVars[0]!);
            setMcpInputStr('');
            setActiveMenu('mcp-install-env');
        } else {
            let command = '';
            let args: string[] = [];
            let mcpId = trimmed;
            if (suggestion) {
                command = suggestion.command;
                args = suggestion.args;
                mcpId = suggestion.id;
            } else {
                const parts = trimmed.split(' ');
                command = parts[0]!;
                args = parts.slice(1);
                mcpId = `custom-${Math.random().toString(36).substring(2, 8)}`;
            }
            const config = Vault.read();
            Vault.write({ ...config!, mcps: { ...(config?.mcps || {}), [mcpId]: { command, args, env: {} } } });
            setChatLines(prev => [...prev.slice(-(MAX_CHAT_LINES - 1)), `✅ MCP ${mcpId} installed to Vault. Restart daemon to apply.`]);
            setIsSlashMenuOpen(false);
        }
    }, []);

    const handleMcpEnvSubmit = useCallback((val: string) => {
        const newCollected = { ...mcpCollectedEnv, [mcpCurrentEnvKey]: val.trim() };
        setMcpCollectedEnv(newCollected);

        const nextQueue = mcpEnvQueue.slice(1);
        if (nextQueue.length > 0) {
            setMcpEnvQueue(nextQueue);
            setMcpCurrentEnvKey(nextQueue[0]!);
            setMcpInputStr('');
        } else {
            const suggestion = getMCPSuggestion(mcpTargetId)!;
            const config = Vault.read();
            Vault.write({ ...config!, mcps: { ...(config?.mcps || {}), [suggestion.id]: { command: suggestion.command, args: suggestion.args, env: newCollected } } });
            setChatLines(prev => [...prev.slice(-(MAX_CHAT_LINES - 1)), `✅ Suggested MCP ${suggestion.id} installed to Vault. Restart daemon to apply.`]);
            setIsSlashMenuOpen(false);
        }
    }, [mcpCollectedEnv, mcpCurrentEnvKey, mcpEnvQueue, mcpTargetId]);

    // ── Render (Modular Composition) ──────────────────────────

    return (
        <Box flexDirection="column" padding={1}>
            {/* ── App Header ──────────────────────────────────────── */}
            <Box borderStyle="double" borderColor="red" paddingX={2} justifyContent="space-between">
                <Box>
                    <Text bold color="red">🔴 {APP_NAME}</Text>
                    <Text color="gray"> v{APP_VERSION}</Text>
                    {updateAvailable && (
                        <Text color="yellow" bold> [UPDATE v{updateAvailable} AVAIL]</Text>
                    )}
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
                isUpdating={isUpdating}
            />

            {/* ── ApprovalGate: HITL Y/N Interceptor ──────────────── */}
            <ApprovalGate
                pending={pendingApproval}
                onRespond={handleApprovalRespond}
                active={isApprovalActive}
            />

            {/* ── InputBox: Text Input + Slash Menu ───────────────── */}
            <InputBox
                inputValue={inputValue}
                isStreaming={isStreaming}
                isSlashMenuOpen={isSlashMenuOpen}
                locked={isApprovalActive}
                activeMenu={activeMenu}
                defaultTier={defaultTier}
                isFetchingModels={isFetchingModels}
                cloudModels={cloudModels}
                mcpInputStr={mcpInputStr}
                mcpCurrentEnvKey={mcpCurrentEnvKey}
                onMenuSelect={handleMenuSelect}
                onCloudProviderSelect={handleCloudProviderSelect}
                onCloudModelSelect={handleCloudModelSelect}
                onMcpInputChange={setMcpInputStr}
                onMcpInputSubmit={handleMcpInputSubmit}
                onMcpEnvSubmit={handleMcpEnvSubmit}
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
                    {isApprovalActive ? 'Y: approve  •  N: deny  •  Esc: deny' : 'Enter: send  •  /: menu  •  Ctrl+C: exit'}
                </Text>
            </Box>
        </Box>
    );
}
