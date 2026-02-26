import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { Vault } from '@redbusagent/shared';
import { approvalGate } from './approval-gate.js';

const execAsync = promisify(exec);

/**
 * @deprecated Use approvalGate from './approval-gate.js' instead.
 * Re-exported for backward compatibility during transition.
 */
export const shellApproval = approvalGate;

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
            const reqId = Math.random().toString(36).substring(7);
            console.log(`  ⚠️ [shell-executor] Execution paused. Requesting HITL approval for: ${command}`);

            const approved = await approvalGate.requestApproval({
                id: reqId,
                toolName: 'execute_shell_command',
                description: command,
                reason: 'destructive',
                args: { command },
            });

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
