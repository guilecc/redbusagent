export interface ChangelogEntry {
    version: string;
    date: string;
    title: string;
    changes: string[];
    type: 'major' | 'minor' | 'patch';
}

export const changelogData: ChangelogEntry[] = [
    {
        version: "v0.1.0",
        date: "2026-02-25",
        title: "Initial Ignition",
        type: "major",
        changes: [
            "🧠 Initial open release. Yeah, I built this shit from absolute scratch.",
            "🤖 Dual-Tier Engine: Heuristic complexity router that decides when to use local zero-cost models or escalate to Cloud LLMs.",
            "🔌 Universal MCP Gateway: Full support for Model Context Protocol servers.",
            "🛡️ Security Gate: System shell executor explicitly asks authorization before running commands.",
            "🛡️ AES-256 Vault: Native storage encryption for all your API keys. Pure paranoia mode."
        ]
    }
];
