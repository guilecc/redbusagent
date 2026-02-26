/**
 * @redbusagent/cli — Daemon Command
 *
 * Starts ONLY the Daemon process (WebSocket server, Ollama, WhatsApp, Scheduler)
 * in the foreground with full stdio. Does NOT start the TUI.
 *
 * Usage: redbus daemon
 *
 * The daemon runs indefinitely until killed (Ctrl+C / SIGTERM).
 * Use `redbus start` in another terminal to connect the TUI client.
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { Vault } from '@redbusagent/shared';
import { runOnboardingWizard } from '../wizard/onboarding.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../../../');

function resolveTsx(): string {
    return resolve(PROJECT_ROOT, 'node_modules/.bin/tsx');
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

    const tsx = resolveTsx();
    const daemonEntry = resolve(PROJECT_ROOT, 'packages/daemon/src/main.ts');

    console.log(pc.dim('  🔄 Starting daemon in foreground mode...\n'));

    // ── Start Daemon with inherited stdio (foreground) ──────
    const daemonProcess = spawn(tsx, [daemonEntry], {
        stdio: 'inherit',
        cwd: PROJECT_ROOT,
        env: { ...process.env },
    });

    // When daemon exits, propagate exit code
    daemonProcess.on('exit', (code) => {
        process.exit(code ?? 0);
    });

    // Handle Ctrl+C — forward to daemon
    process.on('SIGINT', () => {
        daemonProcess.kill('SIGINT');
    });

    process.on('SIGTERM', () => {
        daemonProcess.kill('SIGTERM');
    });
}

