/**
 * @redbusagent/cli — Start Command (TUI-only thin client)
 *
 * Launches the TUI client. If the daemon is not already running,
 * it auto-starts the daemon in the background first, then launches the TUI.
 *
 * Usage: redbus start
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
        process.kill(pid, 0); // signal 0 = check existence
        return true;
    } catch {
        return false;
    }
}

/** Try to connect to the daemon's WebSocket port to confirm it's accepting connections */
function waitForDaemonReady(maxWaitMs = 15000): Promise<void> {
    const port = Number(process.env['REDBUS_PORT']) || DEFAULT_PORT;
    const host = process.env['REDBUS_HOST'] || DEFAULT_HOST;
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
        function tryConnect() {
            if (Date.now() - startTime > maxWaitMs) {
                // Timeout — but daemon process was spawned, so proceed anyway
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

function startDaemonBackground(): Promise<void> {
    const tsx = resolveTsx();
    const daemonEntry = join(PROJECT_ROOT, 'packages/daemon/src/main.ts');

    console.log(pc.dim('  🚀 Daemon not running. Starting in background...'));

    // Redirect daemon stdout/stderr to a log file so pipes don't bind the processes
    const logPath = join(Vault.dir, 'daemon.log');
    const logFd = openSync(logPath, 'a');

    const daemonProcess = spawn(tsx, [daemonEntry], {
        stdio: ['ignore', logFd, logFd],
        cwd: PROJECT_ROOT,
        detached: true,
        env: { ...process.env },
    });

    daemonProcess.unref();

    console.log(pc.dim(`  📄 Daemon log: ${logPath}`));
    console.log(pc.dim(`  ⏳ Waiting for daemon to be ready...`));

    // Wait for the daemon to start accepting connections
    return waitForDaemonReady().then(() => {
        console.log(pc.green(`  ✅ Daemon started (PID: ${daemonProcess.pid})`));
    });
}

export async function startCommand(): Promise<void> {
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

    // ── Auto-start daemon if not running ──────────────────────
    if (!isDaemonRunning()) {
        try {
            await startDaemonBackground();
        } catch (err: any) {
            console.error(pc.red(`\n❌ Failed to start daemon: ${err.message}`));
            console.log(pc.dim('   Try starting manually with: redbus daemon\n'));
            process.exit(1);
        }
    } else {
        console.log(pc.dim('  ✅ Daemon already running.'));
    }

    const tsx = resolveTsx();
    const tuiEntry = resolve(PROJECT_ROOT, 'packages/tui/src/main.tsx');

    console.log(pc.dim('  🖥️  Starting TUI client...\n'));

    // ── Start TUI in foreground (thin client) ─────────────────
    const tuiProcess = spawn(tsx, [tuiEntry], {
        stdio: 'inherit',
        cwd: PROJECT_ROOT,
        env: { ...process.env },
    });

    // When TUI exits, just exit — do NOT kill the daemon
    tuiProcess.on('exit', (code) => {
        process.exit(code ?? 0);
    });

    // Handle Ctrl+C — forward to TUI only
    process.on('SIGINT', () => {
        tuiProcess.kill('SIGINT');
    });
}
