/**
 * install_mcp — Allows the LLM agent to install and activate a new MCP server at runtime.
 *
 * The agent can discover MCPs via web_search / web_read_page and then use this tool
 * to register, persist (Vault) and spawn them in-process without restarting the daemon.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { MCPEngine } from '../mcp-engine.js';
import { Vault } from '@redbusagent/shared';
import { approvalGate } from '../approval-gate.js';

export const installMcpTool = tool({
    description:
        'Installs and activates a new MCP (Model Context Protocol) server at runtime. ' +
        'The MCP will be persisted in the Vault and spawned immediately so its tools become available. ' +
        'Use web_search and web_read_page first to discover available MCPs (e.g. on npm, PyPI, GitHub, registry.modelcontextprotocol.io). ' +
        'Common patterns: npx -y @scope/server-name (Node), uvx mcp-server-name (Python), docker run -i image (Docker).',
    inputSchema: z.object({
        id: z.string().describe('Unique identifier for the MCP (e.g. "memory", "fetch", "github"). Must be alphanumeric with hyphens/underscores.'),
        name: z.string().describe('Human-readable name for the MCP (e.g. "Knowledge Graph Memory")'),
        command: z.string().describe('The executable command (e.g. "npx", "uvx", "docker")'),
        args: z.array(z.string()).describe('Arguments for the command (e.g. ["-y", "@modelcontextprotocol/server-memory"])'),
        env: z.record(z.string(), z.string()).optional().describe('Optional environment variables required by the MCP (e.g. { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." })'),
        flagToolsAs: z.enum(['destructive', 'intrusive']).optional().describe('If set, all tools discovered from this MCP will require user approval before execution (destructive = data loss risk, intrusive = external communication risk).'),
    }),
    execute: async ({ id, name, command, args, env, flagToolsAs }) => {
        const mcpEnv = env ?? {};

        console.log(`  🔌 Installing MCP: ${name} (${id}) — ${command} ${args.join(' ')}`);

        // ── 1. Validate the ID ──────────────────────────────────────────
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
            return {
                success: false,
                error: `Invalid MCP id "${id}". Use only alphanumeric characters, hyphens and underscores.`,
            };
        }

        // ── 2. Persist to Vault ─────────────────────────────────────────
        try {
            const config = Vault.read();
            if (!config) {
                return { success: false, error: 'Vault is not configured. Please run `redbus config` first.' };
            }

            const updatedMcps = {
                ...(config.mcps || {}),
                [id]: { command, args, env: mcpEnv },
            };

            Vault.write({ ...config, mcps: updatedMcps });
        } catch (err: any) {
            return { success: false, error: `Failed to persist MCP to Vault: ${err.message}` };
        }

        // ── 3. Spawn and connect via MCPEngine ──────────────────────────
        try {
            const engine = MCPEngine.getInstance();
            const discoveredTools = await engine.addMCP(id, command, args, mcpEnv);

            const toolNames = discoveredTools.map(t => t.toolName);

            // ── 4. Register approval flags for MCP tools if requested ──
            if (flagToolsAs && toolNames.length > 0) {
                for (const tn of toolNames) {
                    const sdkName = `mcp_x_${tn.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
                    approvalGate.registerToolFlags(sdkName, {
                        destructive: flagToolsAs === 'destructive',
                        intrusive: flagToolsAs === 'intrusive',
                    });
                }
                console.log(`  🛡️ MCP "${name}" tools flagged as ${flagToolsAs} — approval required.`);
            }

            console.log(`  ✅ MCP "${name}" installed successfully. Discovered ${toolNames.length} tool(s): ${toolNames.join(', ') || '(none)'}`);

            return {
                success: true,
                mcpId: id,
                name,
                toolsDiscovered: toolNames.length,
                tools: discoveredTools.map(t => ({
                    name: t.toolName,
                    description: t.description,
                })),
                message: toolNames.length > 0
                    ? `MCP "${name}" installed and active. ${toolNames.length} tool(s) are now available: ${toolNames.join(', ')}`
                    : `MCP "${name}" installed and connected, but no tools were exposed by the server.`,
            };
        } catch (err: any) {
            // If spawn fails, remove from Vault to avoid broken config on next restart
            try {
                const config = Vault.read();
                if (config?.mcps?.[id]) {
                    const { [id]: _removed, ...remainingMcps } = config.mcps;
                    Vault.write({ ...config, mcps: remainingMcps });
                }
            } catch { /* best-effort cleanup */ }

            return {
                success: false,
                error: `MCP "${name}" failed to start: ${err.message}. The configuration was rolled back.`,
            };
        }
    },
});

