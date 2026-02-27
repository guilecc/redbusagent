/**
 * @redbusagent/daemon — RunPod OpenAI-Compatible Engine Tests
 *
 * Tests the getRunpodBaseURL helper that generates the standard
 * RunPod OpenAI-compatible endpoint URL.
 */

import { describe, it, expect } from 'vitest';
import { getRunpodBaseURL } from './runpod-ollama.js';

describe('getRunpodBaseURL', () => {
    it('returns correct OpenAI-compatible URL for a given endpoint ID', () => {
        expect(getRunpodBaseURL('ep-abc123')).toBe('https://api.runpod.ai/v2/ep-abc123/openai/v1');
    });

    it('works with public hub model IDs', () => {
        expect(getRunpodBaseURL('qwen3-32b-awq')).toBe('https://api.runpod.ai/v2/qwen3-32b-awq/openai/v1');
    });

    it('handles endpoint IDs with special characters', () => {
        expect(getRunpodBaseURL('my-endpoint-v2')).toBe('https://api.runpod.ai/v2/my-endpoint-v2/openai/v1');
    });
});

