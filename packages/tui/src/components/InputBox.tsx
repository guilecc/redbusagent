/**
 * InputBox — Text input with slash command palette
 *
 * Renders the prompt input area. When `locked` is true (approval gate active),
 * input is visually disabled and keystrokes are not processed here.
 */

import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';

// ─── Types ────────────────────────────────────────────────────────

export type ActiveMenu = 'main' | 'cloud' | 'cloud-models' | 'mcp-install-id' | 'mcp-install-env';

export interface InputBoxProps {
    readonly inputValue: string;
    readonly isStreaming: boolean;
    readonly isSlashMenuOpen: boolean;
    readonly locked: boolean;
    // Slash menu state
    readonly activeMenu: ActiveMenu;
    readonly defaultTier: 1 | 2;
    // Cloud models
    readonly isFetchingModels: boolean;
    readonly cloudModels: Array<{ label: string; value: string; hint?: string; id: string }>;
    // MCP
    readonly mcpInputStr: string;
    readonly mcpCurrentEnvKey: string;
    // Callbacks
    readonly onMenuSelect: (value: string) => void;
    readonly onCloudProviderSelect: (value: string) => void;
    readonly onCloudModelSelect: (value: string) => void;
    readonly onMcpInputChange: (value: string) => void;
    readonly onMcpInputSubmit: (value: string) => void;
    readonly onMcpEnvSubmit: (value: string) => void;
}

// ─── Component ────────────────────────────────────────────────────

export function InputBox(props: InputBoxProps): React.ReactElement {
    const {
        inputValue, isStreaming, isSlashMenuOpen, locked,
        activeMenu, defaultTier, isFetchingModels, cloudModels,
        mcpInputStr, mcpCurrentEnvKey,
        onMenuSelect, onCloudProviderSelect, onCloudModelSelect,
        onMcpInputChange, onMcpInputSubmit, onMcpEnvSubmit,
    } = props;

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
                    {!isStreaming && !isSlashMenuOpen && <Text color="green" bold>▊</Text>}
                </Text>
            )}

            {isSlashMenuOpen && !locked && (
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
                        {activeMenu === 'main' ? '🚀 COMMAND PALETTE' :
                            activeMenu === 'cloud' ? '☁️ SELECT CLOUD TIER 2' :
                                activeMenu.startsWith('mcp') ? '🔌 INSTALL MCP SERVER' : ''}
                    </Text>

                    {activeMenu === 'main' && (
                        <SelectInput
                            items={[
                                { label: `🔄 /toggle-tier    - Current: ${defaultTier === 1 ? 'Live Engine (Local)' : 'Cloud'}`, value: 'toggle-tier' },
                                { label: '🏗️  /worker         - Send to Worker Engine (heavy task)', value: 'worker' },
                                { label: '🤖 /auto-route     - Restore Cognitive Routing', value: 'auto-route' },
                                { label: '☁️  /switch-cloud  - Change Cloud Provider', value: 'switch-cloud' },
                                { label: '🔌 /mcp install    - Install new MCP Server', value: 'mcp-install' },
                                { label: '🔄 /update          - Install New Version', value: 'update' },
                                { label: '📊 /status        - Daemon & Model Status', value: 'status' },
                                { label: '❌ Close Menu', value: 'close' },
                            ]}
                            onSelect={(item) => onMenuSelect(item.value)}
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
                            onSelect={(item) => onCloudProviderSelect(item.value)}
                        />
                    )}

                    {activeMenu === 'cloud-models' && (
                        isFetchingModels ? (
                            <Text color="yellow">⏳ Fetching available models...</Text>
                        ) : (
                            <SelectInput
                                items={[
                                    ...cloudModels.map(m => ({
                                        label: m.label + (m.hint ? ` (${m.hint})` : ''),
                                        value: m.id,
                                    })),
                                    { label: '⬅️ Back', value: 'back' },
                                ]}
                                onSelect={(item) => onCloudModelSelect(item.value)}
                            />
                        )
                    )}

                    {activeMenu === 'mcp-install-id' && (
                        <Box flexDirection="column">
                            <Text>Enter MCP Name or Command (e.g. npx -y ...):</Text>
                            <TextInput value={mcpInputStr} onChange={onMcpInputChange} onSubmit={onMcpInputSubmit} />
                            <Text dimColor color="gray">Press Enter to submit</Text>
                        </Box>
                    )}

                    {activeMenu === 'mcp-install-env' && (
                        <Box flexDirection="column">
                            <Text>Enter value for <Text color="cyan">{mcpCurrentEnvKey}</Text>:</Text>
                            <TextInput value={mcpInputStr} onChange={onMcpInputChange} onSubmit={onMcpEnvSubmit} />
                        </Box>
                    )}

                    <Text dimColor color="gray"> Esc: cancel </Text>
                </Box>
            )}
        </Box>
    );
}

