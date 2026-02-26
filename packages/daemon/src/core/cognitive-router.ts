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
    getLiveEngineConfig,
    getWorkerEngineConfig,
} from '../infra/llm-config.js';
import { getSystemPromptTier1, getSystemPromptTier1Gold, getSystemPromptTier2 } from './system-prompt.js';
import { calculateComplexityScore } from './heuristic-router.js';
import { PersonaManager } from '@redbusagent/shared';
import { MemoryManager } from './memory-manager.js';
import { ToolRegistry } from './tool-registry.js';
import { CapabilityRegistry } from './registry.js';
import { AutoRAG } from './auto-rag.js';
import { Transcript } from './transcript.js';

// ─── Enterprise Patterns ─────────────────────────────────────────
import { detectToolCallLoop, hashToolCall, hashResult, type ToolCallHistoryEntry } from './tool-loop-detection.js';
import { evaluateContextWindowGuard, estimateTokens } from './context-window-guard.js';
import { repairToolUseResultPairing } from './transcript-repair.js';
import { compactHistory } from './compaction.js';
import { applyToolPolicy, type SenderRole } from './tool-policy.js';
import { getRelevantSkillPrompt } from './skills.js';

// ─── Constants ────────────────────────────────────────────────────

const PROACTIVE_DIRECTIVE = `
AUTONOMOUS TOOL FORGING: You are a proactive software engineer. DO NOT wait for the user to explicitly tell you to "create a script" or "build a tool".

DETECT PATTERNS: If the user asks you to perform a calculation, parse data, read a file system, monitor a system, or do any task that requires absolute precision or repetition, you MUST autonomously decide to use the create_and_run_tool to forge a reusable Node.js solution. Exception: If the user asks to "schedule a task", "set a timer", "remind me", or "run every X minutes", DO NOT forge a tool! You MUST use the native \`schedule_recurring_task\` tool. DO NOT use memory tools (\`core_memory_replace\`) as a substitute for scheduling timers or alarms.

SILENT EXECUTION: Do not ask the user "Would you like me to write a script for this?". Just do it. Write the tool, execute it silently using your internal execution loop, analyze the stdout, and ONLY reply to the user with the final, polished result in natural language.

THE LAZINESS BAN: Never attempt to do complex math, data filtering, or system analysis textually in your "head". Always forge a tool to do the heavy lifting.
`;

// ─── Persona Helpers ──────────────────────────────────────────────

function getPersonaContext(): string {
    const persona = PersonaManager.read();
    if (!persona) return '';
    return `You are ${persona.agent_name}. Your user's context is: ${persona.user_context}. Your behavioral guidelines are: ${persona.behavioral_guidelines}.\n\n`;
}

// ─── Provider Factory ─────────────────────────────────────────────

import { OllamaManager } from './ollama-manager.js';

function createTier1Model(): LanguageModel {
    const { model, power_class } = getTier1Config();

    // ── Ollama Inference Optimizer ──
    // Inject hardware-aware options into every Ollama API request via custom fetch.
    // These options are Ollama-native and NOT part of the OpenAI-compatible spec,
    // so we intercept the request body and inject them transparently.
    const bronzeOptions: Record<string, unknown> = power_class === 'bronze'
        ? {
            num_thread: 8,    // Pin to physical cores — avoids context-switching overhead
            num_ctx: 4096,    // Cap context window — saves GBs of VRAM
            num_gpu: 99,      // Force all layers into VRAM — fail fast rather than silent CPU fallback
        }
        : {};

    const ollama = createOpenAI({
        baseURL: `${OllamaManager.baseUrl}/v1`,
        apiKey: 'ollama',
        fetch: async (url, init) => {
            if (init?.body && typeof init.body === 'string') {
                try {
                    const body = JSON.parse(init.body);
                    body.keep_alive = '60m'; // Prevent model unloading between messages
                    if (Object.keys(bronzeOptions).length > 0) {
                        body.options = { ...body.options, ...bronzeOptions };
                    }
                    init = { ...init, body: JSON.stringify(body) };
                } catch { /* non-JSON body, pass through */ }
            }
            return globalThis.fetch(url, init);
        },
    });

    const targetModel = model === 'llama3' ? 'llama3.2:1b' : model;
    return ollama(targetModel);
}

export function createTier2Model(): LanguageModel {
    const config = getTier2Config();
    if (!config) throw new Error('Tier 2 not configured. Run: redbus config');

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


// ─── Worker Engine Model Factory (CPU/RAM-bound) ─────────────────

export function createWorkerModel(): LanguageModel {
    const workerConfig = getWorkerEngineConfig();

    const workerOllama = createOpenAI({
        baseURL: `${workerConfig.url}/v1`,
        apiKey: 'ollama',
        fetch: async (url, init) => {
            if (init?.body && typeof init.body === 'string') {
                try {
                    const body = JSON.parse(init.body);
                    body.keep_alive = '60m';
                    body.options = {
                        ...body.options,
                        num_thread: workerConfig.num_threads,
                        num_ctx: workerConfig.num_ctx,
                        num_gpu: 0,   // Force CPU-only — keep GPU free for Live Engine
                    };
                    init = { ...init, body: JSON.stringify(body) };
                } catch { /* non-JSON body, pass through */ }
            }
            return globalThis.fetch(url, init);
        },
    });

    return workerOllama(workerConfig.model);
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
    tier: 'tier1' | 'tier2' | 'worker';
    model: string;
}

// ─── Public API ───────────────────────────────────────────────────

export async function askTier1(
    prompt: string,
    callbacks: StreamCallbacks,
    messagesFromClient?: any[],
    senderRole: SenderRole = 'owner',
): Promise<CognitiveRouterResult> {
    const { model: modelName } = getTier1Config();
    const model = createTier1Model();

    // ──── Auto-RAG Pre-flight Injection ────
    const ragResult = await AutoRAG.enrich(prompt);
    const enrichedPrompt = ragResult.enrichedPrompt;

    const tier1Config = getTier1Config();
    const isGold = tier1Config.power_class === 'gold' || tier1Config.power_class === 'platinum';
    const tools = CapabilityRegistry.getAvailableTools();

    // Prevent weak Tier 1 from forging things or messing with structural shell commands
    if (!isGold) {
        delete (tools as any)['create_and_run_tool'];
        delete (tools as any)['execute_shell_command'];
    }

    // 🛡️ GUARDRAIL: Strip dangerous/complex tools from bronze models.
    // Bronze models (≤4096 tokens) hallucinate structured tool calls and can't
    // reason about multi-step workflows (MCP install, visual inspection, etc.).
    const isBronze = tier1Config.power_class === 'bronze';
    const isSilver = tier1Config.power_class === 'silver';
    if (isBronze) {
        const complexityScore = calculateComplexityScore(prompt, messagesFromClient ?? []);
        if (complexityScore < 50) {
            delete (tools as any)['send_whatsapp_message'];
            console.log(`  🛡️ [tier1] Guardrail: send_whatsapp_message stripped for bronze model (complexity score: ${complexityScore})`);
        }
        // Strip tools that require multi-step reasoning or carry heavy side effects
        delete (tools as any)['install_mcp'];
        delete (tools as any)['visual_inspect_page'];
        delete (tools as any)['web_interact'];
        delete (tools as any)['start_background_process'];
        delete (tools as any)['schedule_recurring_task'];
        console.log(`  🛡️ [tier1] Guardrail: install_mcp, visual_inspect_page, web_interact, start_background_process, schedule_recurring_task stripped for bronze model`);
    }

    // Silver models can handle most tools but MCP installation is still too complex
    if (isSilver) {
        delete (tools as any)['install_mcp'];
        console.log(`  🛡️ [tier1] Guardrail: install_mcp stripped for silver model`);
    }

    // 🛡️ Tool Policy: Strip owner-only tools for non-owner senders (system/scheduled)
    const filteredTools = senderRole === 'owner' ? tools : applyToolPolicy(tools as Record<string, unknown>, senderRole) as typeof tools;

    // ─── System Prompt Construction (tier-aware context budget) ────
    let systemPromptContext = getPersonaContext() + (isGold ? getSystemPromptTier1Gold() : getSystemPromptTier1());
    if (isGold) {
        // Gold/Platinum: full context — directive + manifest + wisdom
        systemPromptContext += `\n\n${PROACTIVE_DIRECTIVE}\n\n${CapabilityRegistry.getCapabilityManifest()}`;
    } else if (!isBronze) {
        // Silver: manifest only (no directive, no wisdom)
        systemPromptContext += `\n\n${CapabilityRegistry.getCapabilityManifest()}`;
    }
    // Bronze: NO manifest, NO wisdom — protect the 4096-token window

    // Cloud Wisdom injection — skip for bronze to avoid context overflow
    if (!isBronze) {
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
    }

    // 📚 Skills injection — load relevant skill instructions (skip bronze)
    if (!isBronze) {
        try {
            const skillPrompt = await getRelevantSkillPrompt(prompt);
            if (skillPrompt) {
                systemPromptContext += skillPrompt;
                console.log(`  📚 [tier1] Skill prompt injected`);
            }
        } catch (err) {
            console.error('  ❌ [tier1] Failed to load skills:', err);
        }
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

    // ─── Transcript: Log user turn ───
    Transcript.append({ role: 'user', content: prompt, meta: { tier: 'tier1', model: modelName } });

    // 🔄 Tool Loop Detection: track tool call history for this request
    const toolCallHistory: ToolCallHistoryEntry[] = [];

    let stepCount = 0;
    const MAX_STEPS = 5;

    while (stepCount < MAX_STEPS) {
        stepCount++;

        try {
            const result = streamText({
                model,
                system: systemPromptContext,
                messages,
                tools: filteredTools,
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

                // ─── Transcript: Log tool call ───
                Transcript.append({
                    role: 'tool-call',
                    content: JSON.stringify(rawToolCall.arguments || {}),
                    meta: { toolName: rawToolCall.name, tier: 'tier1', model: modelName },
                });

                const toolFn = (tools as any)[rawToolCall.name];
                let toolOutput = '';
                let success = false;
                const toolStart = Date.now();

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

                const toolDuration = Date.now() - toolStart;

                // ─── Transcript: Log tool result with duration ───
                Transcript.append({
                    role: 'tool-result',
                    content: toolOutput,
                    meta: {
                        toolName: rawToolCall.name,
                        success,
                        tier: 'tier1',
                        model: modelName,
                        durationMs: toolDuration,
                        ...(!success ? { error: toolOutput.slice(0, 200) } : {}),
                    },
                });

                callbacks.onToolResult?.(rawToolCall.name, success, toolOutput);

                // 🔄 Tool Loop Detection
                toolCallHistory.push({
                    argsHash: hashToolCall(rawToolCall.name, rawToolCall.arguments || {}),
                    resultHash: hashResult(toolOutput),
                    toolName: rawToolCall.name,
                });
                const loopCheck = detectToolCallLoop(toolCallHistory, rawToolCall.name, rawToolCall.arguments || {});
                if (loopCheck.stuck) {
                    console.warn(`  🚨 [tier1] Loop detected (${loopCheck.detector}): ${loopCheck.message}`);
                    callbacks.onChunk(`\n⚠️ Loop detected: ${loopCheck.message}. Breaking out.\n`);
                    callbacks.onDone(`Loop circuit breaker activated: ${loopCheck.message}`);
                    return { tier: 'tier1', model: modelName };
                }

                messages.push({ role: 'assistant', content: fullText });
                messages.push({ role: 'user', content: `[System Tool Execution Result]:\n${toolOutput}\n\nWhen you receive a tool execution output, formulate a natural language response to the user based on that output. DO NOT output JSON anymore unless another tool is needed.` });

                continue; // Immediately loop again!
            }

            if (isJsonMode && !rawToolCall && !nativeToolUsed && fullText.trim().length > 0) {
                callbacks.onChunk(fullText.trim());
            }

            const finalText = isJsonMode && !rawToolCall && !nativeToolUsed ? fullText.trim() : fullText;
            // ─── Transcript: Log assistant turn ───
            Transcript.append({ role: 'assistant', content: finalText, meta: { tier: 'tier1', model: modelName } });
            callbacks.onDone(finalText);
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
    senderRole: SenderRole = 'owner',
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
    const rawTools = CapabilityRegistry.getAvailableTools();

    // 🛡️ Tool Policy: Strip owner-only tools for non-owner senders
    const tools = senderRole === 'owner' ? rawTools : applyToolPolicy(rawTools as Record<string, unknown>, senderRole) as typeof rawTools;

    // Enrich system prompt with capability manifest and external context
    let fullSystemPrompt = [
        getPersonaContext(),
        getSystemPromptTier2(),
        `\n\n${PROACTIVE_DIRECTIVE}`,
        `\n\n${CapabilityRegistry.getCapabilityManifest()}`,
        context ? `\n## Additional Session Context\n${context}` : '',
    ].join('');

    // 📚 Skills injection — load relevant skill instructions
    try {
        const skillPrompt = await getRelevantSkillPrompt(prompt);
        if (skillPrompt) {
            fullSystemPrompt += skillPrompt;
            console.log(`  📚 [tier2] Skill prompt injected`);
        }
    } catch (err) {
        console.error('  ❌ [tier2] Failed to load skills:', err);
    }

    try {
        // ── Sanitize tool schemas: Anthropic requires input_schema.type = "object" ──
        // Some tools (MCP, Forged) may produce schemas missing the `type` field.
        // This belt-and-suspenders check catches ANY broken schema before sending to the provider.
        const toolEntries = Object.entries(tools);
        for (let i = 0; i < toolEntries.length; i++) {
            const [name, t] = toolEntries[i]!;
            const params = (t as any)?.parameters;

            // Check jsonSchema-wrapped tools (MCP tools use `parameters` with jsonSchema)
            if (params?.jsonSchema) {
                if (!params.jsonSchema.type) {
                    console.warn(`  ⚠️ [tier2] Tool[${i}] "${name}" — missing schema.type, injecting "object"`);
                    params.jsonSchema.type = 'object';
                }
                if (!params.jsonSchema.properties) {
                    params.jsonSchema.properties = {};
                }
            }

            // Check Zod-based tools that use `inputSchema` (native + forged tools)
            const inputSchema = (t as any)?.inputSchema;
            if (inputSchema?.jsonSchema) {
                if (!inputSchema.jsonSchema.type) {
                    console.warn(`  ⚠️ [tier2] Tool[${i}] "${name}" — inputSchema missing type, injecting "object"`);
                    inputSchema.jsonSchema.type = 'object';
                }
                if (!inputSchema.jsonSchema.properties) {
                    inputSchema.jsonSchema.properties = {};
                }
            }
        }
        console.log(`  🧠 [tier2] Calling ${config.provider}/${config.model} with ${Object.keys(tools).length} tools (AutoRAG: ${ragResult.chunksFound} chunks)`);

        // ─── Transcript: Log user turn ───
        Transcript.append({ role: 'user', content: prompt, meta: { tier: 'tier2', model: config.model } });

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

        // 🔧 Transcript Repair: ensure tool-use/result parity (Anthropic requirement)
        const repairReport = repairToolUseResultPairing(messages);
        if (repairReport.syntheticResultsAdded > 0 || repairReport.orphanResultsDropped > 0) {
            console.log(`  🔧 [tier2] Transcript repair: +${repairReport.syntheticResultsAdded} synthetic results, -${repairReport.orphanResultsDropped} orphans, ${repairReport.payloadsTrimmed} payloads trimmed`);
            messages = repairReport.messages;
        }

        // 📏 Context Window Guard: pre-flight token budget check
        const systemTokens = estimateTokens(fullSystemPrompt);
        const msgTokens = messages.reduce((sum: number, m: any) => sum + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')), 0);
        const guard = evaluateContextWindowGuard(config.model, systemTokens, msgTokens);
        if (guard.shouldBlock) {
            console.warn(`  🚫 [tier2] Context window BLOCKED: ${guard.usedTokens}/${guard.maxTokens} tokens used, ${guard.remainingTokens} remaining`);
            // Attempt compaction before giving up
            const compacted = await compactHistory(messages, {
                maxTokens: Math.floor(guard.maxTokens * 0.7),
                targetTokens: Math.floor(guard.maxTokens * 0.5),
                summarize: async (text, instruction) => {
                    // Use a lightweight summarization call
                    const summaryModel = createTier2Model();
                    const summaryResult = streamText({ model: summaryModel, system: instruction, messages: [{ role: 'user' as const, content: text }] });
                    let summary = '';
                    for await (const part of summaryResult.fullStream) {
                        if (part.type === 'text-delta') summary += part.text;
                    }
                    return summary;
                },
            });
            if (compacted.compacted) {
                messages = compacted.messages;
                console.log(`  📦 [tier2] Compaction applied: ${compacted.originalTokens} → ${compacted.finalTokens} tokens`);
            } else {
                callbacks.onError(new Error(`Context window exceeded (${guard.usedTokens}/${guard.maxTokens} tokens). Please start a new conversation.`));
                return { tier: 'tier2', model: config.model };
            }
        } else if (guard.action === 'compact') {
            console.log(`  ⚠️ [tier2] Context window warning: ${guard.remainingTokens} tokens remaining. Consider compaction soon.`);
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
        /** Tracks tool-call start times for duration measurement */
        const toolTimers = new Map<string, number>();
        /** 🔄 Tool Loop Detection: track history for this request */
        const tier2ToolHistory: ToolCallHistoryEntry[] = [];
        /** Track last tool call args for loop detection pairing */
        let lastToolCallArgs: unknown = {};

        for await (const part of result.fullStream) {
            eventCount++;
            switch (part.type) {
                case 'text-delta':
                    fullText += part.text;
                    callbacks.onChunk(part.text);
                    break;

                case 'tool-call':
                    toolCalled = true;
                    toolTimers.set(part.toolName, Date.now());
                    lastToolCallArgs = part.input;
                    console.log(`  🔧 [tier2] Tool call: ${part.toolName}`);
                    Transcript.append({
                        role: 'tool-call',
                        content: JSON.stringify(part.input),
                        meta: { toolName: part.toolName, tier: 'tier2', model: config.model },
                    });
                    callbacks.onToolCall?.(
                        part.toolName,
                        part.input as Record<string, unknown>,
                    );
                    break;

                case 'tool-result': {
                    const toolDurationMs = toolTimers.has(part.toolName)
                        ? Date.now() - toolTimers.get(part.toolName)!
                        : undefined;
                    toolTimers.delete(part.toolName);
                    console.log(`  🔧 [tier2] Tool result: ${part.toolName}${toolDurationMs != null ? ` (${toolDurationMs}ms)` : ''}`);
                    const toolOutput = typeof part.output === 'string'
                        ? part.output
                        : JSON.stringify(part.output, null, 2);
                    const toolSuccess = typeof part.output === 'object' && part.output !== null && 'success' in part.output
                        ? (part.output as { success: boolean }).success
                        : true;
                    // Transcript logs with auto-truncation (1000 chars)
                    Transcript.append({
                        role: 'tool-result',
                        content: toolOutput,
                        meta: {
                            toolName: part.toolName,
                            success: toolSuccess,
                            tier: 'tier2',
                            model: config.model,
                            durationMs: toolDurationMs,
                            ...(!toolSuccess ? { error: toolOutput.slice(0, 200) } : {}),
                        },
                    });
                    callbacks.onToolResult?.(part.toolName, toolSuccess, toolOutput);

                    // 🔄 Tool Loop Detection
                    tier2ToolHistory.push({
                        argsHash: hashToolCall(part.toolName, lastToolCallArgs),
                        resultHash: hashResult(toolOutput),
                        toolName: part.toolName,
                    });
                    const loopResult = detectToolCallLoop(tier2ToolHistory, part.toolName, lastToolCallArgs);
                    if (loopResult.stuck && loopResult.level === 'critical') {
                        console.warn(`  🚨 [tier2] Loop detected (${loopResult.detector}): ${loopResult.message}`);
                        callbacks.onChunk(`\n⚠️ Tool loop detected: ${loopResult.message}. Breaking out.\n`);
                    }
                    break;
                }

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

        // ─── Transcript: Log assistant turn ───
        Transcript.append({ role: 'assistant', content: fullText, meta: { tier: 'tier2', model: config.model } });

        callbacks.onDone(fullText);
        return { tier: 'tier2', model: config.model };
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('  ❌ [tier2] Exception:', error.message);
        callbacks.onError(error);
        return { tier: 'tier2', model: config.model };
    }
}

// ─── Worker Engine: Background Heavy Task Execution ───────────────

/**
 * askWorkerEngine — Executes a prompt on the Worker Engine (CPU/RAM-bound).
 * Used for heavy tasks like memory distillation, deep analysis, code review.
 * Runs synchronously (blocking) but is called from the HeartbeatManager's
 * independent worker loop, so it never blocks the Live chat.
 */
export async function askWorkerEngine(prompt: string): Promise<{ result: string; model: string }> {
    const workerConfig = getWorkerEngineConfig();
    if (!workerConfig.enabled) {
        throw new Error('Worker Engine is not enabled. Run: redbus config');
    }

    const model = createWorkerModel();
    console.log(`  🏗️ [worker] Processing on ${workerConfig.model} (CPU-only, ${workerConfig.num_threads} threads)...`);

    try {
        const result = streamText({
            model,
            system: 'You are a background worker AI. Execute the task precisely. Return only the result, no conversational fluff.',
            messages: [{ role: 'user' as const, content: prompt }],
        });

        let fullText = '';
        for await (const part of result.fullStream) {
            if (part.type === 'text-delta') {
                fullText += part.text;
            }
        }

        console.log(`  🏗️ [worker] Completed: ${fullText.length} chars`);
        return { result: fullText, model: workerConfig.model };
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error(`  ❌ [worker] Exception: ${error.message}`);
        throw error;
    }
}

// ─── Live Engine Alias ────────────────────────────────────────────

/**
 * askLiveEngine — Alias for askTier1. Uses the Live Engine (VRAM-bound)
 * for real-time chat. The Live Engine config falls back to tier1 if
 * live_engine is not explicitly configured in the Vault.
 */
export const askLiveEngine = askTier1;

export function getRouterStatus(): {
    tier1: { url: string; model: string; enabled: boolean };
    tier2: { provider: string; model: string; configured: boolean; authMethod?: string } | null;
    workerEngine: { model: string; enabled: boolean; num_threads: number } | null;
    forgedTools: number;
} {
    const tier1 = getTier1Config();
    const tier2Config = getTier2Config();
    const validation = validateTier2Config();
    const registryCount = ToolRegistry.getAll().length;
    const workerConfig = getWorkerEngineConfig();

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
        workerEngine: workerConfig.enabled
            ? {
                model: workerConfig.model,
                enabled: true,
                num_threads: workerConfig.num_threads,
            }
            : null,
        forgedTools: registryCount,
    };
}
