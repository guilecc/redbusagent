/**
 * @redbusagent/daemon — LLM Configuration
 *
 * Reads LLM provider configuration dynamically from the Vault
 * (~/.redbusagent/config.json). No more .env for credentials.
 *
 * All functions read from vault on each call so that config changes
 * (e.g. via `redbus config`) take effect without daemon restart.
 */

import { Vault, type VaultConfig, type Tier2Provider, type EngineProvider } from '@redbusagent/shared';

// Re-export the type for convenience
export type { Tier2Provider, EngineProvider };

// ─── Tier 1 (Ollama / Local) — backward compat ───────────────────

export function getTier1Config(): { url: string; model: string; enabled: boolean; power_class?: string } {
    const config = Vault.read();
    return {
        url: config?.tier1?.url ?? 'http://127.0.0.1:11434',
        model: config?.tier1?.model ?? 'llama3',
        enabled: config?.tier1?.enabled ?? true,
        power_class: config?.tier1?.power_class,
    };
}

// ─── Live Engine (real-time chat — local or cloud) ────────────────

export interface LiveEngineConfig {
    url: string;
    model: string;
    enabled: boolean;
    power_class?: string;
    provider: EngineProvider;
    apiKey?: string;
}

export function getLiveEngineConfig(): LiveEngineConfig {
    const config = Vault.read();
    // Fall back to tier1 config if live_engine not configured (backward compat)
    if (config?.live_engine) {
        return {
            url: config.live_engine.url ?? 'http://127.0.0.1:11434',
            model: config.live_engine.model ?? 'llama3.2:3b',
            enabled: config.live_engine.enabled ?? true,
            power_class: config.live_engine.power_class,
            provider: config.live_engine.provider ?? 'ollama',
            apiKey: config.live_engine.apiKey,
        };
    }
    const t1 = getTier1Config();
    return { ...t1, provider: 'ollama' };
}

// ─── Worker Engine (background heavy tasks — local or cloud) ──────

export interface WorkerEngineConfig {
    url: string;
    model: string;
    enabled: boolean;
    num_threads: number;
    num_ctx: number;
    provider: EngineProvider;
    apiKey?: string;
}

export function getWorkerEngineConfig(): WorkerEngineConfig {
    const config = Vault.read();
    return {
        url: config?.worker_engine?.url ?? 'http://127.0.0.1:11434',
        model: config?.worker_engine?.model ?? 'qwen2.5-coder:14b',
        enabled: config?.worker_engine?.enabled ?? false,
        num_threads: config?.worker_engine?.num_threads ?? 8,
        num_ctx: config?.worker_engine?.num_ctx ?? 8192,
        provider: config?.worker_engine?.provider ?? 'ollama',
        apiKey: config?.worker_engine?.apiKey,
    };
}

// ─── Tier 2 (Cloud / Premium) ─────────────────────────────────────

export function getTier2Config(): { provider: Tier2Provider; model: string } | null {
    const config = Vault.read();
    if (!config?.tier2) return null;
    return {
        provider: config.tier2.provider,
        model: config.tier2.model,
    };
}

// ─── Anthropic Auth Resolution ────────────────────────────────────

export interface AnthropicAuth {
    method: 'oauth_token' | 'api_key' | 'none';
    authToken?: string;
    apiKey?: string;
}

export function resolveAnthropicAuth(): AnthropicAuth {
    const config = Vault.read();
    if (!config?.tier2) return { method: 'none' };

    if (config.tier2.authToken) {
        return { method: 'oauth_token', authToken: config.tier2.authToken };
    }
    if (config.tier2.apiKey) {
        return { method: 'api_key', apiKey: config.tier2.apiKey };
    }
    return { method: 'none' };
}

// ─── Credential Retrieval ─────────────────────────────────────────

/** Get the API key for non-Anthropic providers */
export function getTier2ApiKey(): string | undefined {
    const config = Vault.read();
    return config?.tier2?.apiKey;
}

// ─── Validation ───────────────────────────────────────────────────

export interface Tier2Validation {
    valid: boolean;
    error?: string;
    authMethod?: string;
}

export function validateTier2Config(): Tier2Validation {
    const config = Vault.read();
    if (!config?.tier2) {
        return {
            valid: false,
            error: 'Vault not configured. Run: redbus config',
        };
    }

    switch (config.tier2.provider) {
        case 'anthropic': {
            const auth = resolveAnthropicAuth();
            if (auth.method === 'none') {
                return {
                    valid: false,
                    error: 'Anthropic not configured. Run: redbus config',
                };
            }
            return {
                valid: true,
                authMethod: auth.method === 'oauth_token' ? 'OAuth token' : 'API key',
            };
        }
        case 'google':
            if (!config.tier2.apiKey) {
                return { valid: false, error: 'Google API key not configured. Run: redbus config' };
            }
            return { valid: true, authMethod: 'API key' };
        case 'openai':
            if (!config.tier2.apiKey) {
                return { valid: false, error: 'OpenAI API key not configured. Run: redbus config' };
            }
            return { valid: true, authMethod: 'API key' };
        default:
            return { valid: false, error: `Unknown provider: ${config.tier2.provider as string}` };
    }
}
