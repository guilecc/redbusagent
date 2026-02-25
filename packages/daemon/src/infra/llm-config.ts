/**
 * @redbusagent/daemon — LLM Configuration
 *
 * Reads LLM provider configuration dynamically from the Vault
 * (~/.redbusagent/config.json). No more .env for credentials.
 *
 * All functions read from vault on each call so that config changes
 * (e.g. via `redbus config`) take effect without daemon restart.
 */

import { Vault, type VaultConfig, type Tier2Provider } from '@redbusagent/shared';

// Re-export the type for convenience
export type { Tier2Provider };

// ─── Tier 1 (Ollama / Local) ──────────────────────────────────────

export function getTier1Config(): { url: string; model: string; enabled: boolean; power_class?: string } {
    const config = Vault.read();
    return {
        url: config?.tier1?.url ?? 'http://127.0.0.1:11434',
        model: config?.tier1?.model ?? 'llama3',
        enabled: config?.tier1?.enabled ?? true,
        power_class: config?.tier1?.power_class,
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
            error: 'Vault não configurado. Rode: redbus config',
        };
    }

    switch (config.tier2.provider) {
        case 'anthropic': {
            const auth = resolveAnthropicAuth();
            if (auth.method === 'none') {
                return {
                    valid: false,
                    error: 'Anthropic não configurado. Rode: redbus config',
                };
            }
            return {
                valid: true,
                authMethod: auth.method === 'oauth_token' ? 'OAuth token' : 'API key',
            };
        }
        case 'google':
            if (!config.tier2.apiKey) {
                return { valid: false, error: 'Google API key não configurada. Rode: redbus config' };
            }
            return { valid: true, authMethod: 'API key' };
        case 'openai':
            if (!config.tier2.apiKey) {
                return { valid: false, error: 'OpenAI API key não configurada. Rode: redbus config' };
            }
            return { valid: true, authMethod: 'API key' };
        default:
            return { valid: false, error: `Provider desconhecido: ${config.tier2.provider as string}` };
    }
}
