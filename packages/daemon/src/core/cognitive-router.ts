/**
 * @redbusagent/daemon — Cognitive Router
 *
 * The brain's routing layer. Abstracts LLM calls behind two tiers:
 *
 *  • Tier 1 (Local/Fast)  → Ollama via OpenAI-compatible API
 *  • Tier 2 (Cloud/Deep)  → Anthropic / Google / OpenAI
 *
 * MemGPT Architecture Integration:
 *  • Auto-RAG: Every user message is silently enriched with top 3
 *    relevant chunks from Archival Memory before reaching the LLM.
 *  • Core Working Memory: Injected via system prompt (system-prompt.ts).
 *  • Tools include core_memory_replace and core_memory_append.
 */

import { streamText, stepCountIs, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

import {
    getTier1Config,
    getTier2Config,
    getTier2ApiKey,
    validateTier2Config,
    resolveAnthropicAuth,
} from '../infra/llm-config.js';
import { getSystemPromptTier1, getSystemPromptTier2 } from './system-prompt.js';
import { PersonaManager } from '@redbusagent/shared';
import { MemoryManager } from './memory-manager.js';
import { ToolRegistry } from './tool-registry.js';
import { CapabilityRegistry } from './registry.js';
import { AutoRAG } from './auto-rag.js';

// ─── Persona Helpers ──────────────────────────────────────────────

function getPersonaContext(): string {
    const persona = PersonaManager.read();
    if (!persona) return '';
    return `Você é ${persona.agent_name}. O contexto do seu usuário é: ${persona.user_context}. Suas diretrizes comportamentais são: ${persona.behavioral_guidelines}.\n\n`;
}

// ─── Provider Factory ─────────────────────────────────────────────

import { OllamaManager } from './ollama-manager.js';

function createTier1Model(): LanguageModel {
    const { model } = getTier1Config();
    const ollama = createOpenAI({
        baseURL: `${OllamaManager.baseUrl}/v1`,
        apiKey: 'ollama',
    });
    // Padrão que definimos para puxar é llama3.2:1b se local não for estritamente configurado
    const targetModel = model === 'llama3' ? 'llama3.2:1b' : model;
    return ollama(targetModel);
}

function createTier2Model(): LanguageModel {
    const config = getTier2Config();
    if (!config) throw new Error('Tier 2 não configurado. Rode: redbus config');

    switch (config.provider) {
        case 'anthropic': {
            const auth = resolveAnthropicAuth();
            const anthropic = createAnthropic(
                auth.method === 'oauth_token'
                    ? { apiKey: '', authToken: auth.authToken }
                    : { apiKey: auth.apiKey },
            );
            return anthropic(config.model);
        }
        case 'google': {
            const apiKey = getTier2ApiKey();
            const google = createGoogleGenerativeAI({ apiKey: apiKey! });
            return google(config.model);
        }
        case 'openai': {
            const apiKey = getTier2ApiKey();
            const openai = createOpenAI({ apiKey: apiKey! });
            return openai(config.model);
        }
        default:
            throw new Error(`Unknown provider: ${config.provider as string}`);
    }
}

// ─── Stream Callbacks ─────────────────────────────────────────────

// ─── Streaming Interfaces ─────────────────────────────────────────

export interface StreamCallbacks {
    onChunk: (delta: string) => void;
    onDone: (fullText: string) => void;
    onError: (error: Error) => void;
    onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
    onToolResult?: (toolName: string, success: boolean, result: string) => void;
}

export interface CognitiveRouterResult {
    tier: 'tier1' | 'tier2';
    model: string;
}

// ─── Public API ───────────────────────────────────────────────────

export async function askTier1(
    prompt: string,
    callbacks: StreamCallbacks,
): Promise<CognitiveRouterResult> {
    const { model: modelName } = getTier1Config();
    const model = createTier1Model();

    // ──── Auto-RAG Pre-flight Injection ────
    const ragResult = await AutoRAG.enrich(prompt);
    const enrichedPrompt = ragResult.enrichedPrompt;

    let systemPromptContext = getPersonaContext() + getSystemPromptTier1();
    systemPromptContext += `\n\n${CapabilityRegistry.getCapabilityManifest()}`;
    try {
        const wisdom = await MemoryManager.searchMemory('cloud_wisdom', prompt, 3);
        if (wisdom && wisdom.length > 0) {
            systemPromptContext += `\n\nPAST SUCCESSFUL EXAMPLES (Mimic this level of reasoning):\n`;
            wisdom.forEach((w) => {
                systemPromptContext += `${w}\n\n`;
            });
        }
    } catch (err) {
        console.error('  ❌ [tier1] Failed to retrieve cloud wisdom:', err);
    }

    try {
        const result = streamText({
            model,
            system: systemPromptContext,
            messages: [{ role: 'user', content: enrichedPrompt }],
        });

        let fullText = '';
        for await (const chunk of result.textStream) {
            fullText += chunk;
            callbacks.onChunk(chunk);
        }

        callbacks.onDone(fullText);
        return { tier: 'tier1', model: modelName };
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        callbacks.onError(error);
        return { tier: 'tier1', model: modelName };
    }
}

export async function askTier2(
    prompt: string,
    callbacks: StreamCallbacks,
    context?: string,
): Promise<CognitiveRouterResult> {
    const validation = validateTier2Config();
    if (!validation.valid) {
        callbacks.onError(new Error(validation.error ?? 'Tier 2 config invalid'));
        const config = getTier2Config();
        return { tier: 'tier2', model: config?.model ?? 'unknown' };
    }

    // ──── Auto-RAG Pre-flight Injection ────
    const ragResult = await AutoRAG.enrich(prompt);
    const enrichedPrompt = ragResult.enrichedPrompt;

    const config = getTier2Config()!;
    const model = createTier2Model();
    const tools = CapabilityRegistry.getAvailableTools();

    // Enrich system prompt with capability manifest and external context
    const fullSystemPrompt = [
        getPersonaContext(),
        getSystemPromptTier2(),
        `\n\n${CapabilityRegistry.getCapabilityManifest()}`,
        context ? `\n## Contexto Adicional da Sessão\n${context}` : '',
    ].join('');

    try {
        console.log(`  🧠 [tier2] Calling ${config.provider}/${config.model} with ${Object.keys(tools).length} tools (AutoRAG: ${ragResult.chunksFound} chunks)`);

        const result = streamText({
            model,
            system: fullSystemPrompt,
            messages: [{ role: 'user', content: enrichedPrompt }],
            tools,
            stopWhen: stepCountIs(5),
            onError: ({ error }) => {
                console.error('  ❌ [tier2] streamText onError:', error);
            },
        });

        let fullText = '';
        let eventCount = 0;
        let toolCalled = false;

        for await (const part of result.fullStream) {
            eventCount++;
            switch (part.type) {
                case 'text-delta':
                    fullText += part.text;
                    callbacks.onChunk(part.text);
                    break;

                case 'tool-call':
                    toolCalled = true;
                    console.log(`  🔧 [tier2] Tool call: ${part.toolName}`);
                    callbacks.onToolCall?.(
                        part.toolName,
                        part.input as Record<string, unknown>,
                    );
                    break;

                case 'tool-result':
                    console.log(`  🔧 [tier2] Tool result: ${part.toolName}`);
                    callbacks.onToolResult?.(
                        part.toolName,
                        typeof part.output === 'object' && part.output !== null && 'success' in part.output
                            ? (part.output as { success: boolean }).success
                            : true,
                        typeof part.output === 'string'
                            ? part.output
                            : JSON.stringify(part.output, null, 2),
                    );
                    break;

                case 'error':
                    console.error('  ❌ [tier2] Stream error event:', part.error);
                    callbacks.onError(
                        part.error instanceof Error ? part.error : new Error(String(part.error)),
                    );
                    break;

                default:
                    break;
            }
        }

        console.log(`  🧠 [tier2] Stream finished: ${eventCount} events, ${fullText.length} chars of text`);

        if (fullText.length > 800 || toolCalled) {
            const wisdomText = `When asked to: "${prompt}", the optimal approach is:\n${fullText}`;
            MemoryManager.memorize('cloud_wisdom', wisdomText).catch(err => {
                console.error('  ❌ [tier2] Failed to memorize cloud wisdom:', err);
            });
        }

        callbacks.onDone(fullText);
        return { tier: 'tier2', model: config.model };
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('  ❌ [tier2] Exception:', error.message);
        callbacks.onError(error);
        return { tier: 'tier2', model: config.model };
    }
}

export function getRouterStatus(): {
    tier1: { url: string; model: string; enabled: boolean };
    tier2: { provider: string; model: string; configured: boolean; authMethod?: string } | null;
    forgedTools: number;
} {
    const tier1 = getTier1Config();
    const tier2Config = getTier2Config();
    const validation = validateTier2Config();
    const registryCount = ToolRegistry.getAll().length;

    return {
        tier1,
        tier2: tier2Config
            ? {
                provider: tier2Config.provider,
                model: tier2Config.model,
                configured: validation.valid,
                authMethod: validation.authMethod,
            }
            : null,
        forgedTools: registryCount,
    };
}
