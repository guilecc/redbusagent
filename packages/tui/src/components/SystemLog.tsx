/**
 * SystemLog — Compact system log panel
 *
 * Shows the most recent daemon log entries (tool calls, connections, errors).
 * Inspired by OpenClaw's separation of chat from system events.
 */

import React from 'react';
import { Box, Text } from 'ink';

export const MAX_LOG_ENTRIES = 15;

// ─── Types ────────────────────────────────────────────────────────

export interface LogEntry {
    readonly time: string;
    readonly text: string;
    readonly color: string;
}

// ─── Props ────────────────────────────────────────────────────────

export interface SystemLogProps {
    readonly logs: readonly LogEntry[];
    /** Number of recent entries to display */
    readonly displayCount?: number;
}

// ─── Component ────────────────────────────────────────────────────

export function SystemLog({ logs, displayCount = 5 }: SystemLogProps): React.ReactElement {
    const visible = logs.slice(-displayCount);

    return (
        <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
        >
            <Text bold color="gray" underline>System Log</Text>
            {visible.map((entry, i) => (
                <Text key={i}>
                    <Text color="gray" dimColor>[{entry.time}] </Text>
                    <Text color={entry.color as never} dimColor>{entry.text}</Text>
                </Text>
            ))}
        </Box>
    );
}

