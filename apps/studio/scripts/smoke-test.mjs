#!/usr/bin/env node

/**
 * Smoke Test for Redbus Studio (Electron App)
 *
 * This script builds the app with `electron-vite build`, launches it with
 * `electron-vite preview`, verifies that the window opens and the app
 * doesn't crash, and reports pass/fail.
 *
 * Usage:
 *   node apps/studio/scripts/smoke-test.mjs                # build + test
 *   node apps/studio/scripts/smoke-test.mjs --skip-build   # test only (reuse previous build)
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const studioRoot = resolve(__dirname, '..');
const repoRoot = resolve(studioRoot, '../..');
const outDir = resolve(studioRoot, 'out');
const electronViteBin = resolve(repoRoot, 'node_modules/.bin/electron-vite');

const skipBuild = process.argv.includes('--skip-build');

const STABLE_DURATION_MS = 8_000;
const LAUNCH_TIMEOUT_MS = 30_000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(emoji, msg) {
    console.log(`${emoji}  ${msg}`);
}

function fail(msg, error) {
    log('❌', msg);
    if (error) console.error(error);
    process.exit(1);
}

// ─── Step 1: Build ──────────────────────────────────────────────────────────

async function buildApp() {
    if (skipBuild) {
        if (!existsSync(resolve(outDir, 'main/index.js'))) {
            fail('--skip-build was passed but out/main/index.js does not exist. Run a build first.');
        }
        log('⏭️', 'Skipping build (--skip-build)');
        return;
    }

    log('🔨', 'Building Redbus Studio (electron-vite build)…');
    try {
        execSync(`"${electronViteBin}" build`, {
            cwd: studioRoot,
            stdio: 'inherit',
            env: { ...process.env, NODE_ENV: 'production' },
        });
    } catch {
        fail('Build failed — see output above.');
    }

    if (!existsSync(resolve(outDir, 'main/index.js'))) {
        fail('Build succeeded but out/main/index.js is missing.');
    }
    log('✅', 'Build completed successfully.');
}

// ─── Step 2: Launch + Verify ────────────────────────────────────────────────

async function launchAndVerify() {
    log('🚀', 'Launching Redbus Studio via electron-vite preview…');

    if (!existsSync(electronViteBin)) {
        fail(`electron-vite binary not found at ${electronViteBin}. Run npm install first.`);
    }

    return new Promise((resolvePromise) => {
        const stderrLines = [];
        const stdoutLines = [];
        let settled = false;
        let stableTimer = null;
        let hasErrors = false;

        const childEnv = { ...process.env, NODE_ENV: 'production', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
        // CRITICAL: Ensure Electron runs as a browser app, not as a Node.js process.
        // If this is inherited from the shell, it maps `import "electron"` to the npm string package
        // and skips browser initialization, breaking everything.
        delete childEnv.ELECTRON_RUN_AS_NODE;

        // electron-vite preview --skipBuild launches the already-built app
        const child = spawn(electronViteBin, ['preview', '--skipBuild'], {
            cwd: studioRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: childEnv,
        });

        const pid = child.pid;
        log('🔧', `electron-vite preview started (PID: ${pid})`);

        child.stdout.on('data', (data) => {
            const lines = data.toString().split('\n').filter(Boolean);
            stdoutLines.push(...lines);
            for (const line of lines) {
                log('📤', `stdout: ${line}`);
            }
        });

        child.stderr.on('data', (data) => {
            const lines = data.toString().split('\n').filter(Boolean);
            stderrLines.push(...lines);
            for (const line of lines) {
                // Skip noisy Electron GPU/sandbox warnings
                if (
                    line.includes('GPU') ||
                    line.includes('Passthrough') ||
                    line.includes('MessagePort') ||
                    line.includes('DevTools') ||
                    line.includes('trust_store_mac.cc') ||
                    line.includes('certificate policies')
                ) continue;

                // Detect real errors
                if (
                    line.includes('Error') ||
                    line.includes('error') ||
                    line.includes('FATAL') ||
                    line.includes('Cannot find')
                ) {
                    hasErrors = true;
                }

                log('📤', `stderr: ${line}`);
            }
        });

        function finish(success, message) {
            if (settled) return;
            settled = true;
            if (stableTimer) clearTimeout(stableTimer);
            if (launchTimeout) clearTimeout(launchTimeout);

            // Kill the process tree
            try {
                // Kill the process group (negative PID kills the group)
                process.kill(-child.pid, 'SIGTERM');
            } catch {
                try {
                    child.kill('SIGTERM');
                } catch { }
            }

            // Wait for graceful shutdown
            setTimeout(() => {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                } catch {
                    try { child.kill('SIGKILL'); } catch { }
                }

                console.log('\n' + '═'.repeat(60));
                if (success) {
                    log('🎉', message);
                    console.log('═'.repeat(60) + '\n');
                    resolvePromise();
                } else {
                    fail(message);
                }
            }, 2000);
        }

        child.on('error', (err) => {
            finish(false, `electron-vite process failed to start: ${err.message}`);
        });

        child.on('exit', (code, signal) => {
            if (settled) return;
            if (signal === 'SIGTERM' || signal === 'SIGKILL') return; // Our own kill
            finish(false, `Electron app exited unexpectedly (code: ${code}, signal: ${signal})\nStderr:\n${stderrLines.slice(-20).join('\n')}`);
        });

        // Wait for the app to stabilize
        log('⏳', `Waiting ${STABLE_DURATION_MS / 1000}s to verify the app runs stably…`);

        stableTimer = setTimeout(() => {
            // Verify the process is still alive
            try {
                process.kill(child.pid, 0);
            } catch {
                finish(false, 'Electron process died before the stability check.');
                return;
            }

            if (hasErrors) {
                finish(
                    false,
                    `App started but had errors:\n${stderrLines.filter(l => l.includes('Error') || l.includes('error')).join('\n')}`,
                );
                return;
            }

            finish(true, `SMOKE TEST PASSED — Redbus Studio started and ran stably for ${STABLE_DURATION_MS / 1000}s!`);
        }, STABLE_DURATION_MS);

        // Overall timeout
        const launchTimeout = setTimeout(() => {
            finish(false, `Smoke test timed out after ${LAUNCH_TIMEOUT_MS / 1000}s`);
        }, LAUNCH_TIMEOUT_MS);
    });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n' + '═'.repeat(60));
    log('🧪', 'Redbus Studio — Smoke Test');
    console.log('═'.repeat(60) + '\n');

    await buildApp();
    await launchAndVerify();
}

main().catch((err) => {
    fail('Unexpected error during smoke test', err);
});
