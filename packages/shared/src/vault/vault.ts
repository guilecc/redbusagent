/**
 * @redbusagent/shared — The Vault
 *
 * Manages persistent configuration and credentials stored in
 * ~/.redbusagent/config.json. This is the single source of truth
 * for LLM provider keys, model selection, and agent preferences.
 *
 * Security: directory is created with 0o700 (owner only),
 * config file with 0o600 (owner read/write only).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';

// ─── Types ────────────────────────────────────────────────────────

export type Tier2Provider = 'anthropic' | 'google' | 'openai';

export interface VaultTier2Config {
    readonly provider: Tier2Provider;
    readonly model: string;
    /** Raw API key (x-api-key header) */
    readonly apiKey?: string;
    /** OAuth token from `claude setup-token` (Authorization: Bearer) */
    readonly authToken?: string;
}

export interface VaultTier1Config {
    readonly enabled: boolean;
    readonly url: string;
    readonly model: string;
}

export interface VaultConfig {
    /** Schema version for future migrations */
    readonly version: number;
    readonly tier2: VaultTier2Config;
    readonly tier1: VaultTier1Config;
}

// ─── Constants ────────────────────────────────────────────────────

const VAULT_DIR = join(homedir(), '.redbusagent');
const CONFIG_FILE = join(VAULT_DIR, 'config.json');
const CURRENT_VERSION = 1;

// ─── Vault Class ──────────────────────────────────────────────────

export class Vault {
    /** In-memory cache to avoid repeated disk reads */
    private static cache: VaultConfig | null | undefined = undefined;

    /** Path to the vault directory */
    static get dir(): string {
        return VAULT_DIR;
    }

    /** Path to the config file */
    static get configPath(): string {
        return CONFIG_FILE;
    }

    /** Check if the config file exists on disk */
    static exists(): boolean {
        return existsSync(CONFIG_FILE);
    }

    /** Read config from disk (with in-memory cache) */
    static read(): VaultConfig | null {
        if (this.cache !== undefined) return this.cache;

        if (!this.exists()) {
            this.cache = null;
            return null;
        }

        try {
            const raw = readFileSync(CONFIG_FILE, 'utf-8');
            const parsed = JSON.parse(raw) as VaultConfig;
            this.cache = parsed;
            return parsed;
        } catch {
            this.cache = null;
            return null;
        }
    }

    /** Write config to disk and update cache */
    static write(config: VaultConfig): void {
        if (!existsSync(VAULT_DIR)) {
            mkdirSync(VAULT_DIR, { recursive: true, mode: 0o700 });
        }

        writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
            encoding: 'utf-8',
            mode: 0o600,
        });

        this.cache = config;
    }

    /** Check if vault has valid Tier 2 credentials */
    static isConfigured(): boolean {
        const config = this.read();
        if (!config?.tier2) return false;

        switch (config.tier2.provider) {
            case 'anthropic':
                return !!(config.tier2.apiKey || config.tier2.authToken);
            case 'google':
            case 'openai':
                return !!config.tier2.apiKey;
            default:
                return false;
        }
    }

    /** Clear the in-memory cache (forces next read from disk) */
    static clearCache(): void {
        this.cache = undefined;
    }

    /** Get the current schema version */
    static get schemaVersion(): number {
        return CURRENT_VERSION;
    }

    /** Create a default config object */
    static createDefault(overrides?: Partial<VaultConfig>): VaultConfig {
        return {
            version: CURRENT_VERSION,
            tier2: {
                provider: 'anthropic',
                model: 'claude-sonnet-4-20250514',
                ...overrides?.tier2,
            },
            tier1: {
                enabled: true,
                url: 'http://127.0.0.1:11434',
                model: 'llama3',
                ...overrides?.tier1,
            },
        };
    }
}
