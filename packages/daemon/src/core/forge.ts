/**
 * @redbusagent/daemon — The Forge
 *
 * The Forge is where the agent writes, installs dependencies,
 * and executes its own Node.js scripts autonomously.
 *
 * Workspace: ~/.redbusagent/forge/
 *  - Scripts are written here as .js files
 *  - Has its own package.json for isolated npm installs
 *  - Each execution is a child_process with stdout/stderr capture
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { Vault } from '@redbusagent/shared';

// ─── Types ────────────────────────────────────────────────────────

export interface ForgeExecutionResult {
    success: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
}

// ─── Constants ────────────────────────────────────────────────────

const FORGE_DIR = join(Vault.dir, 'forge');
const FORGE_PACKAGE_JSON = join(FORGE_DIR, 'package.json');
const EXECUTION_TIMEOUT_MS = 30_000; // 30 seconds max per script

// ─── Forge Service ────────────────────────────────────────────────

export class Forge {
    /** Path to the forge workspace */
    static get dir(): string {
        return FORGE_DIR;
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
     * Captures stdout, stderr, exit code, and execution duration.
     */
    static async executeScript(filename: string, input?: string): Promise<ForgeExecutionResult> {
        const filepath = join(FORGE_DIR, filename);
        const startTime = Date.now();

        return new Promise((resolve) => {
            const args = [filepath];
            if (input) args.push(input);

            const child = execFile(
                'node',
                args,
                {
                    cwd: FORGE_DIR,
                    timeout: EXECUTION_TIMEOUT_MS,
                    maxBuffer: 1024 * 1024, // 1MB output buffer
                    env: { ...process.env },
                },
                (error, stdout, stderr) => {
                    const durationMs = Date.now() - startTime;

                    if (error) {
                        resolve({
                            success: false,
                            exitCode: error.code ? Number(error.code) : 1,
                            stdout: stdout || '',
                            stderr: stderr || error.message,
                            durationMs,
                        });
                    } else {
                        resolve({
                            success: true,
                            exitCode: 0,
                            stdout: stdout || '',
                            stderr: stderr || '',
                            durationMs,
                        });
                    }
                },
            );

            void child; // prevent unused warning
        });
    }
}
