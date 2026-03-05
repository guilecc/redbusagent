import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineBus } from '../engine-message-bus.js';
import { askUserForInputTool, userInputManager } from './ask-user.js';

const executeTool = (askUserForInputTool as any).execute as (args: {
    question: string;
}) => Promise<{ success: boolean; user_response?: string; error?: string }>;

describe('askUserForInputTool', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        engineBus.reset();
    });

    afterEach(() => {
        const pendingId = userInputManager.getFirstPendingId();
        if (pendingId) userInputManager.resolveInput(pendingId, 'cleanup');
        engineBus.reset();
        vi.useRealTimers();
    });

    it('resumes the original session when the user replies after another session becomes active', async () => {
        engineBus.startTask('task-ask-user', 'Ask for the deployment key');

        const execution = executeTool({ question: 'What deployment key should I use?' });
        const pendingId = userInputManager.getFirstPendingId();

        expect(pendingId).toBeTruthy();
        expect(userInputManager.getPendingQuestion(pendingId!)).toBe('What deployment key should I use?');
        expect(engineBus.getSession('task-ask-user')).toMatchObject({
            state: 'paused',
            pauseKind: 'awaiting_user_reply',
            pauseReason: 'What deployment key should I use?',
            activeActor: 'worker',
        });

        vi.advanceTimersByTime(1);
        engineBus.startTask('task-competing', 'Handle a different request');
        expect(engineBus.getLatestActiveSession()?.taskId).toBe('task-competing');

        expect(userInputManager.resolveInput(pendingId!, 'deploy-key-123')).toBe(true);
        await expect(execution).resolves.toEqual({
            success: true,
            user_response: 'deploy-key-123',
        });

        const resumedSession = engineBus.getSession('task-ask-user');
        expect(resumedSession).toMatchObject({
            state: 'running',
            activeActor: 'worker',
            pauseKind: undefined,
            pauseReason: 'User reply received. Resume the current execution context.',
        });
        expect(resumedSession?.history.map(event => event.type)).toEqual([
            'task_created',
            'yield_requested',
            'user_reply_received',
            'resumed',
        ]);
        expect(resumedSession?.history[2]).toMatchObject({
            type: 'user_reply_received',
            sessionId: 'task-ask-user',
            taskId: 'task-ask-user',
            mode: 'collaborative',
            actor: 'user',
            replyPreview: 'deploy-key-123',
        });
        expect(resumedSession?.history[3]).toMatchObject({
            type: 'resumed',
            sessionId: 'task-ask-user',
            taskId: 'task-ask-user',
            mode: 'collaborative',
            actor: 'worker',
        });
        expect(engineBus.getSession('task-competing')?.lastEventType).toBe('task_created');
        expect(userInputManager.hasPendingQuestions()).toBe(false);
    });

    it('times out and resumes the original session without leaking to a newer active session', async () => {
        engineBus.startTask('task-ask-timeout', 'Wait for a user confirmation');

        const execution = executeTool({ question: 'Should I continue with the rollout?' });
        const pendingId = userInputManager.getFirstPendingId();

        expect(pendingId).toBeTruthy();
        expect(engineBus.getSession('task-ask-timeout')).toMatchObject({
            state: 'paused',
            pauseKind: 'awaiting_user_reply',
            pauseReason: 'Should I continue with the rollout?',
        });

        vi.advanceTimersByTime(1);
        engineBus.startTask('task-competing-timeout', 'Do other work while waiting');
        expect(engineBus.getLatestActiveSession()?.taskId).toBe('task-competing-timeout');

        await vi.advanceTimersByTimeAsync(300_001);

        await expect(execution).resolves.toMatchObject({
            success: false,
            error: expect.stringContaining('User did not respond within 300s'),
        });

        const timedOutSession = engineBus.getSession('task-ask-timeout');
        expect(timedOutSession).toMatchObject({
            state: 'running',
            activeActor: 'worker',
            pauseKind: undefined,
            pauseReason: 'User input request expired before a reply arrived.',
        });
        expect(timedOutSession?.history.map(event => event.type)).toEqual([
            'task_created',
            'yield_requested',
            'resumed',
        ]);
        expect(timedOutSession?.history[2]).toMatchObject({
            type: 'resumed',
            sessionId: 'task-ask-timeout',
            taskId: 'task-ask-timeout',
            mode: 'collaborative',
            actor: 'worker',
            reason: 'User input request expired before a reply arrived.',
        });
        expect(engineBus.getSession('task-competing-timeout')?.lastEventType).toBe('task_created');
        expect(userInputManager.hasPendingQuestions()).toBe(false);
    });
});