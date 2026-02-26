/**
 * @redbusagent/cli — Model Fetcher
 *
 * Fetches available models dynamically from each LLM provider's API.
 * This ensures the wizard always shows up-to-date models instead
 * of a hardcoded list that goes stale.
 *
 * Supported providers:
 *  - Anthropic:  GET /v1/models
 *  - OpenAI:     GET /v1/models
 *  - Google:     GET /v1beta/models
 *  - Ollama:     GET /api/tags (local, no auth)
 */
import type { Tier2Provider } from '../vault/vault.js';
// ─── Types ────────────────────────────────────────────────────────

export interface ModelInfo {
    id: string;
    label: string;
    hint?: string;
}

export interface FetchResult {
    success: boolean;
    models: ModelInfo[];
    error?: string;
}

// ─── Fallbacks (used when API is unreachable) ─────────────────────

const FALLBACK_MODELS: Record<Tier2Provider, ModelInfo[]> = {
    anthropic: [
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: 'recomendado' },
        { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', hint: 'rápido' },
    ],
    google: [
        { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', hint: 'recomendado' },
        { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    ],
    openai: [
        { id: 'gpt-5.2', label: 'GPT-5.2', hint: 'recomendado' },
        { id: 'gpt-5.1', label: 'GPT-5.1', hint: 'econômico' },
    ],
};

const FALLBACK_OLLAMA: ModelInfo[] = [
    { id: 'llama3', label: 'llama3', hint: 'padrão' },
    { id: 'qwen2.5', label: 'qwen2.5' },
    { id: 'mistral', label: 'mistral' },
    { id: 'codellama', label: 'codellama' },
];

// ─── Anthropic ────────────────────────────────────────────────────

interface AnthropicModel {
    id: string;
    display_name: string;
    type: string;
}

async function fetchAnthropicModels(auth: { apiKey?: string; authToken?: string }): Promise<FetchResult> {
    try {
        const headers: Record<string, string> = {
            'anthropic-version': '2023-06-01',
        };

        if (auth.authToken) {
            headers['Authorization'] = `Bearer ${auth.authToken}`;
        } else if (auth.apiKey) {
            headers['x-api-key'] = auth.apiKey;
        }

        const res = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers });

        if (!res.ok) {
            return { success: false, models: [], error: `HTTP ${res.status}: ${res.statusText}` };
        }

        const data = await res.json() as { data: AnthropicModel[] };
        const models: ModelInfo[] = data.data
            .filter(m => m.type === 'model')
            .map(m => ({
                id: m.id,
                label: m.display_name || m.id,
            }))
            .sort((a, b) => a.label.localeCompare(b.label));

        return { success: true, models };
    } catch (err) {
        return { success: false, models: [], error: (err as Error).message };
    }
}

// ─── OpenAI ───────────────────────────────────────────────────────

interface OpenAIModel {
    id: string;
    owned_by: string;
}

async function fetchOpenAIModels(apiKey: string): Promise<FetchResult> {
    try {
        const res = await fetch('https://api.openai.com/v1/models', {
            headers: { 'Authorization': `Bearer ${apiKey}` },
        });

        if (!res.ok) {
            return { success: false, models: [], error: `HTTP ${res.status}: ${res.statusText}` };
        }

        const data = await res.json() as { data: OpenAIModel[] };

        // Filter to only chat-capable models (gpt-*, o1-*, o3-*, chatgpt-*)
        const chatModelPrefixes = ['gpt-5', 'gpt-4', 'o1', 'o3', 'o4', 'chatgpt'];
        const models: ModelInfo[] = data.data
            .filter(m => chatModelPrefixes.some(prefix => m.id.startsWith(prefix)))
            .filter(m => !m.id.includes('instruct') && !m.id.includes('realtime') && !m.id.includes('audio'))
            .map(m => ({ id: m.id, label: m.id }))
            .sort((a, b) => a.id.localeCompare(b.id));

        return { success: true, models };
    } catch (err) {
        return { success: false, models: [], error: (err as Error).message };
    }
}

// ─── Google ───────────────────────────────────────────────────────

interface GoogleModel {
    name: string;
    displayName: string;
    supportedGenerationMethods: string[];
}

async function fetchGoogleModels(apiKey: string): Promise<FetchResult> {
    try {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
        );

        if (!res.ok) {
            return { success: false, models: [], error: `HTTP ${res.status}: ${res.statusText}` };
        }

        const data = await res.json() as { models: GoogleModel[] };
        const models: ModelInfo[] = data.models
            .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
            .map(m => ({
                // Google returns "models/gemini-1.5-pro" — strip prefix
                id: m.name.replace('models/', ''),
                label: m.displayName || m.name.replace('models/', ''),
            }))
            .sort((a, b) => a.label.localeCompare(b.label));

        return { success: true, models };
    } catch (err) {
        return { success: false, models: [], error: (err as Error).message };
    }
}

// ─── Ollama (Local) ───────────────────────────────────────────────

interface OllamaTag {
    name: string;
    size: number;
    modified_at: string;
}

export async function fetchOllamaModels(baseUrl: string): Promise<FetchResult> {
    try {
        const res = await fetch(`${baseUrl}/api/tags`, {
            signal: AbortSignal.timeout(3000), // 3s timeout for local
        });

        if (!res.ok) {
            return { success: false, models: [], error: `HTTP ${res.status}` };
        }

        const data = await res.json() as { models: OllamaTag[] };
        const models: ModelInfo[] = (data.models || []).map(m => {
            const sizeMB = Math.round(m.size / 1024 / 1024);
            return {
                id: m.name,
                label: m.name,
                hint: `${sizeMB}MB`,
            };
        });

        return { success: true, models };
    } catch (err) {
        return { success: false, models: [], error: (err as Error).message };
    }
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Fetch available models for a Tier 2 provider.
 * Returns fetched models on success, or fallback models on failure.
 */
export async function fetchTier2Models(
    provider: Tier2Provider,
    auth: { apiKey?: string; authToken?: string },
): Promise<FetchResult & { usingFallback: boolean }> {
    let result: FetchResult;

    switch (provider) {
        case 'anthropic':
            result = await fetchAnthropicModels(auth);
            break;
        case 'openai':
            result = await fetchOpenAIModels(auth.apiKey!);
            break;
        case 'google':
            result = await fetchGoogleModels(auth.apiKey!);
            break;
        default:
            result = { success: false, models: [], error: 'Unknown provider' };
    }

    if (result.success && result.models.length > 0) {
        return { ...result, usingFallback: false };
    }

    // Fallback to hardcoded models
    return {
        success: true,
        models: FALLBACK_MODELS[provider] ?? [],
        error: result.error,
        usingFallback: true,
    };
}
