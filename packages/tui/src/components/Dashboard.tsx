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
import SelectInput from 'ink-select-input';
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
    PersonaManager,
    Vault,
    fetchTier2Models,
    Tier2Provider
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
    const [isSlashMenuOpen, setIsSlashMenuOpen] = useState(false);
    const [activeMenu, setActiveMenu] = useState<'main' | 'cloud' | 'cloud-models'>('main');
    const [isFetchingModels, setIsFetchingModels] = useState(false);
    const [cloudModels, setCloudModels] = useState<{ label: string, value: string, hint?: string, id: string }[]>([]);
    const [selectedProvider, setSelectedProvider] = useState<Tier2Provider | null>(null);
    const [isOnboarding, setIsOnboarding] = useState(!PersonaManager.exists());

    const [defaultTier, setDefaultTier] = useState<1 | 2>(() => {
        const config = Vault.read();
        return config?.default_chat_tier ?? 2;
    });

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
            `🧑 Usuário: ${text}`,
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
                tier: defaultTier === 1 ? 'tier1' : 'tier2',
                isOnboarding,
            },
        };

        if (isOnboarding) {
            setIsOnboarding(false);
        }

        clientRef.current.send(chatRequest);
        addLog(`Enviado para Tier ${defaultTier}: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`, 'cyan');
    }, [isStreaming, addLog, isOnboarding]);

    useInput((input, key) => {
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
                addLog('Conectado ao Daemon', 'green');

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
                    {!isStreaming && !isSlashMenuOpen && <Text color="green" bold>▊</Text>}
                </Text>

                {isSlashMenuOpen && (
                    <Box
                        flexDirection="column"
                        position="absolute"
                        marginTop={-10}
                        marginLeft={2}
                        borderStyle="bold"
                        borderColor="yellow"
                        paddingX={1}
                    >
                        <Text bold color="yellow">
                            {activeMenu === 'main' ? '🚀 COMMAND PALETTE' : '☁️ SELECT CLOUD TIER 2'}
                        </Text>

                        {activeMenu === 'main' && (
                            <SelectInput
                                items={[
                                    { label: `🔄 /toggle-tier    - Current: Tier ${defaultTier} (${defaultTier === 1 ? 'Local' : 'Cloud'})`, value: 'toggle-tier' },
                                    { label: '🤖 /auto-route     - Restore Cognitive Routing', value: 'auto-route' },
                                    { label: '☁️  /switch-cloud  - Change Tier 2 Provider', value: 'switch-cloud' },
                                    { label: '📊 /status        - Daemon & Model Status', value: 'status' },
                                    { label: '❌ Close Menu', value: 'close' },
                                ]}
                                onSelect={(item) => {
                                    if (item.value === 'close') {
                                        setIsSlashMenuOpen(false);
                                    } else if (item.value === 'switch-cloud') {
                                        setActiveMenu('cloud');
                                    } else if (item.value === 'toggle-tier') {
                                        const nextTier = defaultTier === 1 ? 2 : 1;
                                        setDefaultTier(nextTier);
                                        const modeText = nextTier === 1 ? 'Tier 1 (Local)' : 'Tier 2 (Cloud)';
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
                                    } else {
                                        clientRef.current?.send({
                                            type: 'system:command',
                                            timestamp: new Date().toISOString(),
                                            payload: { command: item.value as any }
                                        });
                                        setIsSlashMenuOpen(false);
                                    }
                                }}
                            />
                        )}
                        {activeMenu === 'cloud' && (
                            <SelectInput
                                items={[
                                    { label: '🟣 Anthropic', value: 'anthropic' },
                                    { label: '🔵 Google (Gemini)', value: 'google' },
                                    { label: '⚪ OpenAI', value: 'openai' },
                                    { label: '⬅️ Back', value: 'back' },
                                ]}
                                onSelect={async (item) => {
                                    if (item.value === 'back') {
                                        setActiveMenu('main');
                                    } else {
                                        const provider = item.value as Tier2Provider;
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
                                        } catch (e) {
                                            setCloudModels([]);
                                        } finally {
                                            setIsFetchingModels(false);
                                        }
                                    }
                                }}
                            />
                        )}
                        {activeMenu === 'cloud-models' && (
                            isFetchingModels ? (
                                <Text color="yellow">⏳ Buscando modelos disponíveis...</Text>
                            ) : (
                                <SelectInput
                                    items={[
                                        ...cloudModels.map(m => ({ label: m.label + (m.hint ? ` (${m.hint})` : ''), value: m.id })),
                                        { label: '⬅️ Back', value: 'back' }
                                    ]}
                                    onSelect={(item) => {
                                        if (item.value === 'back') {
                                            setActiveMenu('cloud');
                                        } else {
                                            clientRef.current?.send({
                                                type: 'system:command',
                                                timestamp: new Date().toISOString(),
                                                payload: {
                                                    command: 'switch-cloud',
                                                    args: { provider: selectedProvider, model: item.value }
                                                }
                                            });
                                            setIsSlashMenuOpen(false);
                                        }
                                    }}
                                />
                            )
                        )}
                        <Text dimColor color="gray"> Esc: cancelar </Text>
                    </Box>
                )}
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
