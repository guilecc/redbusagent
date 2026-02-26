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

import { streamText, generateText, stepCountIs, type LanguageModel } from 'ai';
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
import { calculateComplexityScore } from './heuristic-router.js';
import { PersonaManager, Vault } from '@redbusagent/shared';
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

export function createTier2Model(): LanguageModel {
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
    messagesFromClient?: any[],
): Promise<CognitiveRouterResult> {
    const { model: modelName } = getTier1Config();
    const model = createTier1Model();

    // ──── Auto-RAG Pre-flight Injection ────
    const ragResult = await AutoRAG.enrich(prompt);
    const enrichedPrompt = ragResult.enrichedPrompt;

    const PROACTIVE_DIRECTIVE = `
AUTONOMOUS TOOL FORGING: You are a proactive software engineer. DO NOT wait for the user to explicitly tell you to "create a script" or "build a tool".

DETECT PATTERNS: If the user asks you to perform a calculation, parse data, read a file system, monitor a system, or do any task that requires absolute precision or repetition, you MUST autonomously decide to use the create_and_run_tool to forge a reusable Node.js solution. Exception: If the user asks to "schedule a task", "set a timer", "remind me", or "run every X minutes", DO NOT forge a tool! You MUST use the native \`schedule_task\` tool. DO NOT use memory tools (\`core_memory_replace\`) as a substitute for scheduling timers or alarms.

SILENT EXECUTION: Do not ask the user "Would you like me to write a script for this?". Just do it. Write the tool, execute it silently using your internal execution loop, analyze the stdout, and ONLY reply to the user with the final, polished result in natural language.

THE LAZINESS BAN: Never attempt to do complex math, data filtering, or system analysis textually in your "head". Always forge a tool to do the heavy lifting.
`;

    const tier1Config = getTier1Config();
    const isGold = tier1Config.power_class === 'gold' || tier1Config.power_class === 'platinum';
    const tools = CapabilityRegistry.getAvailableTools();

    // Prevent weak Tier 1 from forging things or messing with structural shell commands
    if (!isGold) {
        delete (tools as any)['create_and_run_tool'];
        delete (tools as any)['execute_shell_command'];
    }

    // 🛡️ GUARDRAIL: Strip outbound communication tools from small (bronze) models
    // on low-complexity conversational requests to prevent hallucinated tool calls.
    // Small models lack the judgement to correctly gate intrusive tools like WhatsApp.
    // The tool stays available only when the conversation is clearly complex/intentional
    // (score >= 50), which typically means the user used an explicit scheduling/notification keyword.
    const isBronze = tier1Config.power_class === 'bronze';
    if (isBronze) {
        const complexityScore = calculateComplexityScore(prompt, messagesFromClient ?? []);
        if (complexityScore < 50) {
            delete (tools as any)['send_whatsapp_message'];
            console.log(`  🛡️ [tier1] Guardrail: send_whatsapp_message stripped for bronze model (complexity score: ${complexityScore})`);
        }
    }

    let systemPromptContext = getPersonaContext() + getSystemPromptTier1();
    if (isGold) {
        systemPromptContext += `\n\n${PROACTIVE_DIRECTIVE}\n\n${CapabilityRegistry.getCapabilityManifest()}`;
    } else {
        systemPromptContext += `\n\n${CapabilityRegistry.getCapabilityManifest()}`;
    }

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


    let messages: any[];
    if (messagesFromClient && messagesFromClient.length > 0) {
        messages = [...messagesFromClient];
        let lastIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
                lastIndex = i;
                break;
            }
        }
        if (lastIndex !== -1) {
            messages[lastIndex] = { ...messages[lastIndex], content: enrichedPrompt };
        } else {
            messages.push({ role: 'user', content: enrichedPrompt });
        }
    } else {
        messages = [{ role: 'user', content: enrichedPrompt }];
    }

    let stepCount = 0;
    const MAX_STEPS = 5;

    while (stepCount < MAX_STEPS) {
        stepCount++;

        try {
            const result = streamText({
                model,
                system: systemPromptContext,
                messages,
                tools,
                onError: ({ error }) => {
                    console.error('  ❌ [tier1] streamText onError:', error);
                },
            });

            let fullText = '';
            let rawToolCall: any = null;
            let isJsonMode = false;
            let isDetermining = true;
            let hasSentThinking = false;
            let nativeToolUsed = false;

            for await (const part of result.fullStream) {
                if (part.type === 'text-delta') {
                    fullText += part.text;

                    if (isDetermining && fullText.trim().length > 0) {
                        const trimmed = fullText.trim();
                        if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('```')) {
                            isJsonMode = true;
                            isDetermining = false;
                            if (!hasSentThinking) {
                                callbacks.onChunk('⏳ Interceptando Tool Call (JSON)...\n');
                                hasSentThinking = true;
                            }
                        } else if (trimmed.length > 15) {
                            isDetermining = false;
                            callbacks.onChunk(fullText); // Output standard buffer
                        }
                    } else if (!isDetermining && !isJsonMode) {
                        callbacks.onChunk(part.text);
                    }
                } else if (part.type === 'tool-call') {
                    nativeToolUsed = true;
                    console.log(`  🔧 [tier1] Native Tool call: ${part.toolName}`);
                    callbacks.onToolCall?.(part.toolName, part.input as Record<string, unknown>);
                } else if (part.type === 'tool-result') {
                    console.log(`  🔧 [tier1] Native Tool result: ${part.toolName}`);
                    callbacks.onToolResult?.(
                        part.toolName,
                        typeof part.output === 'object' && part.output !== null && 'success' in part.output
                            ? (part.output as { success: boolean }).success
                            : true,
                        typeof part.output === 'string'
                            ? part.output
                            : JSON.stringify(part.output, null, 2),
                    );
                } else if (part.type === 'error') {
                    console.error('  ❌ [tier1] Stream error event:', part.error);
                    callbacks.onError(part.error instanceof Error ? part.error : new Error(String(part.error)));
                }
            }

            // 1. Raw JSON Interceptor (Fallback Parser)
            if (!nativeToolUsed) {
                try {
                    let jsonStr = fullText.trim();
                    const match = jsonStr.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
                    if (match && match[1]) {
                        jsonStr = match[1].trim();
                    } else {
                        const startObj = jsonStr.indexOf('{');
                        const endObj = jsonStr.lastIndexOf('}');
                        if (startObj !== -1 && endObj !== -1 && endObj > startObj) {
                            jsonStr = jsonStr.substring(startObj, endObj + 1);
                        }
                    }

                    const parsed = JSON.parse(jsonStr);
                    if (parsed && typeof parsed.name === 'string' && (typeof parsed.arguments === 'object' || typeof parsed.parameters === 'object')) {
                        rawToolCall = parsed;
                        if (!rawToolCall.arguments && rawToolCall.parameters) {
                            rawToolCall.arguments = rawToolCall.parameters;
                        }
                    } else if (parsed && parsed.tool === 'call' && parsed.name) {
                        rawToolCall = parsed;
                    }
                } catch (e) {
                    console.warn('  ⚠️ [tier1] Falha ao fazer parse do JSON bruto (Interceptor):', e);
                }
            }

            // 2. The Invisible Execution Loop
            if (rawToolCall) {
                console.log(`  🔧 [tier1] Raw JSON Tool Call Interceptado: ${rawToolCall.name}`);
                callbacks.onToolCall?.(rawToolCall.name, rawToolCall.arguments || {});

                const toolFn = (tools as any)[rawToolCall.name];
                let toolOutput = '';
                let success = false;

                if (toolFn) {
                    try {
                        const res = await toolFn.execute(rawToolCall.arguments || {}, { toolCallId: 'raw-1', messages: [] });
                        toolOutput = typeof res === 'string' ? res : JSON.stringify(res);
                        success = true;
                    } catch (e: any) {
                        toolOutput = e.message || String(e);
                    }
                } else {
                    toolOutput = `Error: Tool '${rawToolCall.name}' not found.`;
                }

                callbacks.onToolResult?.(rawToolCall.name, success, toolOutput);

                messages.push({ role: 'assistant', content: fullText });
                messages.push({ role: 'user', content: `[System Tool Execution Result]:\n${toolOutput}\n\nWhen you receive a tool execution output, formulate a natural language response to the user based on that output. DO NOT output JSON anymore unless another tool is needed.` });

                continue; // Immediately loop again!
            }

            if (isJsonMode && !rawToolCall && !nativeToolUsed && fullText.trim().length > 0) {
                callbacks.onChunk(fullText.trim());
            }

            callbacks.onDone(isJsonMode && !rawToolCall && !nativeToolUsed ? fullText.trim() : fullText);
            return { tier: 'tier1', model: modelName };

        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            callbacks.onError(error);
            return { tier: 'tier1', model: modelName };
        }
    }

    callbacks.onDone("Tier 1 maximum tool execution steps limit reached.");
    return { tier: 'tier1', model: modelName };
}

export async function askTier2(
    prompt: string,
    callbacks: StreamCallbacks,
    context?: string,
    messagesFromClient?: any[],
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

    const PROACTIVE_DIRECTIVE = `
AUTONOMOUS TOOL FORGING: You are a proactive software engineer. DO NOT wait for the user to explicitly tell you to "create a script" or "build a tool".

DETECT PATTERNS: If the user asks you to perform a calculation, parse data, read a file system, monitor a system, or do any task that requires absolute precision or repetition, you MUST autonomously decide to use the create_and_run_tool to forge a reusable Node.js solution. Exception: If the user asks to "schedule a task", "set a timer", "remind me", or "run every X minutes", DO NOT forge a tool! You MUST use the native \`schedule_task\` tool. DO NOT use memory tools (\`core_memory_replace\`) as a substitute for scheduling timers or alarms.

SILENT EXECUTION: Do not ask the user "Would you like me to write a script for this?". Just do it. Write the tool, execute it silently using your internal execution loop, analyze the stdout, and ONLY reply to the user with the final, polished result in natural language.

THE LAZINESS BAN: Never attempt to do complex math, data filtering, or system analysis textually in your "head". Always forge a tool to do the heavy lifting.
`;

    // Enrich system prompt with capability manifest and external context
    const fullSystemPrompt = [
        getPersonaContext(),
        getSystemPromptTier2(),
        `\n\n${PROACTIVE_DIRECTIVE}`,
        `\n\n${CapabilityRegistry.getCapabilityManifest()}`,
        context ? `\n## Contexto Adicional da Sessão\n${context}` : '',
    ].join('');

    try {
        console.log(`  🧠 [tier2] Calling ${config.provider}/${config.model} with ${Object.keys(tools).length} tools (AutoRAG: ${ragResult.chunksFound} chunks)`);

        let messages: any[];
        if (messagesFromClient && messagesFromClient.length > 0) {
            messages = [...messagesFromClient];
            let lastIndex = -1;
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === 'user') {
                    lastIndex = i;
                    break;
                }
            }
            if (lastIndex !== -1) {
                messages[lastIndex] = { ...messages[lastIndex], content: enrichedPrompt };
            } else {
                messages.push({ role: 'user', content: enrichedPrompt });
            }
        } else {
            messages = [{ role: 'user', content: enrichedPrompt }];
        }

        const result = streamText({
            model,
            system: fullSystemPrompt,
            messages,
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
