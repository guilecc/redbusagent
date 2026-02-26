/**
 * @redbusagent/cli — Stop Command
 *
 * Kills the running daemon process. Uses multiple strategies:
 *  1. PID file (written by daemon's main.ts)
 *  2. Port-based kill (lsof fallback for orphan processes)
 *
 * Usage: redbus stop
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import pc from 'picocolors';
import { Vault, DEFAULT_PORT } from '@redbusagent/shared';

const PID_FILE = join(Vault.dir, 'daemon.pid');
const DAEMON_PORT = Number(process.env['REDBUS_PORT']) || DEFAULT_PORT;

function isProcessRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** Find all PIDs listening on the daemon port */
function findPidsOnPort(): number[] {
    try {
        const result = execSync(`lsof -ti:${DAEMON_PORT} 2>/dev/null`, { encoding: 'utf-8' }).trim();
        if (!result) return [];
        return result.split('\n').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    } catch {
        return [];
    }
}

/** Kill a list of PIDs with escalation: SIGTERM → wait → SIGKILL */
function killPids(pids: number[]): number {
    let killed = 0;
    for (const pid of pids) {
        try {
            process.kill(pid, 'SIGTERM');
            killed++;
        } catch {
            // already dead
        }
    }
    // Give them a moment to die gracefully
    if (killed > 0) {
        try { execSync('sleep 1'); } catch { /* ignore */ }
        // Force-kill any survivors
        for (const pid of pids) {
            try {
                process.kill(pid, 0); // check if still alive
                process.kill(pid, 'SIGKILL');
            } catch {
                // dead
            }
        }
    }
    return killed;
}

export async function stopCommand(): Promise<void> {
    let killedSomething = false;

    // ── Strategy 1: PID file ──────────────────────────────────
    if (existsSync(PID_FILE)) {
        const pidStr = readFileSync(PID_FILE, 'utf-8').trim();
        const pid = parseInt(pidStr, 10);

        if (!isNaN(pid) && isProcessRunning(pid)) {
            console.log(pc.dim(`\n  🛑 Killing daemon (PID ${pid})...`));
            try {
                process.kill(pid, 'SIGTERM');
                killedSomething = true;
            } catch { /* ignore */ }
        }

        // Clean up PID file regardless
        try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    }

    // ── Strategy 2: Kill any orphans on the port ──────────────
    // Give Strategy 1 a moment to take effect
    if (killedSomething) {
        await new Promise(r => setTimeout(r, 1000));
    }

    const orphanPids = findPidsOnPort();
    if (orphanPids.length > 0) {
        console.log(pc.yellow(`  ⚠️  Found ${orphanPids.length} orphan process(es) on port ${DAEMON_PORT}: ${orphanPids.join(', ')}`));
        const killed = killPids(orphanPids);
        if (killed > 0) {
            killedSomething = true;
            console.log(pc.dim(`     Killed ${killed} orphan process(es).`));
        }
    }

    if (killedSomething) {
        console.log(pc.green('  ✅ Daemon stopped.'));
        console.log(pc.dim(`     Port ${DAEMON_PORT} is now free.\n`));
    } else {
        console.log(pc.yellow('\n⚠️  No daemon found to stop.'));
        console.log(pc.dim(`   No PID file and no process on port ${DAEMON_PORT}.\n`));
    }
}

