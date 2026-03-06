import { describe, expect, it } from 'vitest';
import { buildDelegatedWorkerOutcome, generateGemma3ToolPrompt, resolveLiveExecutionPlan, selectExecutionMode } from './cognitive-router.js';

describe('buildDelegatedWorkerOutcome', () => {
    it('marks delegated execution as bounded failure when a tool fails without repair', () => {
        const outcome = buildDelegatedWorkerOutcome({
            durationSec: 17,
            workerToolCalls: 1,
            workerCharsGenerated: 0,
            failedToolName: 'create_and_run_tool',
            failedToolResult: 'Forge execution failed for outlook-summary.js.\nstderr:\nTypeError [ERR_INVALID_ARG_TYPE]',
            unresolvedCritiqueVerdict: 'revise',
        });

        expect(outcome.status).toBe('bounded_failure');
        expect(outcome.message).toContain('BOUNDED FAILURE');
        expect(outcome.message).toContain('create_and_run_tool');
        expect(outcome.message).toContain('ERR_INVALID_ARG_TYPE');
        expect(outcome.message).toContain('The user has not seen a final answer yet');
    });

    it('marks delegated execution as blocked when critique concludes a blocker remains', () => {
        const outcome = buildDelegatedWorkerOutcome({
            durationSec: 23,
            workerToolCalls: 2,
            workerCharsGenerated: 120,
            failedToolName: 'ask_user_for_input',
            failedToolResult: '{"success":false,"error":"User did not respond within 300s."}',
            unresolvedCritiqueVerdict: 'blocked',
            workerFinalText: 'Waiting on the owner reply before I can continue.',
        });

        expect(outcome.status).toBe('blocked');
        expect(outcome.message).toContain('BLOCKED');
        expect(outcome.message).toContain('Waiting on the owner reply');
    });

    it('returns success when the worker finishes and final output is still withheld from the user', () => {
        const outcome = buildDelegatedWorkerOutcome({
            durationSec: 9,
            workerToolCalls: 3,
            workerCharsGenerated: 800,
            repairAttempts: 1,
            workerFinalText: 'The repaired skill was deployed successfully and the integration now passes.',
        });

        expect(outcome.status).toBe('success');
        expect(outcome.message).toContain('completed successfully after 1 repair attempt in 9s');
        expect(outcome.message).toContain('The user has not seen the worker\'s final answer yet');
        expect(outcome.message).toContain('The repaired skill was deployed successfully');
    });
});

describe('selectExecutionMode', () => {
    it('selects local-only for lightweight prompts', () => {
        expect(selectExecutionMode('What time is it in Tokyo?', { workerEnabled: true })).toBe('local-only');
    });

    it('selects cloud-only for complex analysis that does not require delegation', () => {
        expect(selectExecutionMode(
            'Analyze the protocol, compare the infrastructure logs, investigate the approval failure, and explain the architecture in detail.',
            { workerEnabled: true },
        )).toBe('cloud-only');
    });

    it('selects collaborative for forge-style prompts', () => {
        expect(selectExecutionMode('Build a tool that automates this integration and writes the routine for me.', {
            workerEnabled: true,
        })).toBe('collaborative');
    });
});

describe('resolveLiveExecutionPlan', () => {
    it('keeps lightweight prompts on the live lane without delegation', () => {
        expect(resolveLiveExecutionPlan('What time is it in Tokyo?', {
            workerEnabled: true,
        })).toEqual({
            mode: 'local-only',
            routeTier: 'live',
            enableDelegation: false,
        });
    });

    it('routes complex analytical prompts to the cloud lane', () => {
        expect(resolveLiveExecutionPlan(
            'Analyze the protocol, compare the infrastructure logs, investigate the approval failure, and explain the architecture in detail.',
            { workerEnabled: true },
        )).toEqual({
            mode: 'cloud-only',
            routeTier: 'cloud',
            enableDelegation: false,
        });
    });

    it('enables delegation for collaborative forge prompts', () => {
        expect(resolveLiveExecutionPlan('Build a tool that automates this integration and writes the routine for me.', {
            workerEnabled: true,
        })).toEqual({
            mode: 'collaborative',
            routeTier: 'live',
            enableDelegation: true,
        });
    });

    it('respects an explicit local-only override', () => {
        expect(resolveLiveExecutionPlan(
            'Analyze the protocol, compare the infrastructure logs, and explain the architecture in detail.',
            {
                workerEnabled: true,
                forceExecutionMode: 'local-only',
            },
        )).toEqual({
            mode: 'local-only',
            routeTier: 'live',
            enableDelegation: false,
        });
    });
});

describe('generateGemma3ToolPrompt', () => {
    it('does not instruct delegation when the worker handoff tool is unavailable', () => {
        const prompt = generateGemma3ToolPrompt({
            create_and_run_tool: {
                description: 'Forge and run a script.',
                parameters: { type: 'object', properties: {} },
            },
        });

        expect(prompt).not.toContain('delegate_to_worker_engine');
        expect(prompt).toContain('use the best matching tool from the manifest above');
    });

    it('keeps delegation instructions when the worker handoff tool is available', () => {
        const prompt = generateGemma3ToolPrompt({
            delegate_to_worker_engine: {
                description: 'Delegate work to the worker engine.',
                parameters: { type: 'object', properties: {} },
            },
        });

        expect(prompt).toContain('delegate_to_worker_engine');
        expect(prompt).toContain('ALWAYS use delegate_to_worker_engine');
    });
});