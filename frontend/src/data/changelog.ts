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
        date: "2026-02-24",
        title: "Initial Ignition",
        type: "major",
        changes: [
            "Complete system rewrite and open source release.",
            "Added brutalist landing page for easier onboarding.",
            "Integrated AES-256 Vault for pure paranoia mode.",
            "Implemented headless Playwright integration for browsing.",
            "Added WhatsApp Bridge for remote control."
        ]
    }
];
