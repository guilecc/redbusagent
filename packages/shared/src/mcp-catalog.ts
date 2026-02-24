/**
 * @redbusagent/shared — MCP Catalog
 *
 * A centralized, hardcoded list of highly recommended MCPs (Model Context Protocol).
 * Users can easily install these via `redbus mcp install <id>` or through the GUI.
 */

export interface MCPSuggestion {
    id: string;
    name: string;
    description: string;
    command: string;
    args: string[];
    requiredEnvVars: string[];
}

export const SUGGESTED_MCPS: MCPSuggestion[] = [
    {
        id: 'scrapling',
        name: 'Scrapling (Advanced Web Stealth)',
        description: 'Bridges our Agent to world-class adversarial web scraping via D4Vinci/Scrapling.',
        command: 'uvx',
        args: ['--python', '3.12', '--with', 'scrapling[ai]', 'scrapling', 'mcp'],
        requiredEnvVars: [], // Add required env vars here if any, e.g., []
    },
    {
        id: 'filesystem',
        name: 'Local File System Access',
        description: 'Official MCP for local file system manipulation.',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/'], // By default mounting root, could be customized
        requiredEnvVars: [],
    },
    {
        id: 'github',
        name: 'GitHub Repository Manager',
        description: 'Official MCP for interacting with the GitHub API.',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        requiredEnvVars: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    }
];

export function getMCPSuggestion(id: string): MCPSuggestion | undefined {
    return SUGGESTED_MCPS.find(m => m.id === id);
}
