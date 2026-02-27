/**
 * @redbusagent/daemon — RunPod Serverless Engine (OpenAI-compatible)
 *
 * RunPod Serverless endpoints (especially those using vLLM from the Hub)
 * expose a standard OpenAI-compatible API at:
 *
 *   https://api.runpod.ai/v2/{endpoint-id}/openai/v1
 *
 * This means RunPod can be treated as a standard OpenAI provider using
 * the Vercel AI SDK's `createOpenAI` with a custom baseURL.
 *
 * No custom /runsync wrapper, no Ollama envelope — just standard
 * chat completions via the OpenAI protocol.
 *
 * Configuration is handled in cognitive-router.ts via createCloudModel('runpod', ...).
 * This file is kept as a reference and utility module.
 */

/**
 * Build the standard RunPod OpenAI-compatible base URL for a given endpoint.
 */
export function getRunpodBaseURL(endpointId: string): string {
    return `https://api.runpod.ai/v2/${endpointId}/openai/v1`;
}