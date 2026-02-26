/**
 * @redbusagent/cli — Daemon Command
 *
 * Starts the Daemon process in the background (detached).
 * Logs are redirected to ~/.redbusagent/daemon.log.
 * Returns control to the shell immediately.
 *
 * Usage: redbus daemon
 *
 * Use `redbus start` to connect the TUI client afterwards.
 * Use `redbus stop` to shut down the daemon.
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import pc from 'picocolors';
import { Vault, DEFAULT_PORT, DEFAULT_HOST } from '@redbusagent/shared';
import { runOnboardingWizard } from '../wizard/onboarding.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../../../');
const PID_FILE = join(Vault.dir, 'daemon.pid');

function resolveTsx(): string {
    return resolve(PROJECT_ROOT, 'node_modules/.bin/tsx');
}

function isDaemonRunning(): boolean {
    if (!existsSync(PID_FILE)) return false;
    try {
        const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
        if (isNaN(pid)) return false;
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** TCP-poll until the daemon is accepting connections */
function waitForDaemonReady(maxWaitMs = 15000): Promise<void> {
    const port = Number(process.env['REDBUS_PORT']) || DEFAULT_PORT;
    const host = process.env['REDBUS_HOST'] || DEFAULT_HOST;
    const startTime = Date.now();

    return new Promise((resolve) => {
        function tryConnect() {
            if (Date.now() - startTime > maxWaitMs) {
                resolve();
                return;
            }
            const socket = createConnection({ host, port }, () => {
                socket.destroy();
                resolve();
            });
            socket.on('error', () => {
                socket.destroy();
                setTimeout(tryConnect, 500);
            });
        }
        tryConnect();
    });
}

export async function daemonCommand(): Promise<void> {
    // ── Auto-intercept: run wizard if vault is empty ──────────
    if (!Vault.isConfigured()) {
        console.log(pc.yellow('\n⚙️  No configuration found.'));
        console.log(pc.dim('   Starting configuration wizard...\n'));

        const success = await runOnboardingWizard();

        if (!success || !Vault.isConfigured()) {
            console.log(pc.red('\n❌ Configuration cancelled.'));
            console.log(pc.dim('   Use "redbus config" to configure later.\n'));
            process.exit(1);
        }

        console.log(''); // spacing
    }

    // ── Check if already running ─────────────────────────────
    if (isDaemonRunning()) {
        console.log(pc.green('\n  ✅ Daemon is already running.'));
        console.log(pc.dim('     Use "redbus start" to open the TUI.\n'));
        return;
    }

    const tsx = resolveTsx();
    const daemonEntry = resolve(PROJECT_ROOT, 'packages/daemon/src/main.ts');
    const logPath = join(Vault.dir, 'daemon.log');
    const logFd = openSync(logPath, 'a');

    console.log(pc.dim('  🚀 Starting daemon in background...'));

    // ── Spawn fully detached — no pipes, no binding ──────────
    const daemonProcess = spawn(tsx, [daemonEntry], {
        stdio: ['ignore', logFd, logFd],
        cwd: PROJECT_ROOT,
        detached: true,
        env: { ...process.env },
    });

    daemonProcess.unref();

    console.log(pc.dim(`  📄 Logs: ${logPath}`));
    console.log(pc.dim('  ⏳ Waiting for daemon to be ready...'));

    await waitForDaemonReady();

    console.log(pc.green(`  ✅ Daemon started (PID: ${daemonProcess.pid})`));
    console.log(pc.dim('     Use "redbus start" to open the TUI.'));
    console.log(pc.dim('     Use "redbus stop" to shut it down.\n'));
}

