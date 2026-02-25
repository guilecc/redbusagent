import { tool } from 'ai';
import { z } from 'zod';
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export const processMonitorEmitter = new EventEmitter();

interface TrackedProcess {
    process: ChildProcess;
    logs: string[];
}

const activeProcesses = new Map<string, TrackedProcess>();
const MAX_LOG_LINES = 100;

function appendLog(alias: string, log: string) {
    const tracked = activeProcesses.get(alias);
    if (!tracked) return;

    tracked.logs.push(log);
    if (tracked.logs.length > MAX_LOG_LINES) {
        tracked.logs.shift(); // Keep only the last 100 lines
    }

    // Heuristics: Check for critical errors
    const lowerLog = log.toLowerCase();
    if (lowerLog.includes('error:') || lowerLog.includes('exception') || lowerLog.includes('eaddrinuse')) {
        // Debounce or immediate fire? Let's immediate fire a system alert
        processMonitorEmitter.emit('process_crashed', {
            alias,
            logSnippet: log.substring(0, 500)
        });
    }
}

export const startBackgroundProcessTool = tool({
    description: 'Spawns a long-running background process (e.g., a dev server, docker container, or watcher) and tracks its output. The system will alert you autonomously if it crashes.',
    inputSchema: z.object({
        command: z.string().describe('The command to execute (e.g., "npm run dev", "python server.py").'),
        alias: z.string().describe('A short, memorable alias for this process (e.g., "frontend-dev", "database").')
    }),
    execute: async ({ command, alias }) => {
        console.log(`  🔄 [ProcessManager] Starting: ${alias} -> ${command}`);

        if (activeProcesses.has(alias)) {
            return { success: false, error: `Process with alias '${alias}' is already running. Kill it first.` };
        }

        try {
            // Split command into executable and args
            const parts = command.trim().split(/\\s+/);
            if (parts.length === 0 || !parts[0]) {
                return { success: false, error: "Empty command." };
            }
            const executable = parts[0] as string;
            const args = parts.slice(1);

            const child = spawn(executable, args || [], {
                cwd: process.cwd(),
                shell: true, // required for npm, etc
                detached: false
            }) as any; // Bypass TS 'never' reduction issue for ChildProcess with shell:true

            activeProcesses.set(alias, { process: child, logs: [] });

            child.stdout?.on('data', (data: any) => {
                const logs = data.toString().split('\\n').filter((l: string) => l.trim() !== '');
                logs.forEach((l: string) => appendLog(alias, `[STDOUT] ${l}`));
            });

            child.stderr?.on('data', (data: any) => {
                const logs = data.toString().split('\\n').filter((l: string) => l.trim() !== '');
                logs.forEach((l: string) => appendLog(alias, `[STDERR] ${l}`));
            });

            child.on('error', (err: Error) => {
                const errMsg = `[ERROR] Failed to spawn: ${err.message}`;
                appendLog(alias, errMsg);
                processMonitorEmitter.emit('process_crashed', { alias, logSnippet: errMsg });
                activeProcesses.delete(alias);
            });

            child.on('close', (code: number | null) => {
                const closeMsg = `[CLOSE] Process exited with code ${code}`;
                appendLog(alias, closeMsg);
                if (code !== 0 && code !== null) {
                    processMonitorEmitter.emit('process_crashed', {
                        alias,
                        logSnippet: `Process exited unexpectedly with code ${code}. Last logs:\\n${activeProcesses.get(alias)?.logs.slice(-10).join('\\n')}`
                    });
                }
                activeProcesses.delete(alias);
            });

            return {
                success: true,
                message: `Process '${alias}' started successfully with PID ${child.pid}. Logs are being monitored.`
            };

        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }
});

export const getProcessLogsTool = tool({
    description: 'Retrieves the last 100 lines of stdout/stderr for a tracked background process.',
    inputSchema: z.object({
        alias: z.string().describe('The alias of the tracked process.')
    }),
    execute: async ({ alias }) => {
        const tracked = activeProcesses.get(alias);
        if (!tracked) {
            return { success: false, error: `No active process found for alias '${alias}'.` };
        }
        return {
            success: true,
            logs: tracked.logs.join('\\n') || 'No logs yet.'
        };
    }
});

export const killBackgroundProcessTool = tool({
    description: 'Kills a running background process by its alias.',
    inputSchema: z.object({
        alias: z.string().describe('The alias of the tracked process.')
    }),
    execute: async ({ alias }) => {
        const tracked = activeProcesses.get(alias);
        if (!tracked) {
            return { success: false, error: `No active process found for alias '${alias}'.` };
        }
        try {
            tracked.process.kill('SIGINT');
            activeProcesses.delete(alias);
            return { success: true, message: `Process '${alias}' terminated.` };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }
});
