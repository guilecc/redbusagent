/**
 * @redbusagent/cli — Stop Command
 *
 * Sends SIGTERM to the running daemon process using the PID file
 * stored at ~/.redbusagent/daemon.pid.
 *
 * Usage: redbus stop
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pc from 'picocolors';
import { Vault } from '@redbusagent/shared';

const PID_FILE = join(Vault.dir, 'daemon.pid');

function isProcessRunning(pid: number): boolean {
    try {
        process.kill(pid, 0); // signal 0 = check existence
        return true;
    } catch {
        return false;
    }
}

export async function stopCommand(): Promise<void> {
    if (!existsSync(PID_FILE)) {
        console.log(pc.yellow('\n⚠️  No daemon PID file found.'));
        console.log(pc.dim('   The daemon is not running or was not started with "redbus daemon".\n'));
        process.exit(1);
    }

    const pidStr = readFileSync(PID_FILE, 'utf-8').trim();
    const pid = parseInt(pidStr, 10);

    if (isNaN(pid)) {
        console.log(pc.red(`\n❌ Invalid PID file content: "${pidStr}"`));
        process.exit(1);
    }

    if (!isProcessRunning(pid)) {
        console.log(pc.yellow(`\n⚠️  Daemon process (PID ${pid}) is not running.`));
        console.log(pc.dim('   Cleaning up stale PID file...\n'));
        const { unlinkSync } = await import('node:fs');
        unlinkSync(PID_FILE);
        process.exit(0);
    }

    console.log(pc.dim(`\n  🛑 Sending SIGTERM to daemon (PID ${pid})...`));

    try {
        process.kill(pid, 'SIGTERM');
        console.log(pc.green('  ✅ Daemon stop signal sent.'));
        console.log(pc.dim('     The daemon will shut down gracefully.\n'));
    } catch (err: any) {
        console.error(pc.red(`\n❌ Failed to stop daemon: ${err.message}`));
        process.exit(1);
    }
}

