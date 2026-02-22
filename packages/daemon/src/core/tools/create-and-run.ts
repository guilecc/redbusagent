/**
 * @redbusagent/daemon — create_and_run_tool
 *
 * The primary native tool for the Forge.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { Forge } from '../forge.js';
import { ToolRegistry } from '../tool-registry.js';

export const createAndRunTool = tool({
    description: `Creates a Node.js script in the Forge workspace, installs any required npm dependencies, executes the script, and returns the output. Use this to generate code, run computations, create files, fetch data, or any task that requires code execution. The code MUST be valid Node.js (CommonJS). Use require() for imports. The script's stdout will be returned as the result.`,

    inputSchema: z.object({
        filename: z.string().describe('Name of the script file to create (e.g. "generate-ticket.js"). Must end in .js'),
        description: z.string().describe('Brief description of what this tool does'),
        code: z.string().describe('The complete Node.js code (CommonJS) to write and execute. Use console.log() for output.'),
        dependencies: z.array(z.string()).default([]).describe('npm packages to install before execution'),
    }),

    execute: async (params: {
        filename: string;
        description: string;
        code: string;
        dependencies: string[];
    }) => {
        const { filename, description, code, dependencies } = params;
        const startTime = Date.now();

        try {
            Forge.ensureWorkspace();

            if (dependencies.length > 0) {
                console.log(`  📦 Forge: Installing ${dependencies.length} dependencies: ${dependencies.join(', ')}`);
                const installResult = await Forge.installDependencies(dependencies);
                if (!installResult.success) {
                    return { success: false, phase: 'dependency_install', error: `Failed: ${installResult.error}` };
                }
                console.log('  📦 Forge: Dependencies installed');
            }

            const filepath = Forge.writeScript(filename, code);
            console.log(`  📝 Forge: Script written to ${filepath}`);
            console.log(`  ▶️  Forge: Executing ${filename}...`);

            const result = await Forge.executeScript(filename);

            if (result.success) {
                const toolName = filename.replace(/\.js$/, '').replace(/[^a-zA-Z0-9]/g, '_');
                ToolRegistry.register({ name: toolName, description, filename, createdAt: new Date().toISOString() });
                console.log(`  ✅ Forge: ${filename} executed in ${result.durationMs}ms`);
                return { success: true, output: result.stdout, durationMs: result.durationMs, registeredAs: toolName };
            } else {
                console.log(`  ❌ Forge: ${filename} failed (exit ${result.exitCode})`);
                return { success: false, phase: 'execution', exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, error: result.stderr || 'Non-zero exit', durationMs: result.durationMs };
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            return { success: false, phase: 'internal', error: error.message, durationMs: Date.now() - startTime };
        }
    },
});
