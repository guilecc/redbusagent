/**
 * ChatLog — Chat history display (OpenClaw ChatLog-inspired)
 *
 * Renders the conversation between user and agent with message styling,
 * streaming text with cursor, and tool execution indicators.
 */

import React from 'react';
import { Box, Text } from 'ink';

export const MAX_CHAT_LINES = 30;

// ─── Props ────────────────────────────────────────────────────────

export interface ChatLogProps {
    readonly chatLines: readonly string[];
    readonly streamingText: string;
    readonly isStreaming: boolean;
    readonly isUpdating: boolean;
    /** Ephemeral tool activity labels shown during execution, disappear on completion */
    readonly activeTools?: readonly string[];
}

// ─── Helpers ──────────────────────────────────────────────────────

function getLineColor(line: string): { color: string; bold: boolean; dim: boolean } {
    if (line.startsWith('🧑')) return { color: 'white', bold: true, dim: false };
    if (line.startsWith('🔴')) return { color: 'red', bold: true, dim: false };
    if (line.startsWith('🔧')) return { color: 'magenta', bold: false, dim: false };
    if (line.startsWith('✅')) return { color: 'green', bold: false, dim: false };
    if (line.startsWith('❌')) return { color: 'red', bold: false, dim: false };
    if (line.startsWith('⏰')) return { color: 'yellow', bold: true, dim: false };
    if (line.startsWith('🔄')) return { color: 'cyan', bold: false, dim: false };
    // Indented detail lines (tool output previews)
    if (line.startsWith('  ') || line.startsWith('{') || line.startsWith('"')) return { color: 'gray', bold: false, dim: true };
    return { color: 'white', bold: false, dim: false };
}

// ─── Component ────────────────────────────────────────────────────

export function ChatLog({ chatLines, streamingText, isStreaming, isUpdating, activeTools = [] }: ChatLogProps): React.ReactElement {
    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="cyan"
            paddingX={1}
            paddingY={0}
            minHeight={10}
        >
            <Text bold color="cyan" underline>Chat</Text>

            {chatLines.length === 0 && !streamingText ? (
                <Text color="gray" italic>
                    Type a message below and press Enter...
                </Text>
            ) : (
                <>
                    {chatLines.map((line, i) => {
                        const style = getLineColor(line);
                        return (
                            <Text key={i} wrap="wrap" color={style.color as never} bold={style.bold} dimColor={style.dim}>
                                {line}
                            </Text>
                        );
                    })}
                    {/* Ephemeral tool activity indicators */}
                    {activeTools.map((label, i) => (
                        <Text key={`tool-${i}`} color="magenta" italic wrap="wrap">
                            {label}
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
                <Text color="yellow" italic>⏳ Thinking...</Text>
            )}
            {isUpdating && (
                <Text color="cyan" italic>🔄 Updating system... Please wait.</Text>
            )}
        </Box>
    );
}

