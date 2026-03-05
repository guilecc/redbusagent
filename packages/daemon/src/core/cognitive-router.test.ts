import { describe, expect, it } from 'vitest';
import { buildDelegatedWorkerOutcome } from './cognitive-router.js';

describe('buildDelegatedWorkerOutcome', () => {
    it('marks delegated execution as failure when a tool fails without follow-up output', () => {
        const outcome = buildDelegatedWorkerOutcome({
            durationSec: 17,
            workerToolCalls: 1,
            workerCharsGenerated: 0,
            failedToolName: 'create_and_run_tool',
            failedToolResult: 'Forge execution failed for outlook-summary.js.\nstderr:\nTypeError [ERR_INVALID_ARG_TYPE]',
            workerProducedTextAfterFailure: false,
        });

        expect(outcome.status).toBe('failure');
        expect(outcome.message).toContain('FAILED while running tool "create_and_run_tool"');
        expect(outcome.message).toContain('ERR_INVALID_ARG_TYPE');
        expect(outcome.message).toContain('Do NOT say the task was successful');
        expect(outcome.message).toContain('offer next steps or a retry');
    });

    it('returns caution when the worker already streamed text after a failed tool', () => {
        const outcome = buildDelegatedWorkerOutcome({
            durationSec: 23,
            workerToolCalls: 2,
            workerCharsGenerated: 120,
            failedToolName: 'create_and_run_tool',
            failedToolResult: 'Forge execution failed for outlook-summary.js.',
            workerProducedTextAfterFailure: true,
        });

        expect(outcome.status).toBe('caution');
        expect(outcome.message).toContain('Do NOT blindly confirm success');
        expect(outcome.message).toContain('create_and_run_tool');
        expect(outcome.message).toContain('Latest failure detail: Forge execution failed for outlook-summary.js.');
    });

    it('returns success when no worker failure was recorded', () => {
        const outcome = buildDelegatedWorkerOutcome({
            durationSec: 9,
            workerToolCalls: 3,
            workerCharsGenerated: 800,
        });

        expect(outcome.status).toBe('success');
        expect(outcome.message).toContain('executed the task successfully in 9s');
    });
});