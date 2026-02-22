/**
 * @redbusagent/daemon — Cognitive Router
 *
 * The brain's routing layer. Abstracts LLM calls behind two tiers:
 *
 *  • Tier 1 (Local/Fast)  → Ollama via OpenAI-compatible API
 *  • Tier 2 (Cloud/Deep)  → Anthropic / Google / OpenAI
 *
 * Tier 2 includes the Forge tools (create_and_run_tool + dynamic registry tools)
 * for autonomous code generation and execution via Function Calling.
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
import { SYSTEM_PROMPT_TIER1, getSystemPromptTier2 } from './system-prompt.js';
import { createAndRunTool } from './tools/create-and-run.js';
import { memorizeTool } from './tools/memorize.js';
import { searchMemoryTool } from './tools/search-memory.js';
import { scheduleAlertTool } from './tools/schedule-alert.js';
import { ToolRegistry } from './tool-registry.js';

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

// ─── Tool Assembly ────────────────────────────────────────────────

function assembleTools() {
    const dynamicTools = ToolRegistry.getDynamicTools();

    return {
        create_and_run_tool: createAndRunTool,
        memorize: memorizeTool,
        search_memory: searchMemoryTool,
        schedule_alert: scheduleAlertTool,
        ...dynamicTools,
    };
}

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

    try {
        const result = streamText({
            model,
            system: SYSTEM_PROMPT_TIER1,
            messages: [{ role: 'user', content: prompt }],
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

    const config = getTier2Config()!;
    const model = createTier2Model();
    const tools = assembleTools();

    // Enrich system prompt with forge context
    const toolsSummary = ToolRegistry.getToolsSummary();
    const fullSystemPrompt = [
        getSystemPromptTier2(),
        context ? `\n## Contexto Adicional da Sessão\n${context}` : '',
        `\n## Ferramentas Forjadas\n${toolsSummary}`,
    ].join('');

    try {
        console.log(`  🧠 [tier2] Calling ${config.provider}/${config.model} with ${Object.keys(tools).length} tools`);

        const result = streamText({
            model,
            system: fullSystemPrompt,
            messages: [{ role: 'user', content: prompt }],
            tools,
            stopWhen: stepCountIs(5),
            onError: ({ error }) => {
                console.error('  ❌ [tier2] streamText onError:', error);
            },
        });

        let fullText = '';
        let eventCount = 0;

        for await (const part of result.fullStream) {
            eventCount++;
            switch (part.type) {
                case 'text-delta':
                    fullText += part.text;
                    callbacks.onChunk(part.text);
                    break;

                case 'tool-call':
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
