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
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pc from 'picocolors';
import { Vault } from '@redbusagent/shared';
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

function startDaemonBackground(): Promise<void> {
    return new Promise((resolve, reject) => {
        const tsx = resolveTsx();
        const daemonEntry = join(PROJECT_ROOT, 'packages/daemon/src/main.ts');

        console.log(pc.dim('  🚀 Daemon not running. Starting in background...'));

        const daemonProcess = spawn(tsx, [daemonEntry], {
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: PROJECT_ROOT,
            detached: true,
            env: { ...process.env },
        });

        daemonProcess.unref();

        let resolved = false;

        // Wait for "Daemon is ready" message or PID file to appear
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                console.log(pc.green('  ✅ Daemon started (PID: ' + daemonProcess.pid + ')'));
                resolve();
            }
        }, 8000); // max 8s wait

        daemonProcess.stdout?.on('data', (data: Buffer) => {
            const text = data.toString();
            if (text.includes('Daemon is ready') && !resolved) {
                resolved = true;
                clearTimeout(timeout);
                console.log(pc.green('  ✅ Daemon started (PID: ' + daemonProcess.pid + ')'));
                resolve();
            }
        });

        daemonProcess.on('error', (err) => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                reject(err);
            }
        });

        daemonProcess.on('exit', (code) => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                reject(new Error(`Daemon exited prematurely with code ${code}`));
            }
        });
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
