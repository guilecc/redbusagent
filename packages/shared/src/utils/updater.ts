import { APP_VERSION } from '../constants.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execAsync = promisify(exec);

export interface UpdateInfo {
    updateAvailable: boolean;
    currentVersion: string;
    latestVersion: string;
}

export async function checkForUpdates(): Promise<UpdateInfo> {
    try {
        const response = await fetch('https://raw.githubusercontent.com/guilecc/redbusagent/main/package.json');
        if (!response.ok) {
            throw new Error(`Failed to fetch package.json: ${response.statusText}`);
        }

        const data = await response.json() as { version: string };
        const latestVersion = data.version;

        // Simple string comparison for versions like "0.1.0". For robust semver, we might need the 'semver' pkg,
        // but simple string comparison works for major.minor.patch if they keep the same padding, or we handle it via split.
        const currentParts = APP_VERSION.split('.').map(Number);
        const latestParts = latestVersion.split('.').map(Number);

        let updateAvailable = false;
        for (let i = 0; i < 3; i++) {
            const lPart = latestParts[i] || 0;
            const cPart = currentParts[i] || 0;
            if (lPart > cPart) {
                updateAvailable = true;
                break;
            } else if (lPart < cPart) {
                break; // Local is newer
            }
        }

        return {
            updateAvailable,
            currentVersion: APP_VERSION,
            latestVersion
        };
    } catch (error) {
        // Silently fail or log if we can't check
        return {
            updateAvailable: false,
            currentVersion: APP_VERSION,
            latestVersion: APP_VERSION
        };
    }
}

export async function performUpdate(): Promise<void> {
    // Determine the install location. Are we running from git clone or global npm install?
    // A robust way: check if we are in a git repository.
    try {
        const rootDir = path.resolve(__dirname, '../../../..');
        const isGitRepo = fs.existsSync(path.join(rootDir, '.git'));

        if (isGitRepo) {
            // Let's assume the user has a git clone here.
            await execAsync('git fetch origin && git reset --hard origin/main', { cwd: rootDir });
            await execAsync('npm install && npm run build', { cwd: rootDir });
        } else {
            // Assume the standard installer location ~/.redbusagent
            const homeDir = process.env['HOME'] || process.env['USERPROFILE'];
            const installDir = path.join(homeDir || '', '.redbusagent');
            if (fs.existsSync(installDir)) {
                await execAsync('git fetch origin && git reset --hard origin/main', { cwd: installDir });
                await execAsync('npm install && npm run build', { cwd: installDir });
            } else {
                throw new Error("Could not determine installation method to update.");
            }
        }
    } catch (err: any) {
        throw new Error(`Update failed: ${err.message}`);
    }
}
