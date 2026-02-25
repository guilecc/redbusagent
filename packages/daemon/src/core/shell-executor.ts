import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { Vault } from '@redbusagent/shared';
import { EventEmitter } from 'node:events';

const execAsync = promisify(exec);

// Singleton to manage shell approval state
class ShellApprovalManager extends EventEmitter {
    private pendingRequests = new Map<string, {
        resolve: (approved: boolean) => void;
        command: string;
    }>();

    requestApproval(id: string, command: string): Promise<boolean> {
        return new Promise((resolve) => {
            this.pendingRequests.set(id, { resolve, command });
            this.emit('approval_requested', { id, command });
        });
    }

    resolveApproval(id: string, approved: boolean): boolean {
        const req = this.pendingRequests.get(id);
        if (req) {
            req.resolve(approved);
            this.pendingRequests.delete(id);
            return true;
        }
        return false;
    }

    getPendingCommand(id: string): string | undefined {
        return this.pendingRequests.get(id)?.command;
    }

    hasPendingRequests(): boolean {
        return this.pendingRequests.size > 0;
    }

    // We can assume one pending request per client/global for simplicity since chat is sequential per client
    getFirstPendingId(): string | undefined {
        return this.pendingRequests.keys().next().value;
    }
}

export const shellApproval = new ShellApprovalManager();

export const executeShellCommandTool = tool({
    description: 'Execute arbitrary terminal commands on the host OS (Bash/Zsh on Mac/Linux, PowerShell on Windows). Use this for system administration, Git operations, Docker, SSH, or file manipulation.',
    inputSchema: z.object({
        command: z.string().describe('The strict command string to execute in the shell.'),
    }),
    execute: async (args: { command: string }) => {
        const command = args.command;
        const vaultConfig = Vault.read();
        const godMode = vaultConfig?.shell_god_mode === true;

        if (!godMode) {
            // Pause and wait for HITL approval
            // Generate a unique ID for this request
            const reqId = Math.random().toString(36).substring(7);

            // Wait for user to answer via ChatHandler
            console.log(`  ⚠️ [shell-executor] Execution paused. Requesting HITL approval for: ${command}`);
            const approved = await shellApproval.requestApproval(reqId, command);

            if (!approved) {
                return {
                    success: false,
                    stdout: '',
                    stderr: 'User denied permission to run this command. Find an alternative or explain why it is necessary.'
                };
            }
        } else {
            console.log(`  ⚡ [shell-executor] GOD MODE enabled. Executing directly: ${command}`);
        }

        try {
            const { stdout, stderr } = await execAsync(command);
            return {
                success: true,
                stdout: stdout || '',
                stderr: stderr || ''
            };
        } catch (error: any) {
            return {
                success: false,
                stdout: error.stdout || '',
                stderr: error.stderr || error.message || String(error)
            };
        }
    }
});
