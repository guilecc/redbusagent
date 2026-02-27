/**
 * @redbusagent/daemon — RunPod Serverless Ollama Engine Tests
 *
 * Tests the RunPod envelope wrapping, response parsing, tool call extraction,
 * and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Vault
vi.mock('@redbusagent/shared', () => ({
    Vault: {
        read: vi.fn(() => ({
            runpod_api_key: 'test-api-key',
            live_engine: { runpod_endpoint_id: 'test-endpoint' },
        })),
    },
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { executeRunpodOllama, type RunPodOllamaOptions } from './runpod-ollama.js';

// ─── Helpers ──────────────────────────────────────────────────────

function mockRunPodSuccess(output: unknown) {
    mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'job-123', status: 'COMPLETED', output }),
    });
}

function mockRunPodFailed(error: string) {
    mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'job-123', status: 'FAILED', error }),
    });
}

// ─── Tests ────────────────────────────────────────────────────────

describe('executeRunpodOllama', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('sends correct RunPod envelope with Ollama payload', async () => {
        mockRunPodSuccess({
            model: 'gemma3:27b',
            message: { role: 'assistant', content: 'Hello!' },
            done: true,
        });

        await executeRunpodOllama({
            model: 'gemma3:27b',
            messages: [{ role: 'user', content: 'Hi' }],
            apiKey: 'key-123',
            endpointId: 'ep-456',
        });

        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, opts] = mockFetch.mock.calls[0]!;
        expect(url).toBe('https://api.runpod.ai/v2/ep-456/runsync');
        expect(opts.headers['Authorization']).toBe('Bearer key-123');

        const body = JSON.parse(opts.body);
        expect(body.input.method).toBe('/api/chat');
        expect(body.input.data.model).toBe('gemma3:27b');
        expect(body.input.data.stream).toBe(false);
        expect(body.input.data.messages).toEqual([{ role: 'user', content: 'Hi' }]);
    });

    it('prepends system message when system prompt is provided', async () => {
        mockRunPodSuccess({
            model: 'gemma3:27b',
            message: { role: 'assistant', content: 'OK' },
        });

        await executeRunpodOllama({
            model: 'gemma3:27b',
            messages: [{ role: 'user', content: 'test' }],
            system: 'You are helpful.',
            apiKey: 'k', endpointId: 'e',
        });

        const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
        expect(body.input.data.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
        expect(body.input.data.messages[1]).toEqual({ role: 'user', content: 'test' });
    });

    it('parses content from Ollama response', async () => {
        mockRunPodSuccess({
            model: 'gemma3:27b',
            message: { role: 'assistant', content: 'The answer is 42.' },
        });

        const result = await executeRunpodOllama({
            model: 'gemma3:27b',
            messages: [{ role: 'user', content: 'question' }],
            apiKey: 'k', endpointId: 'e',
        });

        expect(result.content).toBe('The answer is 42.');
        expect(result.model).toBe('gemma3:27b');
    });

    it('parses tool calls from response', async () => {
        mockRunPodSuccess({
            model: 'gemma3:27b',
            message: {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    function: { name: 'read_file', arguments: { path: '/foo.txt' } },
                }],
            },
        });

        const result = await executeRunpodOllama({
            model: 'gemma3:27b',
            messages: [{ role: 'user', content: 'read foo' }],
            apiKey: 'k', endpointId: 'e',
        });

        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls![0]!.function.name).toBe('read_file');
        expect(result.toolCalls![0]!.function.arguments).toEqual({ path: '/foo.txt' });
    });

    it('throws on FAILED status', async () => {
        mockRunPodFailed('GPU OOM');

        await expect(executeRunpodOllama({
            model: 'gemma3:27b',
            messages: [{ role: 'user', content: 'test' }],
            apiKey: 'k', endpointId: 'e',
        })).rejects.toThrow('RunPod job failed');
    });

    it('throws on HTTP error', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
            text: async () => 'Unauthorized',
        });

        await expect(executeRunpodOllama({
            model: 'gemma3:27b',
            messages: [{ role: 'user', content: 'test' }],
            apiKey: 'k', endpointId: 'e',
        })).rejects.toThrow('RunPod API error (401)');
    });
});

