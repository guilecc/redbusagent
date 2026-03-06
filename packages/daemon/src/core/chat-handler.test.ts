import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    askLive: vi.fn(),
    askTier2: vi.fn(),
    vaultRead: vi.fn(),
    approvalGate: {
        on: vi.fn(),
        hasPendingRequests: vi.fn(() => false),
        getFirstPending: vi.fn(() => undefined),
        getFirstPendingId: vi.fn(() => undefined),
        resolveApproval: vi.fn(),
    },
    userInputManager: {
        on: vi.fn(),
        hasPendingQuestions: vi.fn(() => false),
        getFirstPendingId: vi.fn(() => undefined),
        resolveInput: vi.fn(),
    },
    processMonitorEmitter: {
        on: vi.fn(),
    },
}));

vi.mock('@redbusagent/shared', () => ({
    PersonaManager: { write: vi.fn() },
    Vault: { read: mocks.vaultRead },
}));

vi.mock('./cognitive-router.js', () => ({
    askLive: mocks.askLive,
    askTier2: mocks.askTier2,
}));

vi.mock('../infra/llm-config.js', () => ({
    getLiveEngineConfig: () => ({ provider: 'ollama', model: 'live-test' }),
}));

vi.mock('./tool-policy.js', () => ({
    resolveSenderRole: () => 'owner',
}));

vi.mock('./approval-gate.js', () => ({
    approvalGate: mocks.approvalGate,
}));

vi.mock('./task-queue.js', () => ({
    CommandLane: { Main: 'main' },
    enqueueCommandInLane: async (_lane: string, task: () => Promise<void>) => task(),
}));

vi.mock('./tools/process-manager.js', () => ({
    processMonitorEmitter: mocks.processMonitorEmitter,
}));

vi.mock('./tools/ask-user.js', () => ({
    userInputManager: mocks.userInputManager,
}));

vi.mock('./engine-message-bus.js', () => ({
    engineBus: { isWorkerActive: () => false },
}));

vi.mock('./thinking-filter.js', () => ({
    createThinkingFilter: () => ({ push: vi.fn(), flush: vi.fn() }),
}));

const { ChatHandler } = await import('./chat-handler.js');

function createRequest(content: string) {
    return {
        type: 'chat:request' as const,
        timestamp: new Date().toISOString(),
        payload: {
            requestId: 'req-1',
            content,
        },
    };
}

function createWsServer() {
    return {
        broadcast: vi.fn(),
    } as any;
}

describe('ChatHandler explicit /worker routing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.vaultRead.mockReturnValue({ worker_engine: { enabled: true } });
        mocks.askLive.mockResolvedValue({ tier: 'live', model: 'live-test' });
        mocks.askTier2.mockResolvedValue({ tier: 'cloud', model: 'cloud-test' });
    });

    it('routes /worker prompts through askLive with collaborative delegation enabled', async () => {
        const wsServer = createWsServer();
        const handler = new ChatHandler(wsServer);

        await handler.handleChatRequest('client-1', createRequest('/worker Build the automation'));

        expect(mocks.askLive).toHaveBeenCalledWith(
            'Build the automation',
            expect.any(Object),
            undefined,
            'owner',
            { forceExecutionMode: 'collaborative' },
        );
        expect(mocks.askTier2).not.toHaveBeenCalled();
    });

    it('rejects /worker without a prompt with a clear usage error', async () => {
        const wsServer = createWsServer();
        const handler = new ChatHandler(wsServer);

        await handler.handleChatRequest('client-1', createRequest('/worker'));

        expect(mocks.askLive).not.toHaveBeenCalled();
        expect(wsServer.broadcast).toHaveBeenNthCalledWith(1, expect.objectContaining({
            type: 'chat:error',
            payload: expect.objectContaining({
                requestId: 'req-1',
                error: expect.stringContaining('Usage: /worker <your prompt>'),
            }),
        }));
    });

    it('rejects the explicit worker path when the Worker Engine is disabled', async () => {
        const wsServer = createWsServer();
        const handler = new ChatHandler(wsServer);
        mocks.vaultRead.mockReturnValue({ worker_engine: { enabled: false } });

        await handler.handleChatRequest('client-1', createRequest('/deep Build the automation'));

        expect(mocks.askLive).not.toHaveBeenCalled();
        expect(wsServer.broadcast).toHaveBeenNthCalledWith(1, expect.objectContaining({
            type: 'chat:error',
            payload: expect.objectContaining({
                requestId: 'req-1',
                error: expect.stringContaining('Worker Engine is disabled'),
            }),
        }));
    });
});