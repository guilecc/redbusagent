import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    exec: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: vi.fn() }),
    execAsync: vi.fn(),
    readVault: vi.fn(() => ({})),
    getToolExecutionContext: vi.fn(),
    getRestrictedWorkerShellAutoApproval: vi.fn(),
    requestApproval: vi.fn(),
}));

mocks.exec[Symbol.for('nodejs.util.promisify.custom')] = mocks.execAsync;

vi.mock('ai', () => ({ tool: (definition: unknown) => definition }));
vi.mock('node:child_process', () => ({ exec: mocks.exec }));
vi.mock('@redbusagent/shared', () => ({ Vault: { read: mocks.readVault } }));
vi.mock('./approval-gate.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./approval-gate.js')>();
    return {
        ...actual,
        approvalGate: {
            ...actual.approvalGate,
            requestApproval: mocks.requestApproval,
        },
        getToolExecutionContext: mocks.getToolExecutionContext,
        getRestrictedWorkerShellAutoApproval: mocks.getRestrictedWorkerShellAutoApproval,
    };
});

const { executeShellCommandTool } = await import('./shell-executor.js');

const executeTool = (executeShellCommandTool as any).execute as (args: { command: string }, context?: { toolCallId?: string }) => Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
}>;

describe('executeShellCommandTool approval gating', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readVault.mockReturnValue({});
        mocks.execAsync.mockResolvedValue({ stdout: 'ok', stderr: '' });
        mocks.getToolExecutionContext.mockReturnValue({
            toolCallId: 'tool-1',
            toolName: 'execute_shell_command',
            args: {},
            actor: 'worker',
            mode: 'collaborative',
            sessionId: 'worker-safe-task',
            taskId: 'worker-safe-task',
        });
    });

    it('skips HITL for request-bound restricted worker vault commands', async () => {
        mocks.getRestrictedWorkerShellAutoApproval.mockReturnValue({
            approved: true,
            rationale: 'worker-vault-write',
        });

        const result = await executeTool({
            command: 'cd "$REDBUSAGENT_DAEMON_ROOT" && node -e "Vault.storeCredential(\"outlook.com\", \"user\", \"secret\")"',
        }, { toolCallId: 'tool-1' });

        expect(mocks.requestApproval).not.toHaveBeenCalled();
        expect(mocks.execAsync).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ success: true, stdout: 'ok', stderr: '' });
    });

    it('preserves HITL for arbitrary shell commands outside the safe subset', async () => {
        mocks.getRestrictedWorkerShellAutoApproval.mockReturnValue({ approved: false });
        mocks.requestApproval.mockResolvedValue(false);

        const result = await executeTool({ command: 'rm -rf /tmp/not-safe' }, { toolCallId: 'tool-1' });

        expect(mocks.requestApproval).toHaveBeenCalledTimes(1);
        expect(mocks.execAsync).not.toHaveBeenCalled();
        expect(result.success).toBe(false);
        expect(result.stderr).toContain('User denied permission');
    });

    it('still requests approval when there is no active worker tool execution context', async () => {
        mocks.getToolExecutionContext.mockReturnValue(null);
        mocks.getRestrictedWorkerShellAutoApproval.mockReturnValue({ approved: false });
        mocks.requestApproval.mockResolvedValue(true);

        const result = await executeTool({ command: 'node "$REDBUSAGENT_FORGE_DIR/run.js"' });

        expect(mocks.requestApproval).toHaveBeenCalledTimes(1);
        expect(mocks.execAsync).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ success: true, stdout: 'ok', stderr: '' });
    });
});