/**
 * @redbusagent/daemon — create_and_run_tool
 *
 * The primary native tool for the Forge.
 * Supports both Node.js (.js) and Python (.py) scripts.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { Forge } from '../forge.js';
import { ToolRegistry } from '../tool-registry.js';

export const createAndRunTool = tool({
    description: `Creates a script in the Forge workspace, installs any required dependencies, executes the script, and returns the output. Supports TWO languages:

• **Node.js** — filename must end in \`.js\`. Code must be valid CommonJS. Use require() for imports and console.log() for output. Dependencies are installed via npm.
• **Python** — filename must end in \`.py\`. Code must be valid Python 3. Use print() for output. Dependencies are installed via pip into an isolated venv. Input is passed as sys.argv[1].

**LOCAL DAEMON API (IPC):**
Any script you create can communicate back to your core engines using the Local IPC Server at \`http://127.0.0.1:8765\`:
- \`POST /api/infer\`: Pass \`{"prompt": "...", "engine": "live" | "worker"}\` to process text/data using LLMs.
- \`POST /api/notify\`: Pass \`{"message": "...", "channel": "tui" | "whatsapp"}\` to alert the user autonomously.
*Example (Python)*: \`requests.post("http://127.0.0.1:8765/api/infer", json={"prompt": "Summarize X"})*\`

The script's stdout will be returned as the result. Use this to generate code, run computations, create files, fetch data, do data science, or any task that requires code execution.`,

    inputSchema: z.object({
        filename: z.string().describe('Name of the script file to create (e.g. "generate-ticket.js" or "analyze-data.py"). Must end in .js or .py'),
        description: z.string().describe('Brief description of what this tool does'),
        code: z.string().describe('The complete source code to write and execute. For .js use CommonJS with console.log(). For .py use Python 3 with print().'),
        dependencies: z.array(z.string()).default([]).describe('Packages to install before execution. For .js: npm packages. For .py: pip packages (e.g. "requests", "pandas", "numpy").'),
    }),

    execute: async (params: {
        filename: string;
        description: string;
        code: string;
        dependencies: string[];
    }) => {
        const { filename, description, code, dependencies } = params;
        const startTime = Date.now();
        const lang = Forge.detectLanguage(filename);
        const langLabel = lang === 'python' ? '🐍 Python' : '📦 Node.js';

        try {
            Forge.ensureWorkspace();

            // ── Dependency installation ──────────────────────────
            if (dependencies.length > 0) {
                console.log(`  ${langLabel} Forge: Installing ${dependencies.length} dependencies: ${dependencies.join(', ')}`);

                const installResult = lang === 'python'
                    ? await Forge.installPythonDependencies(dependencies)
                    : await Forge.installDependencies(dependencies);

                if (!installResult.success) {
                    return { success: false, phase: 'dependency_install', error: `Failed: ${installResult.error}` };
                }
                console.log(`  ${langLabel} Forge: Dependencies installed`);
            }

            // ── Write & execute ──────────────────────────────────
            const filepath = Forge.writeScript(filename, code);
            console.log(`  📝 Forge: Script written to ${filepath}`);
            console.log(`  ▶️  Forge: Executing ${filename} (${lang})...`);

            const result = await Forge.executeScript(filename);

            if (result.success) {
                const toolName = filename.replace(/\.(js|py)$/, '').replace(/[^a-zA-Z0-9]/g, '_');
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
