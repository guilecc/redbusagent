/**
 * InputBox — Text input
 *
 * Renders the prompt input area. When `locked` is true (approval gate active),
 * input is visually disabled and keystrokes are not processed here.
 */

import React from 'react';
import { Box, Text } from 'ink';

// ─── Types ────────────────────────────────────────────────────────

export interface InputBoxProps {
    readonly inputValue: string;
    readonly isStreaming: boolean;
    readonly locked: boolean;
}

// ─── Component ────────────────────────────────────────────────────

export function InputBox({ inputValue, isStreaming, locked }: InputBoxProps): React.ReactElement {
    const borderColor = locked ? 'red' : isStreaming ? 'yellow' : 'green';
    const promptIcon = locked ? '⏸' : isStreaming ? '⏳' : '❯';

    return (
        <Box
            marginTop={1}
            borderStyle="single"
            borderColor={borderColor}
            paddingX={1}
        >
            <Text color={borderColor} bold>{promptIcon} </Text>

            {locked ? (
                <Text color="red" italic>Input locked — respond to approval gate above</Text>
            ) : (
                <Text>
                    {inputValue}
                    {!isStreaming && <Text color="green" bold>▊</Text>}
                </Text>
            )}
        </Box>
    );
}

