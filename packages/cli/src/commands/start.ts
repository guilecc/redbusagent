/**
 * @redbusagent/cli — Start Command (TUI-only thin client)
 *
 * Launches ONLY the TUI client, which connects to an already-running Daemon
 * via WebSocket. The Daemon must be started separately with `redbus daemon`.
 *
 * If the Daemon is offline, the TUI will show:
 *   "❌ Daemon is offline. Run 'redbus daemon' in another terminal."
 *
 * Usage: redbus start
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
