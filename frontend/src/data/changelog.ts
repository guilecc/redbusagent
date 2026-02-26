export interface ChangelogEntry {
    version: string;
    date: string;
    title: string;
    changes: string[];
    type: 'major' | 'minor' | 'patch';
}

export const changelogData: ChangelogEntry[] = [
    {
        version: "v0.1.2",
        date: "2026-02-26",
        title: "SEO & Tone Pass",
        type: "patch",
        changes: [
            "🔍 Full SEO layer added. Open Graph, Twitter Cards, JSON-LD structured data, robots.txt, sitemap.xml.",
            "🏷️ Canonical URL, meta keywords, and author tags. Google can index us now.",
            "✏️ Toned down the copy across the entire site. Less edgy, more confident. Same energy, fewer expletives."
        ]
    },
    {
        version: "v0.1.1",
        date: "2026-02-26",
        title: "Language Purge",
        type: "patch",
        changes: [
            "🌐 Switched all Portuguese to English across meta tags, titles, and descriptions.",
            "🔤 Full English-only landing page."
        ]
    },
    {
        version: "v0.1.0",
        date: "2026-02-25",
        title: "Initial Ignition",
        type: "major",
        changes: [
            "🧠 Initial open release. Built from scratch.",
            "🤖 Dual-Tier Engine: Heuristic complexity router that decides when to use local zero-cost models or escalate to Cloud LLMs.",
            "🔌 Universal MCP Gateway: Full support for Model Context Protocol servers.",
            "🛡️ Security Gate: System shell executor explicitly asks authorization before running commands.",
            "🛡️ AES-256 Vault: Native storage encryption for all your API keys. Pure paranoia mode."
        ]
    }
];
