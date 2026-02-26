/**
 * @redbusagent/cli — Start Command (TUI-only thin client)
 *
 * Launches only the TUI client. Requires the daemon to be running.
 * If the daemon is not running, tells the user to run `redbus daemon` first.
 *
 * Usage: redbus start
 */

import { spawn, execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import pc from 'picocolors';
import { Vault, DEFAULT_PORT, DEFAULT_HOST } from '@redbusagent/shared';
import { runOnboardingWizard } from '../wizard/onboarding.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../../../');
const PID_FILE = join(Vault.dir, 'daemon.pid');
const DAEMON_PORT = Number(process.env['REDBUS_PORT']) || DEFAULT_PORT;
const DAEMON_HOST = process.env['REDBUS_HOST'] || DEFAULT_HOST;

function resolveTsx(): string {
    return resolve(PROJECT_ROOT, 'node_modules/.bin/tsx');
}

/** Check if daemon is reachable via TCP (the real source of truth) */
function isDaemonReachable(): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = createConnection({ host: DAEMON_HOST, port: DAEMON_PORT }, () => {
            socket.destroy();
            resolve(true);
        });
        socket.on('error', () => {
            socket.destroy();
            resolve(false);
        });
        socket.setTimeout(3000, () => {
            socket.destroy();
            resolve(false);
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

    // ── Check if daemon is running (TCP is the source of truth) ──
    const reachable = await isDaemonReachable();
    if (!reachable) {
        console.log(pc.red('\n  ❌ Daemon is not running (port ' + DAEMON_PORT + ' unreachable).'));
        console.log(pc.dim('     Start it first with: ') + pc.cyan('redbus daemon'));
        console.log(pc.dim('     Then run: ') + pc.cyan('redbus start\n'));
        process.exit(1);
    }

    console.log(pc.dim('  ✅ Daemon is running (port ' + DAEMON_PORT + ').'));

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
