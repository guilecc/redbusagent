/**
 * ApprovalGate — HITL Approval Blocker (OpenClaw Gate-inspired)
 *
 * When the daemon is in BLOCKED_WAITING_USER state and an approval request
 * is pending, this component:
 *  1. Renders a prominent approval overlay with tool details
 *  2. Intercepts Y/N keystrokes (locks standard text input)
 *  3. Sends the approval/rejection event back via the onRespond callback
 *
 * The parent Dashboard must pass `useInput` control: when `pending` is set,
 * the Dashboard's useInput handler delegates to this component's onKeypress.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ApprovalRequestMessage } from '@redbusagent/shared';

// ─── Props ────────────────────────────────────────────────────────

export interface ApprovalGateProps {
    /** The pending approval request from the daemon, or null if none */
    readonly pending: ApprovalRequestMessage | null;
    /** Callback: user approved or denied */
    readonly onRespond: (approvalId: string, decision: 'allow-once' | 'deny') => void;
    /** Whether this gate is active (controls useInput interception) */
    readonly active: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────

function formatArgs(args: Record<string, unknown>): string {
    try {
        const str = JSON.stringify(args, null, 2);
        // Truncate long arg displays
        return str.length > 300 ? str.slice(0, 300) + '\n  ...' : str;
    } catch {
        return '(unable to display args)';
    }
}

function formatTimeRemaining(expiresAtMs: number): string {
    const remaining = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
    if (remaining <= 0) return 'expired';
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

// ─── Component ────────────────────────────────────────────────────

export function ApprovalGate({ pending, onRespond, active }: ApprovalGateProps): React.ReactElement | null {
    const [timeLeft, setTimeLeft] = useState('');

    // Update countdown timer
    useEffect(() => {
        if (!pending) return;
        const update = () => setTimeLeft(formatTimeRemaining(pending.payload.expiresAtMs));
        update();
        const timer = setInterval(update, 1000);
        return () => clearInterval(timer);
    }, [pending]);

    // Intercept Y/N keys when gate is active
    useInput((input, key) => {
        if (!active || !pending) return;

        const lower = input.toLowerCase();
        if (lower === 'y') {
            onRespond(pending.payload.approvalId, 'allow-once');
        } else if (lower === 'n' || key.escape) {
            onRespond(pending.payload.approvalId, 'deny');
        }
    }, { isActive: active });

    if (!pending) return null;

    const { toolName, description, reason, args } = pending.payload;
    const reasonColor = reason === 'destructive' ? 'red' : 'yellow';
    const reasonIcon = reason === 'destructive' ? '⚠️' : '🔔';

    return (
        <Box
            flexDirection="column"
            borderStyle="double"
            borderColor={reasonColor}
            paddingX={2}
            paddingY={1}
            marginY={1}
        >
            <Text bold color={reasonColor}>
                {reasonIcon} APPROVAL REQUIRED — {reason.toUpperCase()}
            </Text>
            <Text> </Text>

            <Box flexDirection="column" paddingLeft={1}>
                <Text>
                    <Text bold color="white">Tool: </Text>
                    <Text color="cyan">{toolName}</Text>
                </Text>
                <Text>
                    <Text bold color="white">Action: </Text>
                    <Text>{description}</Text>
                </Text>
                <Text>
                    <Text bold color="white">Args: </Text>
                    <Text color="gray">{formatArgs(args)}</Text>
                </Text>
                <Text>
                    <Text bold color="white">Expires: </Text>
                    <Text color={timeLeft === 'expired' ? 'red' : 'yellow'}>{timeLeft}</Text>
                </Text>
            </Box>

            <Text> </Text>
            <Text bold>
                <Text color="green">[Y]</Text>
                <Text> Approve  </Text>
                <Text color="red">[N]</Text>
                <Text> Deny  </Text>
                <Text color="gray">[Esc]</Text>
                <Text color="gray"> Deny</Text>
            </Text>
        </Box>
    );
}

