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

import { spawn, execSync } from 'node:child_process';
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
const DAEMON_PORT = Number(process.env['REDBUS_PORT']) || DEFAULT_PORT;
const DAEMON_HOST = process.env['REDBUS_HOST'] || DEFAULT_HOST;

function resolveTsx(): string {
    return resolve(PROJECT_ROOT, 'node_modules/.bin/tsx');
}

/** Check if the daemon port is already in use */
function isPortInUse(): boolean {
    try {
        const result = execSync(`lsof -ti:${DAEMON_PORT} 2>/dev/null`, { encoding: 'utf-8' }).trim();
        return result.length > 0;
    } catch {
        return false;
    }
}

/** Kill any process listening on the daemon port */
function killOrphansOnPort(): void {
    try {
        execSync(`lsof -ti:${DAEMON_PORT} 2>/dev/null | xargs kill -9 2>/dev/null`, { encoding: 'utf-8' });
    } catch {
        // No processes found or kill failed — that's fine
    }
}

/** Read the PID from the file written by daemon's main.ts */
function readDaemonPid(): number | null {
    if (!existsSync(PID_FILE)) return null;
    try {
        const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
        return isNaN(pid) ? null : pid;
    } catch {
        return null;
    }
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function isDaemonRunning(): boolean {
    const pid = readDaemonPid();
    if (pid && isProcessAlive(pid)) return true;
    // Fallback: check if something is on the port
    return isPortInUse();
}

/** TCP-poll until the daemon is accepting connections */
function waitForDaemonReady(maxWaitMs = 15000): Promise<boolean> {
    const startTime = Date.now();

    return new Promise((resolve) => {
        function tryConnect() {
            if (Date.now() - startTime > maxWaitMs) {
                resolve(false);
                return;
            }
            const socket = createConnection({ host: DAEMON_HOST, port: DAEMON_PORT }, () => {
                socket.destroy();
                resolve(true);
            });
            socket.on('error', () => {
                socket.destroy();
                setTimeout(tryConnect, 500);
            });
        }
        tryConnect();
    });
}

/** Wait for PID file to appear (daemon's main.ts writes it) */
function waitForPidFile(maxWaitMs = 5000): Promise<number | null> {
    const startTime = Date.now();
    return new Promise((resolve) => {
        function check() {
            const pid = readDaemonPid();
            if (pid && isProcessAlive(pid)) {
                resolve(pid);
                return;
            }
            if (Date.now() - startTime > maxWaitMs) {
                resolve(null);
                return;
            }
            setTimeout(check, 300);
        }
        check();
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
        const pid = readDaemonPid();
        console.log(pc.green(`\n  ✅ Daemon is already running${pid ? ` (PID: ${pid})` : ' (port in use)'}.`));
        console.log(pc.dim('     Use "redbus start" to open the TUI.\n'));
        return;
    }

    // ── Kill any orphan processes on the port ─────────────────
    if (isPortInUse()) {
        console.log(pc.yellow('  ⚠️  Killing orphan process on port ' + DAEMON_PORT + '...'));
        killOrphansOnPort();
        // Give OS time to release the port
        await new Promise(r => setTimeout(r, 1000));
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

    const ready = await waitForDaemonReady();

    if (!ready) {
        console.log(pc.red('  ❌ Daemon failed to start. Check logs:'));
        console.log(pc.dim(`     tail -50 ${logPath}\n`));
        process.exit(1);
    }

    // Wait for daemon's main.ts to write its own PID
    const actualPid = await waitForPidFile();
    const displayPid = actualPid || daemonProcess.pid;

    console.log(pc.green(`  ✅ Daemon started (PID: ${displayPid})`));
    console.log(pc.dim('     Use "redbus start" to open the TUI.'));
    console.log(pc.dim('     Use "redbus stop" to shut it down.\n'));
}

