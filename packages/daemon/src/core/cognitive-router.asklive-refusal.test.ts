import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    streamText: vi.fn(),
    searchMemory: vi.fn(async () => []),
    enrich: vi.fn(async (prompt: string) => ({ enrichedPrompt: prompt })),
    append: vi.fn(),
    workerConfig: {
        url: '',
        model: 'worker-test',
        enabled: true,
        num_threads: 8,
        num_ctx: 8192,
        provider: 'anthropic',
        apiKey: 'worker-key',
    },
}));

vi.mock('ai', () => ({
    streamText: mocks.streamText,
    stepCountIs: () => undefined,
    tool: (definition: unknown) => definition,
}));

vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => ({}) }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => ({}) }));
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: () => () => ({}) }));

vi.mock('../infra/llm-config.js', () => ({
    getTier2Config: () => ({ provider: 'anthropic', model: 'worker-test' }),
    getTier2ApiKey: () => 'worker-key',
    validateTier2Config: () => ({ valid: true }),
    resolveAnthropicAuth: () => ({ method: 'api_key', apiKey: 'worker-key' }),
    getLiveEngineConfig: () => ({
        url: 'http://127.0.0.1:11434',
        model: 'gemma3-test',
        enabled: true,
        provider: 'ollama',
    }),
    getWorkerEngineConfig: () => mocks.workerConfig,
}));

vi.mock('./system-prompt.js', () => ({
    getSystemPromptLiveGold: () => 'LIVE SYSTEM',
    getSystemPromptTier2: () => 'TIER2 SYSTEM',
}));

vi.mock('@redbusagent/shared', () => ({
    PersonaManager: { read: () => null },
    Vault: { read: () => ({}) },
}));

vi.mock('./memory-manager.js', () => ({ MemoryManager: { searchMemory: mocks.searchMemory } }));
vi.mock('./tool-registry.js', () => ({ ToolRegistry: { getAll: () => [], getFewShotExamplesBlock: () => '' } }));
vi.mock('./registry.js', () => ({
    CapabilityRegistry: {
        getAvailableTools: () => ({}),
        getCapabilityManifest: () => 'CAPABILITY MANIFEST',
    },
}));
vi.mock('./auto-rag.js', () => ({ AutoRAG: { enrich: mocks.enrich } }));
vi.mock('./transcript.js', () => ({ Transcript: { append: mocks.append } }));
vi.mock('./tool-loop-detection.js', () => ({
    detectToolCallLoop: () => ({ stuck: false }),
    hashToolCall: () => 'tool-hash',
    hashResult: () => 'result-hash',
}));
vi.mock('./tool-policy.js', () => ({ applyToolPolicy: (tools: unknown) => tools }));
vi.mock('./skills.js', () => ({ getRelevantSkillPrompt: async () => '' }));
vi.mock('./engine-message-bus.js', () => ({
    engineBus: { startTask: vi.fn(), emitOrchestrationEvent: vi.fn(), clearTask: vi.fn() },
}));

const { askLive } = await import('./cognitive-router.js');

function textStream(text: string) {
    return {
        fullStream: (async function* () {
            yield { type: 'text-delta', text };
        })(),
    };
}

describe('askLive collaborative delegation guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.workerConfig.enabled = true;
        mocks.workerConfig.model = 'worker-test';
    });

    it('delegates instead of returning a live-model refusal when collaborative handoff is available', async () => {
        const refusal = 'I cannot access Outlook or log into your email account for you.';
        mocks.streamText
            .mockReturnValueOnce(textStream(refusal))
            .mockReturnValueOnce(textStream('Worker completed the Outlook automation routine and generated the summary.'))
            .mockReturnValueOnce(textStream('Done: delegated to the Worker Engine and returned the automation result.'));

        let doneText = '';
        const chunks: string[] = [];
        const toolCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];

        await askLive(
            'create a routine that visits outlook.com, enters my credentials, checks my emails from the last 24 hours (only from colleagues with @numenit.com domain), provides intelligent insights and summary, runs once to show how it would work, and schedules it daily at noon UTC',
            {
                onChunk: (chunk) => chunks.push(chunk),
                onDone: (text) => {
                    doneText = text;
                },
                onError: (error) => {
                    throw error;
                },
                onToolCall: (toolName, args) => {
                    toolCalls.push({ toolName, args });
                },
            },
        );

        expect(mocks.streamText).toHaveBeenCalledTimes(3);
        const streamArgs = mocks.streamText.mock.calls[0][0];
        expect(streamArgs.system).toContain('delegate_to_worker_engine');
        expect(streamArgs.system).toContain('ALWAYS use delegate_to_worker_engine');
        expect(toolCalls).toContainEqual({
            toolName: 'delegate_to_worker_engine',
            args: {
                task_prompt: 'create a routine that visits outlook.com, enters my credentials, checks my emails from the last 24 hours (only from colleagues with @numenit.com domain), provides intelligent insights and summary, runs once to show how it would work, and schedules it daily at noon UTC',
            },
        });
        expect(doneText).toBe('Done: delegated to the Worker Engine and returned the automation result.');
        expect(chunks.join('')).not.toContain(refusal);
        expect(chunks.join('')).toContain('Delegating complex task to the Engineering Worker Engine');
    });

    it('surfaces an actionable blocker instead of calling the live model when worker support is unavailable', async () => {
        mocks.workerConfig.enabled = false;
        mocks.workerConfig.model = '';

        let doneText = '';

        await askLive(
            'create a routine that visits outlook.com, enters my credentials, checks my emails from the last 24 hours (only from colleagues with @numenit.com domain), provides intelligent insights and summary, runs once to show how it would work, and schedules it daily at noon UTC',
            {
                onChunk: () => undefined,
                onDone: (text) => {
                    doneText = text;
                },
                onError: (error) => {
                    throw error;
                },
            },
        );

        expect(mocks.streamText).not.toHaveBeenCalled();
        expect(doneText).toContain('Worker Engine is disabled');
        expect(doneText).toContain('worker_engine.model');
    });
});