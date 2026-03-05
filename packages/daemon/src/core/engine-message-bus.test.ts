import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineMessageBus } from './engine-message-bus.js';

describe('EngineMessageBus', () => {
    let bus: EngineMessageBus;

    beforeEach(() => {
        bus = new EngineMessageBus();
    });

    it('tracks collaborative lifecycle state and preserves legacy worker aliases', () => {
        const workerStarted = vi.fn();
        const workerDone = vi.fn();
        bus.on('worker:start', workerStarted);
        bus.on('worker:done', workerDone);

        bus.startTask('task-1', 'Build the integration');
        bus.emitOrchestrationEvent({
            type: 'delegated',
            sessionId: 'task-1',
            taskId: 'task-1',
            mode: 'collaborative',
            actor: 'live',
            from: 'live',
            to: 'worker',
            summary: 'Delegated to worker',
            timestamp: 2,
        });
        bus.emitOrchestrationEvent({
            type: 'tool_called',
            sessionId: 'task-1',
            taskId: 'task-1',
            mode: 'collaborative',
            actor: 'worker',
            toolName: 'forge_and_test_skill',
            args: { target: 'router' },
            timestamp: 3,
        });
        bus.emitOrchestrationEvent({
            type: 'tool_result',
            sessionId: 'task-1',
            taskId: 'task-1',
            mode: 'collaborative',
            actor: 'worker',
            toolName: 'forge_and_test_skill',
            success: false,
            durationMs: 25,
            resultPreview: 'Type mismatch',
            timestamp: 4,
        });
        bus.emitOrchestrationEvent({
            type: 'critic_feedback',
            sessionId: 'task-1',
            taskId: 'task-1',
            mode: 'collaborative',
            actor: 'cloud',
            critic: 'cloud',
            target: 'worker',
            verdict: 'revise',
            feedback: 'Fix the type mismatch and retry',
            timestamp: 5,
        });
        bus.emitOrchestrationEvent({
            type: 'completed',
            sessionId: 'task-1',
            taskId: 'task-1',
            mode: 'collaborative',
            actor: 'worker',
            summary: 'Completed after repair',
            totalChars: 200,
            totalToolCalls: 1,
            totalDurationMs: 100,
            timestamp: 6,
        });

        const session = bus.getSession('task-1');
        expect(workerStarted).toHaveBeenCalledTimes(1);
        expect(workerDone).toHaveBeenCalledTimes(1);
        expect(session).toMatchObject({
            state: 'completed',
            mode: 'collaborative',
            delegationCount: 1,
            toolCallCount: 1,
            critiqueCount: 1,
            lastEventType: 'completed',
        });
        expect(session?.history.map(event => event.type)).toEqual([
            'task_created',
            'delegated',
            'tool_called',
            'tool_result',
            'critic_feedback',
            'completed',
        ]);
        expect(bus.isWorkerActive()).toBe(false);
    });

    it('tracks explicit repair attempts and terminal failure resolution', () => {
        bus.startTask('task-repair', 'Repair a broken forged skill');
        bus.emitOrchestrationEvent({
            type: 'critic_feedback',
            sessionId: 'task-repair',
            taskId: 'task-repair',
            mode: 'collaborative',
            actor: 'cloud',
            critic: 'cloud',
            target: 'worker',
            verdict: 'revise',
            feedback: 'Sandbox test failed. Repair and retry.',
            timestamp: 2,
        });
        bus.emitOrchestrationEvent({
            type: 'repair_requested',
            sessionId: 'task-repair',
            taskId: 'task-repair',
            mode: 'collaborative',
            actor: 'cloud',
            critic: 'cloud',
            target: 'worker',
            attempt: 1,
            reason: 'Retry after sandbox failure',
            toolName: 'forge_and_test_skill',
            timestamp: 3,
        });
        bus.emitOrchestrationEvent({
            type: 'failed',
            sessionId: 'task-repair',
            taskId: 'task-repair',
            mode: 'collaborative',
            actor: 'worker',
            error: 'Exceeded bounded repair attempts',
            failureKind: 'bounded_failure',
            timestamp: 4,
        });

        expect(bus.getSession('task-repair')).toMatchObject({
            critiqueCount: 1,
            repairCount: 1,
            lastCritiqueVerdict: 'revise',
            resolution: 'bounded_failure',
            state: 'failed',
        });
    });

    it('supports yield and resume transitions for paused sessions', () => {
        bus.startTask('task-2', 'Wait for approval');
        bus.emitOrchestrationEvent({
            type: 'yield_requested',
            sessionId: 'task-2',
            taskId: 'task-2',
            mode: 'collaborative',
            actor: 'worker',
            waitFor: 'awaiting_user_reply',
            reason: 'Need approval before deployment',
            timestamp: 2,
        });

        expect(bus.getSession('task-2')?.state).toBe('paused');
        expect(bus.getSessionCounts().paused).toBe(1);

        bus.emitOrchestrationEvent({
            type: 'user_reply_received',
            sessionId: 'task-2',
            taskId: 'task-2',
            mode: 'collaborative',
            actor: 'user',
            replyPreview: 'Approved by owner',
            timestamp: 3,
        });
        bus.emitOrchestrationEvent({
            type: 'resumed',
            sessionId: 'task-2',
            taskId: 'task-2',
            mode: 'collaborative',
            actor: 'worker',
            reason: 'Owner approval received',
            timestamp: 4,
        });

        const session = bus.getSession('task-2');
        expect(session?.state).toBe('running');
        expect(session?.pauseKind).toBeUndefined();
        expect(session?.pauseReason).toBe('Owner approval received');
        expect(session?.lastEventType).toBe('resumed');
        expect(bus.getSessionCounts().running).toBe(1);
        expect(bus.getSessionCounts().paused).toBe(0);
    });
});