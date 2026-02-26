/**
 * @redbusagent/shared — Hardware Inspector
 *
 * Detects GPU/VRAM capabilities using `systeminformation` and derives
 * the Tier 1 power class based on available VRAM (not system RAM).
 *
 * Apple Silicon (M1/M2/M3/M4) uses unified memory architecture,
 * so VRAM = system RAM for those machines.
 *
 * VRAM Thresholds:
 *   < 6 GB  → bronze
 *   ≥ 6 GB  → silver
 *   ≥ 12 GB → gold
 *   ≥ 24 GB → platinum
 */

import os from 'node:os';
import { execSync } from 'node:child_process';
import type { Tier1PowerClass } from '../vault/vault.js';

// ─── Types ────────────────────────────────────────────────────────

export interface HardwareProfile {
    /** GPU name (e.g. "NVIDIA GeForce RTX 4090", "Apple M2 Pro") */
    gpuName: string;
    /** Detected VRAM in GB (unified memory on Apple Silicon) */
    vramGB: number;
    /** Total system RAM in GB */
    systemRamGB: number;
    /** Power class derived from VRAM thresholds */
    powerClass: Tier1PowerClass;
}

// ─── Helpers ──────────────────────────────────────────────────────

function isAppleSilicon(): boolean {
    return process.platform === 'darwin' && process.arch === 'arm64';
}

function getAppleChipName(): string {
    try {
        const chip = execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf-8' }).trim();
        // e.g. "Apple M2 Pro" or "Apple M1 Max"
        if (chip.startsWith('Apple')) return chip.replace('Apple ', '');
        return chip || 'Silicon';
    } catch {
        return 'Silicon';
    }
}

function classifyVRAM(vramGB: number): Tier1PowerClass {
    if (vramGB >= 24) return 'platinum';
    if (vramGB >= 12) return 'gold';
    if (vramGB >= 6) return 'silver';
    return 'bronze';
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Inspects the machine's GPU/VRAM capabilities and returns a
 * hardware profile with the derived power class.
 *
 * Uses `systeminformation` for GPU detection on Linux/Windows.
 * Falls back to unified memory (os.totalmem) on Apple Silicon.
 */
export async function inspectHardwareProfile(): Promise<HardwareProfile> {
    const systemRamGB = Math.round(os.totalmem() / (1024 * 1024 * 1024));

    // ── Apple Silicon: unified memory = VRAM ──
    if (isAppleSilicon()) {
        return {
            gpuName: `Apple ${getAppleChipName()}`,
            vramGB: systemRamGB,
            systemRamGB,
            powerClass: classifyVRAM(systemRamGB),
        };
    }

    // ── Discrete GPU: use systeminformation ──
    try {
        const si = await import('systeminformation');
        const graphics = await si.graphics();

        // Find the controller with the most VRAM
        let bestController: { model: string; vram: number } | null = null;

        for (const ctrl of graphics.controllers) {
            const vram = ctrl.vram ?? 0;
            if (!bestController || vram > bestController.vram) {
                bestController = { model: ctrl.model ?? 'Unknown GPU', vram };
            }
        }

        if (bestController && bestController.vram > 0) {
            // systeminformation reports vram in MB
            const vramGB = Math.round(bestController.vram / 1024);
            return {
                gpuName: bestController.model,
                vramGB,
                systemRamGB,
                powerClass: classifyVRAM(vramGB),
            };
        }
    } catch {
        // systeminformation failed — fall through to RAM fallback
    }

    // ── Fallback: no GPU detected, use system RAM ──
    return {
        gpuName: 'No dedicated GPU detected',
        vramGB: 0,
        systemRamGB,
        powerClass: classifyVRAM(systemRamGB),
    };
}

