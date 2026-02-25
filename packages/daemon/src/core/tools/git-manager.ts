import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const getGitStatusTool = tool({
    description: 'Returns the current git branch, uncommitted files, and working tree status. Use this to orient yourself within the repository.',
    inputSchema: z.object({}),
    execute: async () => {
        console.log(`  🐙 Git Status`);
        try {
            const { stdout, stderr } = await execAsync('git status');
            if (stderr && !stderr.includes('On branch')) {
                console.warn("Git status stderr: ", stderr);
            }
            return {
                success: true,
                output: stdout.trim()
            };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }
});

export const getGitDiffTool = tool({
    description: 'Returns the exact diff of uncommitted changes in the repository. ALWAYS use this to review your own work after modifying files via surgical editing or scripting.',
    inputSchema: z.object({}),
    execute: async () => {
        console.log(`  🐙 Git Diff`);
        try {
            const { stdout, stderr } = await execAsync('git diff');
            if (stderr) {
                console.warn("Git diff stderr: ", stderr);
            }
            return {
                success: true,
                output: stdout.trim() || 'No uncommitted changes.'
            };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }
});

export const gitCommitChangesTool = tool({
    description: 'Commits all current changes in the repository with a descriptive message. Only use this when you need to save a milestone or the user explicitly asks you to save/finalize your work.',
    inputSchema: z.object({
        commit_message: z.string().describe('A descriptive message summarizing the changes.')
    }),
    execute: async ({ commit_message }) => {
        console.log(`  🐙 Git Commit: "${commit_message}"`);
        try {
            // Add all changes first
            await execAsync('git add .');

            // Execute commit
            // Note: we escape quotes in the commit message to prevent shell injection/errors
            const escapedMessage = commit_message.replace(/"/g, '\\"');
            const { stdout, stderr } = await execAsync(`git commit -m "${escapedMessage}"`);

            return {
                success: true,
                output: stdout.trim(),
                warnings: stderr ? stderr.trim() : undefined
            };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }
});
