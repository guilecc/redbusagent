/**
 * @redbusagent/daemon — RunPod Serverless Ollama Engine
 *
 * Wraps standard Ollama /api/chat payloads into RunPod's
 * Serverless Job envelope and sends them to the /runsync endpoint.
 *
 * Uses the hoblin/runpod-worker-ollama worker image which accepts:
 * {
 *   "input": {
 *     "method": "/api/chat",
 *     "data": { ...standard_ollama_payload... }
 *   }
 * }
 *
 * The worker dynamically pulls any requested Ollama model if not cached.
 */

import { Vault } from '@redbusagent/shared';

// ─── Types ────────────────────────────────────────────────────────

export interface RunPodOllamaOptions {
    /** RunPod API key (overrides vault) */
    apiKey?: string;
    /** RunPod endpoint ID (overrides vault) */
    endpointId?: string;
    /** Ollama model name (e.g., 'gemma3:27b') */
    model: string;
    /** Messages in Ollama format */
    messages: Array<{ role: string; content: string }>;
    /** Ollama-compatible tools (optional) */
    tools?: unknown[];
    /** System prompt (optional — injected as first message) */
    system?: string;
    /** Stream mode — RunPod /runsync doesn't support true streaming,
     *  so this controls whether we request stream:false from Ollama inside the worker */
    stream?: boolean;
    /** Additional Ollama options (num_ctx, temperature, etc.) */
    options?: Record<string, unknown>;
}

export interface RunPodOllamaResponse {
    /** The full text content from the model */
    content: string;
    /** The model that was used */
    model: string;
    /** Tool calls returned by the model (if any) */
    toolCalls?: Array<{
        function: {
            name: string;
            arguments: Record<string, unknown>;
        };
    }>;
    /** Raw RunPod response for debugging */
    raw?: unknown;
}

// ─── Constants ────────────────────────────────────────────────────

const RUNPOD_API_BASE = 'https://api.runpod.ai/v2';
const RUNSYNC_TIMEOUT_MS = 300_000; // 5 minutes max for /runsync

// ─── Public API ───────────────────────────────────────────────────

/**
 * Execute a chat completion via RunPod Serverless Ollama.
 *
 * Wraps the standard Ollama /api/chat payload in RunPod's input envelope
 * and sends it to the /runsync endpoint for synchronous execution.
 */
export async function executeRunpodOllama(opts: RunPodOllamaOptions): Promise<RunPodOllamaResponse> {
    const config = Vault.read();
    const apiKey = opts.apiKey ?? config?.runpod_api_key;
    const endpointId = opts.endpointId ?? getEndpointIdFromConfig(config);

    if (!apiKey) {
        throw new Error('RunPod API key not configured. Run: redbus config → Engines → RunPod');
    }
    if (!endpointId) {
        throw new Error('RunPod Endpoint ID not configured. Run: redbus config → Engines → RunPod');
    }

    // ── Build the standard Ollama /api/chat payload ──
    const ollamaPayload: Record<string, unknown> = {
        model: opts.model,
        messages: opts.messages,
        stream: false, // RunPod /runsync is synchronous; no streaming inside the worker
    };

    if (opts.system) {
        // Prepend system message
        ollamaPayload['messages'] = [
            { role: 'system', content: opts.system },
            ...opts.messages,
        ];
    }

    if (opts.tools && opts.tools.length > 0) {
        ollamaPayload['tools'] = opts.tools;
    }

    if (opts.options) {
        ollamaPayload['options'] = opts.options;
    }

    // ── Wrap in RunPod envelope ──
    const runpodPayload = {
        input: {
            method: '/api/chat',
            data: ollamaPayload,
        },
    };

    const url = `${RUNPOD_API_BASE}/${endpointId}/runsync`;

    console.log(`  🚀 [runpod] Sending to ${endpointId} — model: ${opts.model}`);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(runpodPayload),
        signal: AbortSignal.timeout(RUNSYNC_TIMEOUT_MS),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown error');
        throw new Error(`RunPod API error (${response.status}): ${errorText}`);
    }

    const result = await response.json() as RunPodSyncResponse;

    if (result.status === 'FAILED') {
        throw new Error(`RunPod job failed: ${JSON.stringify(result.error ?? result.output)}`);
    }

    if (result.status !== 'COMPLETED') {
        throw new Error(`RunPod job did not complete synchronously (status: ${result.status}). Consider using /run instead.`);
    }

    return parseRunPodOutput(result.output, opts.model);
}



// ─── Internal Types ───────────────────────────────────────────────

interface RunPodSyncResponse {
    id: string;
    status: 'COMPLETED' | 'FAILED' | 'IN_QUEUE' | 'IN_PROGRESS';
    output?: unknown;
    error?: unknown;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Extract endpoint ID from Vault config.
 * Checks both live_engine and worker_engine for runpod_endpoint_id.
 */
function getEndpointIdFromConfig(config: ReturnType<typeof Vault.read>): string | undefined {
    if (!config) return undefined;
    return config.live_engine?.runpod_endpoint_id
        ?? config.worker_engine?.runpod_endpoint_id;
}

/**
 * Parse the RunPod output envelope into our response format.
 * The worker returns the raw Ollama /api/chat response in `output`.
 */
function parseRunPodOutput(output: unknown, requestedModel: string): RunPodOllamaResponse {
    // The output from hoblin/runpod-worker-ollama is the raw Ollama response
    if (!output || typeof output !== 'object') {
        throw new Error(`Unexpected RunPod output format: ${JSON.stringify(output)}`);
    }

    const out = output as Record<string, unknown>;

    // Ollama /api/chat response shape:
    // { model, message: { role, content, tool_calls? }, done, ... }
    const message = out['message'] as Record<string, unknown> | undefined;
    const content = (message?.['content'] as string) ?? '';
    const model = (out['model'] as string) ?? requestedModel;

    // Parse tool calls if present
    let toolCalls: RunPodOllamaResponse['toolCalls'];
    const rawToolCalls = message?.['tool_calls'];
    if (rawToolCalls && Array.isArray(rawToolCalls)) {
        toolCalls = (rawToolCalls as Array<Record<string, unknown>>).map((tc) => {
            const fn = tc['function'] as Record<string, unknown> | undefined;
            return {
                function: {
                    name: (fn?.['name'] as string) ?? 'unknown',
                    arguments: (fn?.['arguments'] as Record<string, unknown>) ?? {},
                },
            };
        });
    }

    console.log(`  🚀 [runpod] Response: ${content.length} chars, ${toolCalls?.length ?? 0} tool calls`);

    return {
        content,
        model,
        toolCalls,
        raw: output,
    };
}