/**
 * StatusBar — Persistent daemon state bar (OpenClaw-inspired)
 *
 * Displays: DaemonState, heartbeat tick, uptime, active/pending tasks,
 * approval status, and connected clients. Reacts to HeartbeatMessage ticks.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { DaemonState, HeartbeatMessage } from '@redbusagent/shared';

// ─── Helpers ──────────────────────────────────────────────────────

function formatUptime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

const STATE_LABELS: Record<DaemonState, { text: string; color: string; icon: string }> = {
    IDLE: { text: 'IDLE', color: 'green', icon: '●' },
    THINKING: { text: 'THINKING', color: 'yellow', icon: '◐' },
    EXECUTING_TOOL: { text: 'EXEC', color: 'magenta', icon: '⚡' },
    BLOCKED_WAITING_USER: { text: 'BLOCKED', color: 'red', icon: '⏸' },
};

// ─── Props ────────────────────────────────────────────────────────

export interface StatusBarProps {
    readonly connected: boolean;
    readonly heartbeat: HeartbeatMessage | null;
    readonly currentModel: string | null;
}

// ─── Component ────────────────────────────────────────────────────

export function StatusBar({ connected, heartbeat, currentModel }: StatusBarProps): React.ReactElement {
    const payload = heartbeat?.payload;
    const stateInfo = payload ? STATE_LABELS[payload.state] : null;

    return (
        <Box
            borderStyle="single"
            borderColor={stateInfo?.color ?? 'gray'}
            paddingX={1}
            justifyContent="space-between"
        >
            {/* Left: State + Connection */}
            <Box gap={2}>
                <Text color={connected ? 'green' : 'yellow'}>
                    {connected ? '● Connected' : '○ Disconnected'}
                </Text>
                {stateInfo && (
                    <Text color={stateInfo.color as never} bold>
                        {stateInfo.icon} {stateInfo.text}
                    </Text>
                )}
            </Box>

            {/* Center: Tasks & Approval */}
            <Box gap={2}>
                {payload && payload.activeTasks > 0 && (
                    <Text color="cyan">
                        ⚙ Active:{payload.activeTasks}
                    </Text>
                )}
                {payload && payload.pendingTasks > 0 && (
                    <Text color="gray">
                        ◷ Queued:{payload.pendingTasks}
                    </Text>
                )}
                {payload?.awaitingApproval && (
                    <Text color="red" bold>
                        ⏸ APPROVAL NEEDED
                    </Text>
                )}
            </Box>

            {/* Right: Uptime, Model, Tick */}
            <Box gap={2}>
                {currentModel && (
                    <Text color="magenta">🧠 {currentModel}</Text>
                )}
                {payload && (
                    <Text color="gray">
                        ⏱{formatUptime(payload.uptimeMs)} T:{payload.tick} C:{payload.connectedClients}
                    </Text>
                )}
            </Box>
        </Box>
    );
}

