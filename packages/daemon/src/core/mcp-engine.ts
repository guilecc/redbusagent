import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Vault } from '@redbusagent/shared';

export interface MCPToolInfo {
    mcpId: string;
    serverName: string;
    toolName: string;
    description: string;
    inputSchema: any;
}

export class MCPEngine {
    private static instance: MCPEngine;
    private clients: Map<string, Client> = new Map();
    private toolsCache: MCPToolInfo[] = [];
    private isInitializing = false;

    private constructor() { }

    static getInstance(): MCPEngine {
        if (!MCPEngine.instance) {
            MCPEngine.instance = new MCPEngine();
        }
        return MCPEngine.instance;
    }

    /**
     * Spawns all MCPs configured in the Vault, connects to them via stdio,
     * and fetches their capabilities (tools).
     */
    async initialize(): Promise<void> {
        if (this.isInitializing) return;
        this.isInitializing = true;
        this.toolsCache = [];

        try {
            const config = Vault.read();
            if (!config || !config.mcps) return;

            for (const [mcpId, mcpConfig] of Object.entries(config.mcps)) {
                await this.spawnMCP(mcpId, mcpConfig.command, mcpConfig.args, mcpConfig.env);
            }
        } finally {
            this.isInitializing = false;
        }
    }

    /**
     * Public method to add and spawn a new MCP server at runtime.
     * Returns the list of tools exposed by the new MCP, or throws on failure.
     */
    async addMCP(mcpId: string, command: string, args: string[], env: Record<string, string> = {}): Promise<MCPToolInfo[]> {
        // If already connected, close the existing client first
        const existing = this.clients.get(mcpId);
        if (existing) {
            try { await existing.close(); } catch { /* ignore */ }
            this.clients.delete(mcpId);
            this.toolsCache = this.toolsCache.filter(t => t.mcpId !== mcpId);
        }

        await this.spawnMCP(mcpId, command, args, env);

        // Return the tools that were just discovered for this MCP
        return this.toolsCache.filter(t => t.mcpId === mcpId);
    }

    private async spawnMCP(mcpId: string, command: string, args: string[], env: Record<string, string>): Promise<void> {
        // Declared outside try so catch can access stderr diagnostics
        const stderrChunks: Buffer[] = [];

        try {
            console.log(`[MCPEngine] Spawning MCP ${mcpId} with command: ${command} ${args.join(' ')}`);

            // Because StdioClientTransport explicitly sets shell: false, we must
            // manually wrap commands in a shell so that global tools like `uvx`
            // and `npx` resolve correctly from the system PATH/environment.
            const isWin = process.platform === "win32";
            const shellCommand = isWin ? "cmd.exe" : "sh";

            // Safely join the arguments. If an argument has spaces, this simple join
            // might fail. A robust implementation would escape quotes.
            // For now, most MCP commands are simple: "uvx", ["mcp-server-scrapling"]
            const fullCommand = [command, ...args].map(arg => arg.includes(' ') ? `"${arg}"` : arg).join(' ');
            const shellArgs = isWin ? ["/c", fullCommand] : ["-c", fullCommand];

            // Ensure PATH contains common locations where `uvx`, `npx` and Homebrew binaries live.
            // This is crucial in daemon environments or macOS UI wrappers that don't load full bash profiles.
            const basePath = process.env['PATH'] || '';
            const home = process.env['HOME'] || process.env['USERPROFILE'] || '';
            const extendedPath = basePath
                + (isWin ? ';' : ':') + '/opt/homebrew/bin'
                + (isWin ? ';' : ':') + '/usr/local/bin'
                + (home ? (isWin ? ';' : ':') + `${home}/.local/bin` : '');

            const transport = new StdioClientTransport({
                command: shellCommand,
                args: shellArgs,
                stderr: 'pipe',
                env: {
                    ...(process.env as Record<string, string>),
                    PATH: extendedPath,
                    ...env, // Overwrite with Vault envs
                },
            });

            // The SDK creates a PassThrough stream for stderr in the constructor
            // (before start/connect), so we can attach a listener immediately.
            // This ensures we capture stderr even if the process dies during connect().
            if (transport.stderr) {
                transport.stderr.on('data', (chunk: Buffer) => {
                    stderrChunks.push(chunk);
                    // Keep only last 8KB to avoid memory bloat
                    while (stderrChunks.reduce((s, c) => s + c.length, 0) > 8192) {
                        stderrChunks.shift();
                    }
                });
            }

            transport.onerror = (err) => {
                console.error(`[MCPEngine] Transport error for ${mcpId}:`, err);
            };

            // The client name could be 'redbusagent'
            const client = new Client(
                {
                    name: "redbusagent",
                    version: "1.0.0",
                },
                {
                    capabilities: {},
                }
            );

            // connect() calls transport.start() internally, which spawns the process
            await client.connect(transport);
            this.clients.set(mcpId, client);

            // Fetch tools from the MCP server
            const toolsResponse = await client.listTools();
            if (toolsResponse && toolsResponse.tools) {
                for (const tool of toolsResponse.tools) {
                    this.toolsCache.push({
                        mcpId,
                        serverName: command,
                        toolName: tool.name,
                        description: tool.description || `Tool ${tool.name} from ${mcpId}`,
                        inputSchema: tool.inputSchema,
                    });
                }
            }
        } catch (error) {
            // Wait briefly for any remaining stderr data to arrive via the pipe
            await new Promise(resolve => setTimeout(resolve, 500));

            // Dump captured stderr to help diagnose the failure
            if (stderrChunks.length > 0) {
                const stderrText = Buffer.concat(stderrChunks).toString('utf-8').trim();
                console.error(`[MCPEngine] stderr from MCP ${mcpId}:\n${stderrText}`);
            } else {
                console.error(`[MCPEngine] No stderr output captured from MCP ${mcpId} (process may have died before producing output)`);
            }
            console.error(`[MCPEngine] Failed to spawn MCP ${mcpId}:`, error);
        }
    }

    /**
     * Retrieves all discovered tools from connected MCP servers.
     */
    getTools(): MCPToolInfo[] {
        return this.toolsCache;
    }

    /**
     * Executes a tool dynamically on the corresponding MCP server.
     */
    async callTool(mcpId: string, toolName: string, args: Record<string, unknown>): Promise<any> {
        const client = this.clients.get(mcpId);
        if (!client) {
            throw new Error(`MCP client ${mcpId} not found or not connected.`);
        }

        const result = await client.callTool({
            name: toolName,
            arguments: args,
        });

        // The result format from callTool is typically { content: [{ type: 'text', text: '...' }] }
        // We can stringify the content to return it to the LLM
        return result.content;
    }

    /**
     * Retrieves the IDs of all currently connected MCP servers.
     */
    getConnectedMCPs(): string[] {
        return Array.from(this.clients.keys());
    }

    /**
     * Stops all running MCP servers.
     */
    async stop(): Promise<void> {
        for (const [mcpId, client] of this.clients.entries()) {
            try {
                await client.close();
            } catch (err) {
                console.error(`[MCPEngine] Error closing MCP ${mcpId}:`, err);
            }
        }
        this.clients.clear();
        this.toolsCache = [];
    }
}
