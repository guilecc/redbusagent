/**
 * @redbusagent/cli — Start Command
 *
 * Spawns the Daemon as a background process and the TUI in the foreground.
 * If the Vault is not configured, automatically runs the onboarding wizard.
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
        console.log(pc.yellow('\n⚙️  Nenhuma configuração encontrada.'));
        console.log(pc.dim('   Iniciando assistente de configuração...\n'));

        const success = await runOnboardingWizard();

        if (!success || !Vault.isConfigured()) {
            console.log(pc.red('\n❌ Configuração cancelada.'));
            console.log(pc.dim('   Use "redbus config" para configurar mais tarde.\n'));
            process.exit(1);
        }

        console.log(''); // spacing
    }

    const tsx = resolveTsx();
    const daemonEntry = resolve(PROJECT_ROOT, 'packages/daemon/src/main.ts');
    const tuiEntry = resolve(PROJECT_ROOT, 'packages/tui/src/main.tsx');

    // ── Start Daemon in background ────────────────────────────
    console.log(pc.dim('  🔄 Iniciando daemon...'));

    const daemonProcess = spawn(tsx, [daemonEntry], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: PROJECT_ROOT,
        env: { ...process.env },
    });

    // Capture daemon output for status
    let daemonReady = false;

    daemonProcess.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        if (text.includes('Daemon is ready')) {
            daemonReady = true;
        }
        // Show daemon boot logs
        if (!daemonReady) {
            process.stdout.write(pc.dim(text));
        }
    });

    daemonProcess.stderr?.on('data', (data: Buffer) => {
        process.stderr.write(pc.red(data.toString()));
    });

    // Wait for daemon to be ready
    await new Promise<void>((resolve) => {
        const check = setInterval(() => {
            if (daemonReady) {
                clearInterval(check);
                resolve();
            }
        }, 100);

        // Timeout after 10s
        setTimeout(() => {
            clearInterval(check);
            resolve();
        }, 10_000);
    });

    // Stop piping daemon output
    daemonProcess.stdout?.removeAllListeners('data');
    daemonProcess.stderr?.removeAllListeners('data');

    console.log(pc.dim('  🖥️  Iniciando TUI...\n'));

    // ── Start TUI in foreground ───────────────────────────────
    const tuiProcess = spawn(tsx, [tuiEntry], {
        stdio: 'inherit',
        cwd: PROJECT_ROOT,
        env: { ...process.env },
    });

    // When TUI exits, kill daemon and exit
    tuiProcess.on('exit', (code) => {
        daemonProcess.kill('SIGTERM');
        process.exit(code ?? 0);
    });

    // If daemon crashes, notify and exit
    daemonProcess.on('exit', (code) => {
        if (code !== null && code !== 0) {
            console.error(pc.red(`\n❌ Daemon encerrou com código ${code}`));
            tuiProcess.kill();
            process.exit(code);
        }
    });

    // Handle Ctrl+C
    process.on('SIGINT', () => {
        tuiProcess.kill('SIGINT');
        setTimeout(() => {
            daemonProcess.kill('SIGTERM');
            process.exit(0);
        }, 500);
    });
}
