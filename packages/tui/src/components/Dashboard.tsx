/**
 * @redbusagent/tui — Dashboard Component
 *
 * The main TUI panel that renders the daemon's heartbeat feed
 * and connection status. Built with Ink (React for terminals)
 * to allow composable, declarative terminal UIs.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text } from 'ink';
import type { DaemonMessage, HeartbeatMessage } from '@redbusagent/shared';
import {
    APP_NAME,
    APP_VERSION,
    DEFAULT_HOST,
    DEFAULT_PORT,
} from '@redbusagent/shared';
import { TuiWsClient } from '../infra/ws-client.js';

function formatUptime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

interface LogEntry {
    readonly time: string;
    readonly text: string;
    readonly color: string;
}

const MAX_LOG_ENTRIES = 20;

export function Dashboard(): React.ReactElement {
    const [connected, setConnected] = useState(false);
    const [lastHeartbeat, setLastHeartbeat] = useState<HeartbeatMessage | null>(null);
    const [logs, setLogs] = useState<LogEntry[]>([]);

    const addLog = useCallback((text: string, color = 'white') => {
        const time = new Date().toLocaleTimeString('pt-BR');
        setLogs((prev) => [...prev.slice(-(MAX_LOG_ENTRIES - 1)), { time, text, color }]);
    }, []);

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
                switch (message.type) {
                    case 'heartbeat':
                        setLastHeartbeat(message);
                        addLog(
                            `💓 Heartbeat — PID: ${message.payload.pid} | Porta: ${message.payload.port} | Uptime: ${formatUptime(message.payload.uptimeMs)}`,
                            'magenta',
                        );
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
                }
            },
        });

        client.connect();
        addLog(`Conectando a ${url}...`, 'gray');

        return () => {
            client.disconnect();
        };
    }, [addLog]);

    return (
        <Box flexDirection="column" padding={1}>
            {/* ── Header ──────────────────────────────────────────── */}
            <Box borderStyle="double" borderColor="red" paddingX={2}>
                <Text bold color="red">
                    🔴 {APP_NAME}
                </Text>
                <Text color="gray"> v{APP_VERSION}</Text>
                <Text>  </Text>
                <Text color={connected ? 'green' : 'yellow'}>
                    {connected ? '● Conectado' : '○ Desconectado'}
                </Text>
            </Box>

            {/* ── Status Bar ──────────────────────────────────────── */}
            {lastHeartbeat && (
                <Box marginTop={1} gap={3}>
                    <Text>
                        <Text color="gray">PID: </Text>
                        <Text bold>{lastHeartbeat.payload.pid}</Text>
                    </Text>
                    <Text>
                        <Text color="gray">Porta: </Text>
                        <Text bold>{lastHeartbeat.payload.port}</Text>
                    </Text>
                    <Text>
                        <Text color="gray">Uptime: </Text>
                        <Text bold color="green">
                            {formatUptime(lastHeartbeat.payload.uptimeMs)}
                        </Text>
                    </Text>
                </Box>
            )}

            {/* ── Log Feed ────────────────────────────────────────── */}
            <Box
                flexDirection="column"
                marginTop={1}
                borderStyle="single"
                borderColor="gray"
                paddingX={1}
                paddingY={0}
            >
                <Text bold color="white" underline>
                    Log Feed
                </Text>
                {logs.length === 0 ? (
                    <Text color="gray" italic>
                        Aguardando mensagens do daemon...
                    </Text>
                ) : (
                    logs.map((entry, i) => (
                        <Text key={i}>
                            <Text color="gray">[{entry.time}] </Text>
                            <Text color={entry.color as never}>{entry.text}</Text>
                        </Text>
                    ))
                )}
            </Box>

            {/* ── Footer ──────────────────────────────────────────── */}
            <Box marginTop={1}>
                <Text color="gray" italic>
                    Ctrl+C para sair
                </Text>
            </Box>
        </Box>
    );
}
