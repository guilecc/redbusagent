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
    statSync,
} from 'node:fs';
import crypto from 'node:crypto';

// ─── Types ────────────────────────────────────────────────────────

export type Tier2Provider = 'anthropic' | 'google' | 'openai';

/** Provider type for any engine slot (cloud API or local Ollama) */
export type EngineProvider = 'ollama' | 'anthropic' | 'google' | 'openai';

export interface VaultTier2Config {
    readonly provider: Tier2Provider;
    readonly model: string;
    /** Raw API key (x-api-key header) */
    readonly apiKey?: string;
    /** OAuth token from `claude setup-token` (Authorization: Bearer) */
    readonly authToken?: string;
}

/** Power class for engine capability classification */
export type PowerClass = 'bronze' | 'silver' | 'gold' | 'platinum';
/** @deprecated Use PowerClass instead */
export type Tier1PowerClass = PowerClass;

/** @deprecated Legacy config — use VaultLiveEngineConfig instead */
export interface VaultTier1Config {
    readonly enabled: boolean;
    readonly url: string;
    readonly model: string;
    readonly power_class?: PowerClass;
}

// ─── Dual-Cloud Architecture: Live Engine + Worker Engine ──────────

/**
 * Live Engine: Fast, low-latency cloud model for instant TUI/WhatsApp chat.
 * Default: Google Gemini 2.5 Flash (cheapest + fast).
 * Also supports: Anthropic, OpenAI, or local Ollama.
 */
export interface VaultLiveEngineConfig {
    readonly enabled: boolean;
    /** Provider: 'anthropic'/'google'/'openai' for cloud, 'ollama' for local */
    readonly provider?: EngineProvider;
    readonly url: string;
    readonly model: string;
    readonly power_class?: PowerClass;
    /** API key for cloud providers */
    readonly apiKey?: string;
}

/**
 * Worker Engine: High-intelligence cloud model for background tasks.
 * Default: Claude Sonnet 4 (best reasoning/cost ratio).
 * Handles: memory distillation, insight generation, deep analysis.
 */
export interface VaultWorkerEngineConfig {
    readonly enabled: boolean;
    /** Provider: 'anthropic'/'google'/'openai' for cloud, 'ollama' for local */
    readonly provider?: EngineProvider | null;
    readonly url: string;
    readonly model?: string | null;
    /** API key for cloud providers */
    readonly apiKey?: string;
    /** Number of CPU threads (legacy, only for Ollama) */
    readonly num_threads?: number;
    /** Context window size (legacy, only for Ollama) */
    readonly num_ctx?: number;
    /** OAuth token from `claude setup-token` (Authorization: Bearer) */
    readonly authToken?: string;
}

export interface VaultConfig {
    /** Schema version for future migrations */
    readonly version: number;
    readonly tier2_enabled?: boolean;
    readonly tier2: VaultTier2Config;
    /** @deprecated Legacy — use live_engine instead */
    readonly tier1?: VaultTier1Config;

    // ─── Dual-Cloud Architecture ────────────────────────────────
    /** Live Engine: Fast, low-latency cloud model for real-time chat */
    readonly live_engine?: VaultLiveEngineConfig;
    /** Worker Engine: High-intelligence cloud model for background tasks */
    readonly worker_engine?: VaultWorkerEngineConfig;

    /**
     * The default engine tier for chat communication (1 for Live Engine, 2 for Worker Engine).
     */
    readonly default_chat_tier?: 1 | 2;
    /**
     * 🛡️ Owner Firewall: Phone number of the sole owner.
     * Only this number (as ${number}@c.us) is allowed to interact
     * with the WhatsApp channel. Digits only, with country+area code.
     * Example: "5511999999999"
     */
    readonly owner_phone_number?: string;
    readonly credentials?: Record<string, { username: string; encrypted: string; iv: string }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly sessions?: Record<string, any>;
    /**
     * MCP Servers installed by the user.
     * key: MCP ID (e.g. "scrapling", "custom-1")
     * value: command, args, and required environment variables mapped.
     */
    readonly mcps?: Record<string, { command: string, args: string[], env: Record<string, string> }>;
    /**
     * GOD MODE: Allows agent to execute OS terminal commands without user supervision.
     */
    readonly shell_god_mode?: boolean;
    /**
     * Detected hardware profile persisted during onboarding.
     * Used by the Router to make informed routing decisions.
     */
    readonly hardware_profile?: {
        readonly gpu_name: string;
        readonly vram_gb: number;
        readonly system_ram_gb: number;
    };
    /** Optional flag to explicitly enable or disable local GPU offloading. */
    readonly gpu_acceleration?: boolean;
}


// ─── Constants ────────────────────────────────────────────────────

const VAULT_DIR = join(homedir(), '.redbusagent');
const CONFIG_FILE = join(VAULT_DIR, 'config.json');
const MASTER_KEY_FILE = join(VAULT_DIR, '.masterkey');
const CURRENT_VERSION = 1;

// ─── Helpers ──────────────────────────────────────────────────────

function getMasterKey(): Buffer {
    if (existsSync(MASTER_KEY_FILE)) {
        return readFileSync(MASTER_KEY_FILE);
    }
    const key = crypto.randomBytes(32);
    if (!existsSync(VAULT_DIR)) {
        mkdirSync(VAULT_DIR, { recursive: true, mode: 0o700 });
    }
    writeFileSync(MASTER_KEY_FILE, key, { mode: 0o600 });
    return key;
}

// ─── Vault Class ──────────────────────────────────────────────────

export class Vault {
    /** In-memory cache to avoid repeated disk reads */
    private static cache: VaultConfig | null | undefined = undefined;
    /** mtime of config file when cache was last populated */
    private static cacheMtimeMs: number | undefined = undefined;

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

    /** Read config from disk (with mtime-aware cache) */
    static read(): VaultConfig | null {
        // Check if file has been modified externally (e.g., by CLI while daemon is running)
        if (this.cache !== undefined && this.cacheMtimeMs !== undefined) {
            try {
                const currentMtime = statSync(CONFIG_FILE).mtimeMs;
                if (currentMtime !== this.cacheMtimeMs) {
                    // File changed on disk — invalidate cache
                    this.cache = undefined;
                    this.cacheMtimeMs = undefined;
                }
            } catch {
                // File may have been deleted — invalidate cache
                this.cache = undefined;
                this.cacheMtimeMs = undefined;
            }
        }

        if (this.cache !== undefined) return this.cache;

        if (!this.exists()) {
            this.cache = null;
            return null;
        }

        try {
            const raw = readFileSync(CONFIG_FILE, 'utf-8');
            const parsed = JSON.parse(raw) as VaultConfig;
            this.cache = parsed;
            this.cacheMtimeMs = statSync(CONFIG_FILE).mtimeMs;
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
        try { this.cacheMtimeMs = statSync(CONFIG_FILE).mtimeMs; } catch { /* ignore */ }
    }

    /** Check if vault has valid credentials */
    static isConfigured(): boolean {
        const config = this.read();

        // If entirely skipped, it's configured for local mode
        if (config?.tier2_enabled === false) return true;

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

    /**
     * 🛡️ Owner Firewall: Returns the owner's WhatsApp JID (e.g. "5511999999999@c.us")
     * or null if not configured. This is the ONLY allowed recipient/sender.
     */
    static getOwnerWhatsAppJid(): string | null {
        const config = this.read();
        if (!config?.owner_phone_number) return null;
        return `${config.owner_phone_number}@c.us`;
    }

    /** Create a default config object (Cloud-First defaults) */
    static createDefault(overrides?: Partial<VaultConfig>): VaultConfig {
        return {
            version: CURRENT_VERSION,
            tier2_enabled: overrides?.tier2_enabled ?? true,
            tier2: {
                provider: 'anthropic',
                model: 'claude-sonnet-4-20250514',
                ...overrides?.tier2,
            },
            // tier1 intentionally omitted — legacy field
            live_engine: {
                enabled: true,
                provider: 'google',
                url: '',
                model: 'gemini-2.5-flash',
                ...overrides?.live_engine,
            },
            worker_engine: {
                enabled: true,
                provider: 'anthropic',
                url: '',
                model: 'claude-sonnet-4-20250514',
                ...overrides?.worker_engine,
            },
            default_chat_tier: overrides?.default_chat_tier ?? 1,
            credentials: {},
            sessions: {},
            mcps: {},
        };
    }

    /** Store an encrypted credential for a domain */
    static storeCredential(domain: string, username: string, passwordPlain: string): void {
        const config = this.read() || this.createDefault();
        const masterKey = getMasterKey();
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', masterKey, iv);
        let encrypted = cipher.update(passwordPlain, 'utf8', 'hex');
        encrypted += cipher.final('hex');

        const updated: VaultConfig = {
            ...config,
            credentials: {
                ...(config.credentials || {}),
                [domain]: { username, encrypted, iv: iv.toString('hex') }
            }
        };
        this.write(updated);
    }

    /** Retrieve and decrypt a credential for a domain */
    static getCredential(domain: string): { username: string; passwordPlain: string } | null {
        const config = this.read();
        const cred = config?.credentials?.[domain];
        if (!cred) return null;

        try {
            const masterKey = getMasterKey();
            const decipher = crypto.createDecipheriv('aes-256-cbc', masterKey, Buffer.from(cred.iv, 'hex'));
            let decrypted = decipher.update(cred.encrypted, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return { username: cred.username, passwordPlain: decrypted };
        } catch {
            return null;
        }
    }

    /** Store browser session state (e.g. Playwright storageState) */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static storeBrowserSession(domain: string, stateJson: any): void {
        const config = this.read() || this.createDefault();
        const updated: VaultConfig = {
            ...config,
            sessions: {
                ...(config.sessions || {}),
                [domain]: stateJson
            }
        };
        this.write(updated);
    }

    /** Retrieve browser session state */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static getBrowserSession(domain: string): any | null {
        const config = this.read();
        return config?.sessions?.[domain] || null;
    }
}
