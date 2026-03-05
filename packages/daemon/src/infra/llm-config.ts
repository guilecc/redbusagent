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

// ─── Live Engine Config (primary) ─────────────────────────────────

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
    if (config?.live_engine) {
        return {
            url: config.live_engine.url ?? '',
            model: config.live_engine.model ?? 'gemini-2.5-flash',
            enabled: config.live_engine.enabled ?? true,
            power_class: config.live_engine.power_class ?? 'gold',
            provider: config.live_engine.provider ?? 'google',
            apiKey: config.live_engine.apiKey,
        };
    }
    // Legacy fallback: use tier1 if live_engine not configured
    return {
        url: config?.tier1?.url ?? '',
        model: config?.tier1?.model ?? 'gemini-2.5-flash',
        enabled: config?.tier1?.enabled ?? true,
        power_class: config?.tier1?.power_class ?? 'gold',
        provider: config?.tier1 ? 'ollama' : 'google',
    };
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

    // Fallbacks for legacy `tier2` configuration
    const legacyTier2 = config?.tier2;
    const provider = config?.worker_engine?.provider ?? legacyTier2?.provider as EngineProvider ?? 'anthropic';
    const apiKey = config?.worker_engine?.apiKey ?? legacyTier2?.apiKey;
    const model = config?.worker_engine?.model ?? legacyTier2?.model ?? 'claude-sonnet-4-20250514';

    return {
        url: config?.worker_engine?.url ?? '',
        model: model,
        enabled: config?.worker_engine?.enabled ?? config?.tier2_enabled ?? true,
        num_threads: config?.worker_engine?.num_threads ?? 8,
        num_ctx: config?.worker_engine?.num_ctx ?? 8192,
        provider: provider,
        apiKey: apiKey,
    };
}

// ─── Tier 2 (Cloud / Premium) ─────────────────────────────────────

export function getTier2Config(): { provider: string; model: string } | null {
    const workerConfig = getWorkerEngineConfig();
    if (!workerConfig.model || !workerConfig.provider) return null;
    return {
        provider: workerConfig.provider,
        model: workerConfig.model,
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

    // Support dual configuration paths
    const authToken = config?.worker_engine?.authToken ?? config?.tier2?.authToken;
    const apiKey = config?.worker_engine?.apiKey ?? config?.tier2?.apiKey;

    if (authToken) {
        return { method: 'oauth_token', authToken: authToken };
    }
    if (apiKey) {
        return { method: 'api_key', apiKey: apiKey };
    }
    return { method: 'none' };
}

// ─── Credential Retrieval ─────────────────────────────────────────

/** Get the API key for the worker engine (supports legacy tier2 fallback) */
export function getTier2ApiKey(): string | undefined {
    return getWorkerEngineConfig().apiKey;
}

// ─── Validation ───────────────────────────────────────────────────

export interface Tier2Validation {
    valid: boolean;
    error?: string;
    authMethod?: string;
}

export function validateTier2Config(): Tier2Validation {
    const workerConfig = getWorkerEngineConfig();

    if (!workerConfig.enabled) {
        return { valid: false, error: 'Worker Engine is disabled. Run: redbus config' };
    }

    switch (workerConfig.provider) {
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
            if (!workerConfig.apiKey) {
                return { valid: false, error: 'Google API key not configured. Run: redbus config' };
            }
            return { valid: true, authMethod: 'API key' };
        case 'openai':
            if (!workerConfig.apiKey) {
                return { valid: false, error: 'OpenAI API key not configured. Run: redbus config' };
            }
            return { valid: true, authMethod: 'API key' };
        case 'ollama':
            return { valid: true, authMethod: 'Local API' };
        default:
            return { valid: false, error: `Unknown provider: ${workerConfig.provider as string}` };
    }
}
