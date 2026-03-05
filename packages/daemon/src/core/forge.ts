/**
 * @redbusagent/daemon — The Forge
 *
 * The Forge is where the agent writes, installs dependencies,
 * and executes its own Node.js and Python scripts autonomously.
 *
 * Workspace: ~/.redbusagent/forge/
 *  - Scripts are written here as .js or .py files
 *  - Has its own package.json for isolated npm installs
 *  - Has its own Python venv for isolated pip installs
 *  - Each execution is a child_process with stdout/stderr capture
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, type ExecFileException } from 'node:child_process';
import { Vault } from '@redbusagent/shared';

// ─── Types ────────────────────────────────────────────────────────

export interface ForgeExecutionResult {
    success: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    errorMessage?: string;
    errorCode?: number | string;
    signal?: NodeJS.Signals | null;
    timedOut?: boolean;
    failedCommand?: string;
    combinedOutput?: string;
}

export type ForgeLanguage = 'node' | 'python';

// ─── Constants ────────────────────────────────────────────────────

const FORGE_DIR = join(Vault.dir, 'forge');
const FORGE_PACKAGE_JSON = join(FORGE_DIR, 'package.json');
const FORGE_VENV_DIR = join(FORGE_DIR, '.venv');
const EXECUTION_TIMEOUT_MS = 30_000; // 30 seconds max per script

// ─── Helpers ─────────────────────────────────────────────────────

function detectLanguage(filename: string): ForgeLanguage {
    if (filename.endsWith('.py')) return 'python';
    return 'node';
}

/** Returns the path to the Python interpreter inside the venv */
function venvPython(): string {
    // Works on macOS/Linux; Windows would use Scripts/python.exe
    return join(FORGE_VENV_DIR, 'bin', 'python3');
}

/** Returns the path to the pip executable inside the venv */
function venvPip(): string {
    return join(FORGE_VENV_DIR, 'bin', 'pip');
}

function combineOutput(stdout: string, stderr: string): string {
    const sections: string[] = [];
    if (stdout.trim()) sections.push(`stdout:\n${stdout.trim()}`);
    if (stderr.trim()) sections.push(`stderr:\n${stderr.trim()}`);
    return sections.join('\n\n');
}

function truncateOutput(value: string, maxLength = 1200): string {
    if (value.length <= maxLength) return value;
    const remaining = value.length - maxLength;
    return `${value.slice(0, maxLength)}\n…[truncated ${remaining} chars]`;
}

function normalizeExecFailure(
    error: ExecFileException,
    stdout: string,
    stderr: string,
    durationMs: number,
): ForgeExecutionResult {
    const exitCode = typeof error.code === 'number' ? error.code : null;
    const errorMessage = error.message || 'Command failed';
    const normalizedStderr = stderr.trim() ? stderr : errorMessage;

    return {
        success: false,
        exitCode,
        stdout,
        stderr: normalizedStderr,
        durationMs,
        errorMessage,
        errorCode: error.code ?? undefined,
        signal: error.signal ?? null,
        timedOut: error.killed === true && errorMessage.toLowerCase().includes('timed out'),
        failedCommand: error.cmd,
        combinedOutput: combineOutput(stdout, normalizedStderr),
    };
}

export function formatForgeFailureDetails(filename: string, result: ForgeExecutionResult): string {
    const lines = [`Forge execution failed for ${filename}.`];

    if (result.exitCode != null) lines.push(`Exit code: ${result.exitCode}`);
    if (result.errorCode != null && result.errorCode !== result.exitCode) lines.push(`Error code: ${String(result.errorCode)}`);
    if (result.signal) lines.push(`Signal: ${result.signal}`);
    if (result.timedOut) lines.push(`Timed out after ${EXECUTION_TIMEOUT_MS}ms`);
    if (result.failedCommand) lines.push(`Command: ${result.failedCommand}`);
    if (result.errorMessage && result.errorMessage !== result.stderr) lines.push(`Runtime error: ${result.errorMessage}`);

    if (result.stderr.trim()) {
        lines.push('', `stderr:\n${truncateOutput(result.stderr.trim())}`);
    }

    if (result.stdout.trim()) {
        lines.push('', `stdout:\n${truncateOutput(result.stdout.trim())}`);
    }

    return lines.join('\n');
}

// ─── Forge Service ────────────────────────────────────────────────

export class Forge {
    /** Path to the forge workspace */
    static get dir(): string {
        return FORGE_DIR;
    }

    /** Path to the Python venv directory */
    static get venvDir(): string {
        return FORGE_VENV_DIR;
    }

    /**
     * Ensures the forge workspace exists with a valid package.json.
     * Called once at daemon startup.
     */
    static ensureWorkspace(): void {
        if (!existsSync(FORGE_DIR)) {
            mkdirSync(FORGE_DIR, { recursive: true, mode: 0o700 });
        }

        if (!existsSync(FORGE_PACKAGE_JSON)) {
            const packageJson = {
                name: 'redbusagent-forge',
                version: '1.0.0',
                private: true,
                description: 'Auto-generated workspace for redbusagent forged tools',
            };
            writeFileSync(FORGE_PACKAGE_JSON, JSON.stringify(packageJson, null, 2), {
                encoding: 'utf-8',
            });
        }
    }

    /**
     * Ensures the Python venv exists inside the forge workspace.
     * Creates it on first use so we don't slow down startup if Python isn't needed.
     */
    static async ensurePythonVenv(): Promise<{ success: boolean; error?: string }> {
        if (existsSync(venvPython())) return { success: true };

        console.log('  🐍 Forge: Creating Python virtual environment...');
        return new Promise((resolve) => {
            execFile(
                'python3',
                ['-m', 'venv', FORGE_VENV_DIR],
                {
                    cwd: FORGE_DIR,
                    timeout: 60_000,
                    env: { ...process.env },
                },
                (error, _stdout, stderr) => {
                    if (error) {
                        resolve({ success: false, error: stderr || error.message });
                    } else {
                        console.log('  🐍 Forge: Python venv created');
                        resolve({ success: true });
                    }
                },
            );
        });
    }

    /**
     * Detect language from filename extension.
     */
    static detectLanguage(filename: string): ForgeLanguage {
        return detectLanguage(filename);
    }

    /**
     * Install npm dependencies in the forge workspace.
     * Runs `npm install` silently.
     */
    static async installDependencies(deps: string[]): Promise<{ success: boolean; error?: string }> {
        if (deps.length === 0) return { success: true };

        return new Promise((resolve) => {
            execFile(
                'npm',
                ['install', '--save', ...deps],
                {
                    cwd: FORGE_DIR,
                    timeout: 60_000, // 60s for installs
                    env: { ...process.env, NODE_ENV: 'production' },
                },
                (error, _stdout, stderr) => {
                    if (error) {
                        resolve({ success: false, error: stderr || error.message });
                    } else {
                        resolve({ success: true });
                    }
                },
            );
        });
    }

    /**
     * Install Python (pip) dependencies into the forge venv.
     * Ensures the venv exists before installing.
     */
    static async installPythonDependencies(deps: string[]): Promise<{ success: boolean; error?: string }> {
        if (deps.length === 0) return { success: true };

        const venvResult = await this.ensurePythonVenv();
        if (!venvResult.success) {
            return { success: false, error: `Failed to create venv: ${venvResult.error}` };
        }

        return new Promise((resolve) => {
            execFile(
                venvPip(),
                ['install', ...deps],
                {
                    cwd: FORGE_DIR,
                    timeout: 120_000, // 120s for pip installs
                    maxBuffer: 2 * 1024 * 1024,
                    env: {
                        ...process.env,
                        VIRTUAL_ENV: FORGE_VENV_DIR,
                        PATH: `${join(FORGE_VENV_DIR, 'bin')}:${process.env['PATH'] || ''}`,
                    },
                },
                (error, _stdout, stderr) => {
                    if (error) {
                        resolve({ success: false, error: stderr || error.message });
                    } else {
                        resolve({ success: true });
                    }
                },
            );
        });
    }

    /**
     * Write a script file to the forge workspace.
     */
    static writeScript(filename: string, code: string): string {
        const filepath = join(FORGE_DIR, filename);
        writeFileSync(filepath, code, { encoding: 'utf-8', mode: 0o644 });
        return filepath;
    }

    /**
     * Read a script file from the forge workspace.
     */
    static readScript(filename: string): string | null {
        const filepath = join(FORGE_DIR, filename);
        if (!existsSync(filepath)) return null;
        return readFileSync(filepath, 'utf-8');
    }

    /**
     * Execute a script in the forge workspace via child_process.
     * Detects language from file extension (.py → python3, .js → node).
     * Captures stdout, stderr, exit code, and execution duration.
     */
    static async executeScript(filename: string, input?: string): Promise<ForgeExecutionResult> {
        const filepath = join(FORGE_DIR, filename);
        const lang = detectLanguage(filename);
        const startTime = Date.now();

        // For Python scripts, ensure venv exists so imports resolve
        if (lang === 'python') {
            const venvResult = await this.ensurePythonVenv();
            if (!venvResult.success) {
                return {
                    success: false,
                    exitCode: 1,
                    stdout: '',
                    stderr: `Failed to ensure Python venv: ${venvResult.error}`,
                    durationMs: Date.now() - startTime,
                };
            }
        }

        const interpreter = lang === 'python' ? venvPython() : 'node';

        return new Promise((resolve) => {
            const args = [filepath];
            if (input) args.push(input);

            const envVars = { ...process.env };
            if (lang === 'python') {
                envVars['VIRTUAL_ENV'] = FORGE_VENV_DIR;
                envVars['PATH'] = `${join(FORGE_VENV_DIR, 'bin')}:${process.env['PATH'] || ''}`;
            }

            const child = execFile(
                interpreter,
                args,
                {
                    cwd: FORGE_DIR,
                    timeout: EXECUTION_TIMEOUT_MS,
                    maxBuffer: 1024 * 1024, // 1MB output buffer
                    env: envVars,
                },
                (error, stdout, stderr) => {
                    const durationMs = Date.now() - startTime;

                    if (error) {
                        resolve(normalizeExecFailure(error, stdout || '', stderr || '', durationMs));
                    } else {
                        resolve({
                            success: true,
                            exitCode: 0,
                            stdout: stdout || '',
                            stderr: stderr || '',
                            durationMs,
                            combinedOutput: combineOutput(stdout || '', stderr || ''),
                        });
                    }
                },
            );

            void child; // prevent unused warning
        });
    }
}
