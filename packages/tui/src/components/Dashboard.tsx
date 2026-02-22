/**
 * @redbusagent/tui — Dashboard Component
 *
 * The main TUI interface with three areas:
 *  1. Header: Connection status + daemon info
 *  2. Chat Area: Streaming LLM responses + system logs
 *  3. Input: Text field for sending messages to the daemon
 *
 * Built with Ink (React for terminals) for composable, declarative UIs.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import type {
    DaemonMessage,
    HeartbeatMessage,
    ChatRequestMessage,
    ProactiveThoughtMessage,
} from '@redbusagent/shared';
import {
    APP_NAME,
    APP_VERSION,
    DEFAULT_HOST,
    DEFAULT_PORT,
} from '@redbusagent/shared';
import { TuiWsClient } from '../infra/ws-client.js';

// ─── Helpers ──────────────────────────────────────────────────────

function formatUptime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function generateRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Types ────────────────────────────────────────────────────────

interface LogEntry {
    readonly time: string;
    readonly text: string;
    readonly color: string;
}

const MAX_LOG_ENTRIES = 15;
const MAX_CHAT_LINES = 30;

// ─── Component ────────────────────────────────────────────────────

export function Dashboard(): React.ReactElement {
    const [connected, setConnected] = useState(false);
    const [lastHeartbeat, setLastHeartbeat] = useState<HeartbeatMessage | null>(null);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [chatLines, setChatLines] = useState<string[]>([]);
    const [streamingText, setStreamingText] = useState('');
    const [isStreaming, setIsStreaming] = useState(false);
    const [inputValue, setInputValue] = useState('');
    const [currentModel, setCurrentModel] = useState<string | null>(null);
    const [proactiveThought, setProactiveThought] = useState<{ text: string; status: 'thinking' | 'action' | 'done' } | null>(null);

    const clientRef = useRef<TuiWsClient | null>(null);
    const currentRequestIdRef = useRef<string | null>(null);

    // ── Logging ───────────────────────────────────────────────

    const addLog = useCallback((text: string, color = 'white') => {
        const time = new Date().toLocaleTimeString('pt-BR');
        setLogs((prev) => [...prev.slice(-(MAX_LOG_ENTRIES - 1)), { time, text, color }]);
    }, []);

    // ── Message Submission ────────────────────────────────────

    const submitMessage = useCallback((text: string) => {
        if (!text.trim() || !clientRef.current || isStreaming) return;

        const requestId = generateRequestId();
        currentRequestIdRef.current = requestId;

        // Add user message to chat
        setChatLines((prev) => [
            ...prev.slice(-(MAX_CHAT_LINES - 2)),
            '',
            `🧑 Guile: ${text}`,
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
                content: text,
                tier: 'tier2',
            },
        };

        clientRef.current.send(chatRequest);
        addLog(`Enviado para Tier 2: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`, 'cyan');
    }, [isStreaming, addLog]);

    // ── Keyboard Input ────────────────────────────────────────

    useInput((input, key) => {
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
                addLog('Conectado ao Daemon', 'green');
            },
            onDisconnected: () => {
                setConnected(false);
                addLog('Desconectado. Tentando reconectar...', 'yellow');
            },
            onError: (err) => {
                addLog(`Erro: ${err.message}`, 'red');
            },
            onMessage: (message: DaemonMessage) => {
                handleDaemonMessage(message);
            },
        });

        clientRef.current = client;
        client.connect();
        addLog(`Conectando a ${url}...`, 'gray');

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
                addLog(`Sistema: ${message.payload.status}`, 'blue');
                break;

            case 'system:alert':
                setChatLines((prev) => [
                    ...prev.slice(-(MAX_CHAT_LINES - 2)),
                    '',
                    `⏰ ALERTA AGENDADO: ${message.payload.message}`,
                ]);
                addLog(`Alerta disparado: ${message.payload.id}`, 'yellow');
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
                addLog(`Resposta completa via ${message.payload.tier}/${message.payload.model}`, 'green');
                break;
            }

            case 'chat:error':
                setIsStreaming(false);
                setChatLines((prev) => [
                    ...prev.slice(-(MAX_CHAT_LINES - 1)),
                    `❌ Erro: ${message.payload.error}`,
                ]);
                addLog(`Erro do LLM: ${message.payload.error}`, 'red');
                break;

            case 'chat:tool:call':
                setChatLines((prev) => [
                    ...prev.slice(-(MAX_CHAT_LINES - 1)),
                    `🔧 Forjando: ${message.payload.toolName}...`,
                ]);
                addLog(`Tool call: ${message.payload.toolName}`, 'magenta');
                break;

            case 'chat:tool:result': {
                const icon = message.payload.success ? '✅' : '❌';
                const status = message.payload.success ? 'sucesso' : 'falhou';

                // Show a preview of the result (truncated)
                const resultPreview = message.payload.result.length > 200
                    ? message.payload.result.slice(0, 200) + '...'
                    : message.payload.result;

                setChatLines((prev) => [
                    ...prev.slice(-(MAX_CHAT_LINES - 2)),
                    `${icon} Forge [${message.payload.toolName}]: ${status}`,
                    resultPreview,
                ]);
                addLog(`Tool result: ${message.payload.toolName} — ${status}`, message.payload.success ? 'green' : 'red');
                break;
            }
        }
    }, [addLog]);

    // ── Render ────────────────────────────────────────────────

    return (
        <Box flexDirection="column" padding={1}>
            {/* ── Header ──────────────────────────────────────────── */}
            <Box borderStyle="double" borderColor="red" paddingX={2} justifyContent="space-between">
                <Box>
                    <Text bold color="red">
                        🔴 {APP_NAME}
                    </Text>
                    <Text color="gray"> v{APP_VERSION}</Text>
                </Box>
                <Box gap={2}>
                    <Text color={connected ? 'green' : 'yellow'}>
                        {connected ? '● Conectado' : '○ Desconectado'}
                    </Text>
                    {lastHeartbeat && (
                        <Text color="gray">
                            PID:{lastHeartbeat.payload.pid} ⏱{formatUptime(lastHeartbeat.payload.uptimeMs)}
                        </Text>
                    )}
                    {currentModel && (
                        <Text color="magenta">
                            🧠 {currentModel}
                        </Text>
                    )}
                </Box>
            </Box>

            {/* ── Chat Area ───────────────────────────────────────── */}
            <Box
                flexDirection="column"
                marginTop={1}
                borderStyle="round"
                borderColor="cyan"
                paddingX={1}
                paddingY={0}
                minHeight={10}
            >
                <Text bold color="cyan" underline>
                    Chat
                </Text>
                {chatLines.length === 0 && !streamingText ? (
                    <Text color="gray" italic>
                        Digite uma mensagem abaixo e pressione Enter...
                    </Text>
                ) : (
                    <>
                        {chatLines.map((line, i) => (
                            <Text key={i} wrap="wrap">
                                {line.startsWith('🧑') ? (
                                    <Text color="white" bold>{line}</Text>
                                ) : line.startsWith('🔴') ? (
                                    <Text color="red" bold>{line}</Text>
                                ) : line.startsWith('🔧') ? (
                                    <Text color="magenta" bold>{line}</Text>
                                ) : line.startsWith('✅') ? (
                                    <Text color="green">{line}</Text>
                                ) : line.startsWith('❌') ? (
                                    <Text color="red">{line}</Text>
                                ) : (
                                    <Text color="white">{line}</Text>
                                )}
                            </Text>
                        ))}
                        {streamingText && (
                            <Text color="green" wrap="wrap">
                                {streamingText}
                                <Text color="yellow" bold>▊</Text>
                            </Text>
                        )}
                    </>
                )}
                {isStreaming && !streamingText && (
                    <Text color="yellow" italic>
                        ⏳ Pensando...
                    </Text>
                )}
            </Box>

            {/* ── Input ───────────────────────────────────────────── */}
            <Box
                marginTop={1}
                borderStyle="single"
                borderColor={isStreaming ? 'yellow' : 'green'}
                paddingX={1}
            >
                <Text color={isStreaming ? 'yellow' : 'green'} bold>
                    {isStreaming ? '⏳' : '❯'}{' '}
                </Text>
                <Text>
                    {inputValue}
                    {!isStreaming && <Text color="green" bold>▊</Text>}
                </Text>
            </Box>

            {/* ── System Log (compact) ────────────────────────────── */}
            <Box
                flexDirection="column"
                marginTop={1}
                borderStyle="single"
                borderColor="gray"
                paddingX={1}
            >
                <Text bold color="gray" underline>
                    System Log
                </Text>
                {logs.slice(-5).map((entry, i) => (
                    <Text key={i}>
                        <Text color="gray" dimColor>[{entry.time}] </Text>
                        <Text color={entry.color as never} dimColor>{entry.text}</Text>
                    </Text>
                ))}
            </Box>

            {/* ── Background Proactive Thoughts Panel ─────────────────────── */}
            {proactiveThought && (
                <Box
                    marginTop={1}
                    borderStyle="round"
                    borderColor={proactiveThought.status === 'thinking' ? 'magenta' : 'green'}
                    paddingX={1}
                >
                    <Text bold color={proactiveThought.status === 'thinking' ? 'magenta' : 'green'}>
                        {proactiveThought.status === 'thinking' ? '⏳ [Processo de Fundo: Pensando] ' : '⚡ [Processo de Fundo: Agindo] '}
                    </Text>
                    <Text italic color="gray">
                        {proactiveThought.text}
                    </Text>
                </Box>
            )}

            {/* ── Footer ──────────────────────────────────────────── */}
            <Box marginTop={1} gap={2}>
                <Text color="gray" italic dimColor>
                    Enter: enviar  •  Ctrl+C: sair
                </Text>
            </Box>
        </Box>
    );
}
