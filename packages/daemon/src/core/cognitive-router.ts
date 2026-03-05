/**
 * @redbusagent/daemon — Cognitive Router
 *
 * The brain's routing layer. Abstracts LLM calls behind two engine slots:
 *
 *  • Live Engine (Fast)   → Cloud API (Google, Anthropic, OpenAI) or Local Ollama
 *  • Worker Engine (Deep) → Cloud API or Local Ollama for background reasoning & insights
 *
 * MemGPT Architecture Integration:
 *  • Auto-RAG: Every user message is silently enriched with top 3
 *    relevant chunks from Archival Memory before reaching the LLM.
 *  • Core Working Memory: Injected via system prompt (system-prompt.ts).
 *  • Tools include core_memory_replace and core_memory_append.
 */

import { streamText, stepCountIs, type LanguageModel, tool } from 'ai';
import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

import {
    getTier2Config,
    getTier2ApiKey,
    validateTier2Config,
    resolveAnthropicAuth,
    getLiveEngineConfig,
    getWorkerEngineConfig,
} from '../infra/llm-config.js';
import { getSystemPromptLiveGold, getSystemPromptTier2 } from './system-prompt.js';
import { PersonaManager, Vault } from '@redbusagent/shared';
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

// ─── Thinking Protocol ────────────────────────────────────────────

/**
 * Tools that require a <thinking> block before invocation.
 * The Router will reject these tool calls if no architectural
 * reasoning was output by the LLM first.
 */
const THINKING_REQUIRED_TOOLS = new Set([
    'forge_and_test_skill',
]);

const THINKING_REJECTION = 'Error: You must output a <thinking> architectural plan before forging a tool. ' +
    'Explain: (1) WHY you need this tool, (2) HOW it integrates with your existing architecture, ' +
    '(3) WHAT the expected input/output contract is. Then call forge_and_test_skill again.';

/**
 * Validates that the LLM output a <thinking>...</thinking> block before
 * calling a tool that requires explicit reasoning.
 */
function validateThinkingProtocol(toolName: string, precedingText: string): { valid: boolean; error?: string } {
    if (!THINKING_REQUIRED_TOOLS.has(toolName)) {
        return { valid: true };
    }

    // Check if the preceding text contains a <thinking> block
    const hasThinkingOpen = precedingText.includes('<thinking>');
    const hasThinkingClose = precedingText.includes('</thinking>');

    if (!hasThinkingOpen || !hasThinkingClose) {
        console.warn(`  🚫 [thinking-protocol] Rejected ${toolName}: no <thinking> block found`);
        return { valid: false, error: THINKING_REJECTION };
    }

    // Extract the thinking content and validate it's not trivially empty
    const thinkingMatch = precedingText.match(/<thinking>([\s\S]*?)<\/thinking>/);
    const thinkingContent = thinkingMatch?.[1]?.trim() || '';

    if (thinkingContent.length < 50) {
        console.warn(`  🚫 [thinking-protocol] Rejected ${toolName}: <thinking> block too short (${thinkingContent.length} chars)`);
        return {
            valid: false,
            error: 'Error: Your <thinking> block is too brief. Provide detailed architectural reasoning (at least 50 characters) covering WHY, HOW, and WHAT before forging.',
        };
    }

    console.log(`  ✅ [thinking-protocol] ${toolName} approved — <thinking> block validated (${thinkingContent.length} chars)`);
    return { valid: true };
}

// ─── Persona Helpers ──────────────────────────────────────────────

function getPersonaContext(): string {
    const persona = PersonaManager.read();
    if (!persona) return '';
    return `You are ${persona.agent_name}. Your user's context is: ${persona.user_context}. Your behavioral guidelines are: ${persona.behavioral_guidelines}.\n\n`;
}

// ─── Provider Factory ─────────────────────────────────────────────

/** Creates a cloud LanguageModel from a provider name + apiKey + model */
function createCloudModel(provider: string, apiKey: string, model: string): LanguageModel {
    switch (provider) {
        case 'anthropic': {
            const anthropic = createAnthropic({ apiKey });
            return anthropic(model);
        }
        case 'google': {
            const google = createGoogleGenerativeAI({ apiKey });
            return google(model);
        }
        case 'openai': {
            const openai = createOpenAI({ apiKey });
            return openai(model);
        }
        default:
            throw new Error(`Unknown cloud provider: ${provider}`);
    }
}

function createLiveModel(): LanguageModel {
    const liveConfig = getLiveEngineConfig();

    // Cloud or Local: All Live Engine providers go through the appropriate factory.
    if (liveConfig.provider) {
        if (liveConfig.provider !== 'ollama' && !liveConfig.apiKey) {
            throw new Error(`Live Engine (${liveConfig.provider}) requires an API key. Run: redbus config`);
        }
        if (liveConfig.provider === 'ollama') {
            // Local Ollama
            const ollama = createOpenAI({
                baseURL: `${liveConfig.url || 'http://127.0.0.1:11434'}/v1`,
                apiKey: 'ollama',
                fetch: async (url, fetchOptions) => {
                    if (fetchOptions?.body && Vault.read()?.gpu_acceleration) {
                        try {
                            const body = JSON.parse(fetchOptions.body as string);
                            body.options = { ...body.options, num_gpu: 999 };
                            fetchOptions.body = JSON.stringify(body);
                        } catch (e) {
                            // ignore
                        }
                    }
                    return fetch(url, fetchOptions);
                }
            });
            return ollama(liveConfig.model);
        }
        return createCloudModel(liveConfig.provider, liveConfig.apiKey!, liveConfig.model);
    }

    // Default: use Google provider
    if (!liveConfig.apiKey) throw new Error('Live Engine requires an API key. Run: redbus config');
    return createCloudModel('google', liveConfig.apiKey, liveConfig.model);
}

export function createTier2Model(): LanguageModel {
    const workerConfig = getWorkerEngineConfig();

    switch (workerConfig.provider) {
        case 'anthropic': {
            const auth = resolveAnthropicAuth();
            const anthropic = createAnthropic(
                auth.method === 'oauth_token'
                    ? { apiKey: '', authToken: auth.authToken }
                    : { apiKey: auth.apiKey },
            );
            return anthropic(workerConfig.model);
        }
        case 'google': {
            const google = createGoogleGenerativeAI({ apiKey: workerConfig.apiKey! });
            return google(workerConfig.model);
        }
        case 'openai': {
            const openai = createOpenAI({ apiKey: workerConfig.apiKey! });
            return openai(workerConfig.model);
        }
        default:
            throw new Error(`Unknown provider: ${workerConfig.provider as string}`);
    }
}


// ─── Worker Engine Model Factory (Cloud-First) ──────────────────

export function createWorkerModel(): LanguageModel {
    const workerConfig = getWorkerEngineConfig();

    // Cloud or Local: Worker Engine uses cloud provider APIs or local Ollama.
    if (workerConfig.provider && workerConfig.provider !== 'ollama') {
        if (!workerConfig.apiKey) throw new Error(`Worker Engine (${workerConfig.provider}) requires an API key. Run: redbus config`);
        return createCloudModel(workerConfig.provider, workerConfig.apiKey, workerConfig.model);
    }

    // Local Ollama
    if (workerConfig.provider === 'ollama') {
        const workerOllama = createOpenAI({
            baseURL: `${workerConfig.url || 'http://127.0.0.1:11434'}/v1`,
            apiKey: 'ollama',
            fetch: async (url, fetchOptions) => {
                if (fetchOptions?.body && Vault.read()?.gpu_acceleration) {
                    try {
                        const body = JSON.parse(fetchOptions.body as string);
                        body.options = { ...body.options, num_gpu: 999 };
                        fetchOptions.body = JSON.stringify(body);
                    } catch (e) {
                        // ignore
                    }
                }
                return fetch(url, fetchOptions);
            }
        });
        return workerOllama(workerConfig.model);
    }

    // Default: use Anthropic
    if (!workerConfig.apiKey) throw new Error('Worker Engine requires an API key. Run: redbus config');
    return createCloudModel('anthropic', workerConfig.apiKey, workerConfig.model);
}

// ─── Gemma 3 Explicit Tool Calling Adapter ────────────────────────
export function generateGemma3ToolPrompt(tools: Record<string, any>): string {
    const schemas = Object.entries(tools).map(([name, tool]) => {
        let schema = {};
        if (tool.parameters?.jsonSchema) {
            schema = tool.parameters.jsonSchema;
        } else if (tool.inputSchema?.jsonSchema) {
            schema = tool.inputSchema.jsonSchema;
        } else {
            // Fallback for tools without explicit inner jsonSchema
            schema = tool.parameters || tool.inputSchema || {};
        }
        return {
            name,
            description: tool.description,
            parameters: schema
        };
    });

    return `\n\nYou have access to the following tools:
${JSON.stringify(schemas, null, 2)}

To use a tool, you MUST output an XML block exactly like this:
<tool_call name="tool_name">
{"param1": "value1"}
</tool_call>

CRITICAL RULES: 
1. DO NOT give an example of how to make a tool call. If the user asks for something that requires a tool, YOU MUST ACTUALLY CALL THE TOOL to perform the request right now in reality.
2. The JSON inside the XML must NOT be nested inside another "arguments" object. Just the parameters directly.
3. The JSON MUST be correctly formatted. Escape all internal quotes or newlines.
4. You should provide a short, helpful conversational reply to the user BEFORE outputting the <tool_call> block (e.g. "I am delegating this task to the engineering agent..."). Do not use markdown code blocks (\`\`\`xml) around the tool call.`;
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
    tier: 'live' | 'cloud' | 'worker';
    model: string;
}

// ─── Public API ───────────────────────────────────────────────────

export async function askLive(
    prompt: string,
    callbacks: StreamCallbacks,
    messagesFromClient?: any[],
    senderRole: SenderRole = 'owner',
    options?: { disableTools?: boolean }
): Promise<CognitiveRouterResult> {
    const liveEngineConf = getLiveEngineConfig();
    const modelName = liveEngineConf.model;
    const model = createLiveModel();

    // ──── Auto-RAG Pre-flight Injection ────
    const ragResult = await AutoRAG.enrich(prompt);
    const enrichedPrompt = ragResult.enrichedPrompt;

    // Cloud-First: All cloud models are treated as full-capability (Gold-class)
    const baseTools = CapabilityRegistry.getAvailableTools();

    // 🛡️ Tool Policy: Strip owner-only tools for non-owner senders (system/scheduled)
    const filteredTools = senderRole === 'owner' ? baseTools : applyToolPolicy(baseTools as Record<string, unknown>, senderRole) as typeof baseTools;

    // ─── Dynamic Handoff Tool Injection ───
    const runtimeTools: Record<string, any> = { ...filteredTools };
    const workerConfig = getWorkerEngineConfig();

    // Only inject if Worker Engine is explicitly enabled and properly configured
    if (workerConfig.enabled && workerConfig.model) {
        runtimeTools['delegate_to_worker_engine'] = {
            description: 'Delegate complex engineering, coding, forging, automation scripts, or deep analysis tasks to the powerful Worker Engine. Use this whenever the user asks to build a script, create a routine, automate a workflow, or do something you cannot do natively. The Worker Engine is an advanced agent with full access to Node.js/Python sandbox, Playwright for web automation/scraping, full terminal shell, and a secure Vault for managing credentials or passwords. It can read emails, interact with internal systems, and do advanced ops.',
            parameters: z.object({
                task_prompt: z.string().describe('Detailed prompt explaining exactly what the user wants to build or automate. Include all necessary context, and specify any tools the worker should use (like Playwright, Vault, etc).')
            }),
            execute: async (params: { task_prompt: string }) => {
                callbacks.onChunk('\n\n🛠️  [Live Engine] Delegating complex task to the Engineering Worker Engine...\n\n');
                console.log(`  🧠 [Router]: Intent FORGE/DELEGATE → Routing to Worker Engine via tool call`);
                // Dynamically invoke askTier2 to run the heavy processing 
                // Using { disableTools: false } ensures the worker can use its tools
                await askTier2(params.task_prompt, callbacks, undefined, messagesFromClient, senderRole, { disableTools: false });

                return `The Worker Engine executed the task successfully and communicated the result to the user. You do not need to repeat its output. Just inform the user the task is complete.`;
            }
        };
    }

    // ─── System Prompt Construction (full context for cloud models) ────
    let systemPromptContext = getPersonaContext() + getSystemPromptLiveGold();
    systemPromptContext += `\n\n${PROACTIVE_DIRECTIVE}\n\n${CapabilityRegistry.getCapabilityManifest()}`;

    // Cloud Wisdom injection
    try {
        const wisdom = await MemoryManager.searchMemory('cloud_wisdom', prompt, 3);
        if (wisdom && wisdom.length > 0) {
            systemPromptContext += `\n\nPAST SUCCESSFUL EXAMPLES (Mimic this level of reasoning):\n`;
            wisdom.forEach((w) => {
                systemPromptContext += `${w}\n\n`;
            });
        }
    } catch (err) {
        console.error('  ❌ [live] Failed to retrieve cloud wisdom:', err);
    }

    // 📚 Skills injection — load relevant skill instructions
    try {
        const skillPrompt = await getRelevantSkillPrompt(prompt);
        if (skillPrompt) {
            systemPromptContext += skillPrompt;
            console.log(`  📚 [live] Skill prompt injected`);
        }
    } catch (err) {
        console.error('  ❌ [live] Failed to load skills:', err);
    }

    // 🤖 Gemma 3 Adapter
    const isGemma3 = modelName.toLowerCase().includes('gemma3');
    if (isGemma3 && !options?.disableTools) {
        systemPromptContext += generateGemma3ToolPrompt(runtimeTools);
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
    Transcript.append({ role: 'user', content: prompt, meta: { tier: 'live', model: modelName } });

    // 🔄 Tool Loop Detection: track tool call history for this request
    const toolCallHistory: ToolCallHistoryEntry[] = [];

    let stepCount = 0;
    const MAX_STEPS = 5;

    while (stepCount < MAX_STEPS) {
        stepCount++;

        try {
            // ─── ReAct Loop via AI SDK ─────────────────────────────────
            // stopWhen enables multi-step: the SDK will automatically feed
            // tool results back to the model and continue generating text.
            // This is the OpenClaw-style ReAct loop — the stream emits
            // text → tool-call → tool-result → more text → done.
            const result = streamText({
                model,
                system: systemPromptContext,
                messages,
                tools: (options?.disableTools || isGemma3) ? undefined : runtimeTools,
                stopWhen: (options?.disableTools || isGemma3) ? undefined : stepCountIs(MAX_STEPS),
                onError: ({ error }) => {
                    console.error('  ❌ [live] streamText onError:', error);
                },
            });

            let fullText = '';
            let rawToolCall: any = null;
            let isJsonMode = false;
            let isDetermining = true;
            let hasSentThinking = false;
            let nativeToolUsed = false;
            // Track text emitted per "step" so we can stream continuation
            // text after tool results properly to the user.
            let stepText = '';
            let afterToolResult = false;

            for await (const part of result.fullStream) {
                if (part.type === 'text-delta') {
                    fullText += part.text;
                    stepText += part.text;

                    // After a tool result, we are in "continuation mode":
                    // stream every delta directly to the user so they see
                    // the model's follow-up response in real time.
                    if (afterToolResult) {
                        callbacks.onChunk(part.text);
                        continue;
                    }

                    if (isDetermining && fullText.trim().length > 0) {
                        const trimmed = fullText.trim();
                        if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('```') || trimmed.startsWith('<tool_call>')) {
                            isJsonMode = true;
                            isDetermining = false;
                            if (!hasSentThinking) {
                                callbacks.onChunk('⏳ Intercepting Tool Call (JSON)...\n');
                                hasSentThinking = true;
                            }
                        } else if (trimmed.length > 15) {
                            // Only exit determining phase if we haven't seen signs of an upcoming tool call
                            if (!fullText.includes('<tool_call') && !fullText.includes('```xml')) {
                                isDetermining = false;
                                callbacks.onChunk(fullText); // Output standard buffer
                            }
                        }
                    } else if (!isDetermining && !isJsonMode) {
                        // Mid-stream switch to suppression mode if we hit a tool call block
                        if (fullText.includes('<tool_call') || fullText.includes('```xml')) {
                            isJsonMode = true; // Engage silence mode
                        } else {
                            callbacks.onChunk(part.text);
                        }
                    }
                } else if (part.type === 'tool-call') {
                    nativeToolUsed = true;
                    console.log(`  🔧 [live] Native Tool call: ${part.toolName} (step ${stepCount})`);

                    // 🧠 Thinking Protocol: Reject forge calls without <thinking> block
                    const thinkingCheck = validateThinkingProtocol(part.toolName, fullText);
                    if (!thinkingCheck.valid) {
                        console.warn(`  🚫 [live] Thinking protocol rejected: ${part.toolName}`);
                        callbacks.onChunk(`\n${thinkingCheck.error}\n`);
                        // Continue processing the stream — the SDK will handle the rejection
                    }

                    // ─── Transcript: Log tool call ───
                    Transcript.append({
                        role: 'tool-call',
                        content: JSON.stringify(part.input),
                        meta: { toolName: part.toolName, tier: 'live', model: modelName },
                    });
                    callbacks.onToolCall?.(part.toolName, part.input as Record<string, unknown>);
                } else if (part.type === 'tool-result') {
                    console.log(`  🔧 [live] Native Tool result: ${part.toolName}`);

                    // ─── Transcript: Log tool result ───
                    Transcript.append({
                        role: 'tool-result',
                        content: typeof part.output === 'string'
                            ? part.output
                            : JSON.stringify(part.output, null, 2),
                        meta: {
                            toolName: part.toolName,
                            success: typeof part.output === 'object' && part.output !== null && 'success' in part.output
                                ? (part.output as { success: boolean }).success
                                : true,
                            tier: 'live',
                            model: modelName,
                        },
                    });

                    callbacks.onToolResult?.(
                        part.toolName,
                        typeof part.output === 'object' && part.output !== null && 'success' in part.output
                            ? (part.output as { success: boolean }).success
                            : true,
                        typeof part.output === 'string'
                            ? part.output
                            : JSON.stringify(part.output, null, 2),
                    );

                    // 🔄 Tool Loop Detection
                    const toolArgs = (part as any).args || (part as any).input || {};
                    const toolResult = typeof part.output === 'string'
                        ? part.output
                        : JSON.stringify(part.output);
                    toolCallHistory.push({
                        argsHash: hashToolCall(part.toolName, toolArgs),
                        resultHash: hashResult(toolResult),
                        toolName: part.toolName,
                    });
                    const loopCheck = detectToolCallLoop(toolCallHistory, part.toolName, toolArgs);
                    if (loopCheck.stuck) {
                        console.warn(`  🚨 [live] Loop detected (${loopCheck.detector}): ${loopCheck.message}`);
                        callbacks.onChunk(`\n⚠️ Loop detected: ${loopCheck.message}. Breaking out.\n`);
                        callbacks.onDone(`Loop circuit breaker activated: ${loopCheck.message}`);
                        return { tier: 'live', model: modelName };
                    }

                    // Reset for the continuation step: the model will now
                    // generate text based on the tool result.
                    afterToolResult = true;
                    stepText = '';
                } else if (part.type === 'error') {
                    console.error('  ❌ [live] Stream error event:', part.error);
                    callbacks.onError(part.error instanceof Error ? part.error : new Error(String(part.error)));
                }
            }

            // ─── Raw JSON Interceptor (Fallback for non-native tool calling) ───
            // Only used if the model didn't use native SDK tool calling
            if (!nativeToolUsed) {
                try {
                    // GEMMA 3 XML ADAPTER
                    const xmlMatch = fullText.match(/<tool_call(?: name="([^"]+)")?>([\s\S]*?)<\/tool_call>/);
                    if (xmlMatch && xmlMatch[2]) {
                        const parsedName = xmlMatch[1];
                        let jsonStr = xmlMatch[2].trim();

                        let parsed: any = null;
                        try {
                            // Attempt emergency repair of unclosed JSON object (common with complex strings)
                            let repairedStr = jsonStr;
                            if (!repairedStr.endsWith('}')) repairedStr += '}';
                            if (!repairedStr.startsWith('{')) repairedStr = '{' + repairedStr;
                            parsed = JSON.parse(repairedStr);
                        } catch (e) {
                            // XML Tags Fallback! Gemma 3 often generates <param_name>value</param_name> instead of JSON inside <tool_call>
                            const xmlParamsRegex = /<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/g;
                            let match: RegExpExecArray | null;
                            parsed = {};
                            let foundXml = false;
                            while ((match = xmlParamsRegex.exec(jsonStr)) !== null) {
                                const key = match[1];
                                const val = match[2];
                                if (key) {
                                    parsed[key] = val ? val.trim() : '';
                                    foundXml = true;
                                }
                            }
                            if (!foundXml) throw e; // Rethrow if not XML either
                        }

                        // Handle both full nested JSON or flat JSON with name attribute
                        if (parsedName && typeof parsed === 'object') {
                            rawToolCall = { name: parsedName, arguments: parsed };
                        } else if (parsed && typeof parsed.name === 'string' && typeof parsed.arguments === 'object') {
                            rawToolCall = parsed;
                        } else if (parsed && typeof parsed.name === 'string' && typeof parsed.parameters === 'object') {
                            rawToolCall = { name: parsed.name, arguments: parsed.parameters };
                        }
                    } else {
                        // Original JSON fallback
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
                    }
                } catch (e) {
                    // Not JSON/XML — normal text response, no action needed
                }
            }

            // ─── Raw JSON Invisible Execution Loop ───
            if (rawToolCall) {
                console.log(`  🔧 [live] Raw JSON Tool Call Intercepted: ${rawToolCall.name}`);

                // 🧠 Thinking Protocol: Reject forge calls without <thinking> block
                const thinkingCheck = validateThinkingProtocol(rawToolCall.name, fullText);
                if (!thinkingCheck.valid) {
                    callbacks.onChunk(`\n${thinkingCheck.error}\n`);
                    callbacks.onDone(thinkingCheck.error!);
                    return { tier: 'live' as const, model: modelName };
                }

                callbacks.onToolCall?.(rawToolCall.name, rawToolCall.arguments || {});

                // ─── Transcript: Log tool call ───
                Transcript.append({
                    role: 'tool-call',
                    content: JSON.stringify(rawToolCall.arguments || {}),
                    meta: { toolName: rawToolCall.name, tier: 'live', model: modelName },
                });

                const toolFn = (runtimeTools as any)[rawToolCall.name];
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
                        tier: 'live',
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
                    console.warn(`  🚨 [live] Loop detected (${loopCheck.detector}): ${loopCheck.message}`);
                    callbacks.onChunk(`\n⚠️ Loop detected: ${loopCheck.message}. Breaking out.\n`);
                    callbacks.onDone(`Loop circuit breaker activated: ${loopCheck.message}`);
                    return { tier: 'live', model: modelName };
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
            Transcript.append({ role: 'assistant', content: finalText, meta: { tier: 'live', model: modelName } });
            callbacks.onDone(finalText);
            return { tier: 'live', model: modelName };

        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            callbacks.onError(error);
            return { tier: 'live', model: modelName };
        }
    }

    callbacks.onDone("Live Engine maximum tool execution steps limit reached.");
    return { tier: 'live', model: modelName };
}

export async function askTier2(
    prompt: string,
    callbacks: StreamCallbacks,
    context?: string,
    messagesFromClient?: any[],
    senderRole: SenderRole = 'owner',
    options?: { disableTools?: boolean }
): Promise<CognitiveRouterResult> {
    const validation = validateTier2Config();
    if (!validation.valid) {
        callbacks.onError(new Error(validation.error ?? 'Cloud Engine config invalid'));
        const config = getTier2Config();
        return { tier: 'cloud', model: config?.model ?? 'unknown' };
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

    // 🤖 Gemma 3 Adapter
    const isGemma3 = config.model.toLowerCase().includes('gemma3');
    if (isGemma3 && !options?.disableTools) {
        fullSystemPrompt += generateGemma3ToolPrompt(tools);
    }

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
        // ── Exhaustive schema sanitization: Anthropic requires input_schema.type = "object" ──
        // The AI SDK can represent schemas in multiple ways depending on the tool source.
        // We must handle ALL of them to prevent Anthropic rejecting with:
        //   "tools.N.custom.input_schema.type: Field required"
        const toolEntries = Object.entries(tools);
        for (let i = 0; i < toolEntries.length; i++) {
            const [name, t] = toolEntries[i]!;
            const toolObj = t as any;

            // Helper: ensure a schema object has type + properties
            function sanitizeSchema(schema: any): void {
                if (!schema || typeof schema !== 'object') return;
                if (!schema.type) {
                    console.warn(`  ⚠️ [tier2] Tool[${i}] "${name}" — schema missing type, injecting "object"`);
                    schema.type = 'object';
                }
                if (!schema.properties) {
                    schema.properties = {};
                }
            }

            // Shape 1: Zod-based native tools — schema lives at tool.inputSchema?.jsonSchema
            if (toolObj?.inputSchema?.jsonSchema) {
                sanitizeSchema(toolObj.inputSchema.jsonSchema);
            }

            // Shape 2: jsonSchema()-wrapped tools — schema at tool.parameters?.jsonSchema
            if (toolObj?.parameters?.jsonSchema) {
                sanitizeSchema(toolObj.parameters.jsonSchema);
            }

            // Shape 3: some forged/dynamic tools expose schema directly at tool.parameters (no .jsonSchema wrapper)
            if (toolObj?.parameters && !toolObj.parameters.jsonSchema && typeof toolObj.parameters === 'object') {
                const p = toolObj.parameters;
                // Only patch if it looks like a raw JSON schema (has properties or type field already, or is plain object)
                if (p.type !== undefined || p.properties !== undefined || p.$schema !== undefined) {
                    sanitizeSchema(p);
                }
            }

            // Shape 4: tool.schema (some MCP bridges emit this)
            if (toolObj?.schema) {
                sanitizeSchema(toolObj.schema);
            }
        }
        const workerCfg = getWorkerEngineConfig();
        console.log(`  🧠 [tier2] Calling ${workerCfg.provider}/${workerCfg.model} with ${Object.keys(tools).length} tools (AutoRAG: ${ragResult.chunksFound} chunks)`);

        // ─── Transcript: Log user turn ───
        Transcript.append({ role: 'user', content: prompt, meta: { tier: 'cloud', model: config.model } });

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
                return { tier: 'cloud', model: config.model };
            }
        } else if (guard.action === 'compact') {
            console.log(`  ⚠️ [tier2] Context window warning: ${guard.remainingTokens} tokens remaining. Consider compaction soon.`);
        }

        const result = streamText({
            model,
            system: fullSystemPrompt,
            messages,
            tools: (options?.disableTools || isGemma3) ? undefined : tools,
            stopWhen: (options?.disableTools || isGemma3) ? undefined : stepCountIs(5),
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

                case 'tool-call': {
                    // 🧠 Thinking Protocol: Reject forge calls without <thinking> block
                    const tier2ThinkingCheck = validateThinkingProtocol(part.toolName, fullText);
                    if (!tier2ThinkingCheck.valid) {
                        console.warn(`  🚫 [tier2] Thinking protocol rejected: ${part.toolName}`);
                        // Inject the rejection as a tool result so the LLM can retry
                        callbacks.onToolResult?.(part.toolName, false, tier2ThinkingCheck.error!);
                        break;
                    }

                    toolCalled = true;
                    toolTimers.set(part.toolName, Date.now());
                    lastToolCallArgs = part.input;
                    console.log(`  🔧 [tier2] Tool call: ${part.toolName}`);
                    Transcript.append({
                        role: 'tool-call',
                        content: JSON.stringify(part.input),
                        meta: { toolName: part.toolName, tier: 'cloud', model: config.model },
                    });
                    callbacks.onToolCall?.(
                        part.toolName,
                        part.input as Record<string, unknown>,
                    );
                    break;
                }

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
                            tier: 'cloud',
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

        // ─── Gemma 3 XML Output Interceptor (Fallback) ───
        if (!toolCalled && isGemma3) {
            try {
                const xmlMatch = fullText.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
                if (xmlMatch && xmlMatch[1]) {
                    const parsed = JSON.parse(xmlMatch[1].trim());
                    if (parsed && typeof parsed.name === 'string' && typeof parsed.arguments === 'object') {
                        const rawToolCall = parsed;
                        console.log(`  🔧 [tier2] XML Tool Call Intercepted: ${rawToolCall.name}`);

                        const thinkingCheck = validateThinkingProtocol(rawToolCall.name, fullText);
                        if (!thinkingCheck.valid) {
                            callbacks.onChunk(`\n${thinkingCheck.error}\n`);
                            callbacks.onDone(thinkingCheck.error!);
                            return { tier: 'cloud', model: config.model };
                        }

                        callbacks.onToolCall?.(rawToolCall.name, rawToolCall.arguments || {});

                        Transcript.append({
                            role: 'tool-call',
                            content: JSON.stringify(rawToolCall.arguments || {}),
                            meta: { toolName: rawToolCall.name, tier: 'cloud', model: config.model },
                        });

                        const toolFn = (tools as any)[rawToolCall.name];
                        let toolOutput = '';
                        let success = false;
                        const toolStart = Date.now();

                        if (toolFn) {
                            try {
                                const res = await toolFn.execute(rawToolCall.arguments || {}, { toolCallId: 'raw-2', messages: [] });
                                toolOutput = typeof res === 'string' ? res : JSON.stringify(res);
                                success = true;
                            } catch (e: any) {
                                toolOutput = e.message || String(e);
                            }
                        } else {
                            toolOutput = `Error: Tool '${rawToolCall.name}' not found.`;
                        }

                        const toolDuration = Date.now() - toolStart;

                        Transcript.append({
                            role: 'tool-result',
                            content: toolOutput,
                            meta: {
                                toolName: rawToolCall.name,
                                success,
                                tier: 'cloud',
                                model: config.model,
                                durationMs: toolDuration,
                                ...(!success ? { error: toolOutput.slice(0, 200) } : {}),
                            },
                        });

                        callbacks.onToolResult?.(rawToolCall.name, success, toolOutput);

                        // Feed the result back using askTier2 recursively once
                        console.log(`  🔄 [tier2] Feeding XML tool result back to model...`);
                        const followUpPrompt = `[System Tool Execution Result for ${rawToolCall.name}]:\n${toolOutput}\n\nWhen you receive a tool execution output, formulate a natural language response to the user based on that output. DO NOT output JSON anymore unless another tool is needed.`;

                        return await askTier2(followUpPrompt, callbacks, context, messagesFromClient, senderRole, { disableTools: false });
                    }
                }
            } catch (err) {
                // Not JSON inside <tool_call>
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
        Transcript.append({ role: 'assistant', content: fullText, meta: { tier: 'cloud', model: config.model } });

        callbacks.onDone(fullText);
        return { tier: 'cloud', model: config.model };
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('  ❌ [tier2] Exception:', error.message);
        callbacks.onError(error);
        return { tier: 'cloud', model: config.model };
    }
}

// ─── Worker Engine: Background Heavy Task Execution ───────────────

/**
 * askWorkerEngine — Executes a prompt on the Worker Engine (cloud-based).
 * Used for heavy tasks like memory distillation, deep analysis, insight generation.
 * Runs synchronously (blocking) but is called from the HeartbeatManager's
 * independent worker loop, so it never blocks the Live chat.
 */
export async function askWorkerEngine(prompt: string): Promise<{ result: string; model: string }> {
    const workerConfig = getWorkerEngineConfig();
    if (!workerConfig.enabled) {
        throw new Error('Worker Engine is not enabled. Run: redbus config');
    }

    const model = createWorkerModel();
    console.log(`  🏗️ [worker] Processing on ${workerConfig.provider}/${workerConfig.model}...`);

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
 * askLiveEngine — Alias for askLive. Uses the Live Engine (cloud API)
 * for real-time chat.
 */
export const askLiveEngine = askLive;
/** @deprecated Use askLive or askLiveEngine instead */
export const askTier1 = askLive;

export function getRouterStatus(): {
    liveEngine: { url: string; model: string; enabled: boolean; provider?: string };
    tier2: { provider: string; model: string; configured: boolean; authMethod?: string } | null;
    workerEngine: { model: string; enabled: boolean; num_threads: number; provider?: string } | null;
    forgedTools: number;
} {
    const liveConfig = getLiveEngineConfig();
    const tier2Config = getTier2Config();
    const validation = validateTier2Config();
    const registryCount = ToolRegistry.getAll().length;
    const workerConfig = getWorkerEngineConfig();

    return {
        liveEngine: {
            url: liveConfig.url,
            model: liveConfig.model,
            enabled: liveConfig.enabled,
            provider: liveConfig.provider,
        },
        tier2: workerConfig.enabled
            ? {
                provider: workerConfig.provider || 'anthropic',
                model: workerConfig.model || 'none',
                configured: workerConfig.provider === 'ollama' || !!workerConfig.apiKey,
                authMethod: workerConfig.provider === 'ollama' ? 'Local API' : 'API key',
            }
            : null,
        workerEngine: workerConfig.enabled
            ? {
                model: workerConfig.model || 'none',
                enabled: true,
                num_threads: workerConfig.num_threads,
                provider: workerConfig.provider || 'anthropic',
            }
            : null,
        forgedTools: registryCount,
    };
}
