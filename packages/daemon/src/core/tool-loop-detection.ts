/**
 * @redbusagent/daemon — Tool Loop Detection (Circuit Breaker)
 *
 * Detects when the LLM is stuck in repetitive tool-call loops.
 * Inspired by openclaw's tool-loop-detection.ts.
 *
 * Three detectors:
 *  1. Generic Repeat — same tool+args called N times in a row
 *  2. Ping-Pong — alternating between two tool signatures with no progress
 *  3. Known Poll No Progress — polling tools (shell, web) with identical results
 */

import { createHash } from 'node:crypto';

// ─── Types ───────────────────────────────────────────────────────

export type LoopDetectorKind =
    | 'generic_repeat'
    | 'ping_pong'
    | 'known_poll_no_progress'
    | 'global_circuit_breaker';

export type LoopDetectionResult =
    | { stuck: false }
    | {
        stuck: true;
        level: 'warning' | 'critical';
        detector: LoopDetectorKind;
        count: number;
        message: string;
    };

export interface ToolCallHistoryEntry {
    toolName: string;
    argsHash: string;
    resultHash?: string;
}

export interface LoopDetectionConfig {
    enabled: boolean;
    /** Max history entries to track */
    historySize: number;
    /** Warn after this many identical calls */
    warningThreshold: number;
    /** Block after this many identical calls */
    criticalThreshold: number;
    /** Absolute circuit breaker regardless of detector */
    globalCircuitBreakerThreshold: number;
}

// ─── Defaults ────────────────────────────────────────────────────

const DEFAULT_CONFIG: LoopDetectionConfig = {
    enabled: true,
    historySize: 30,
    warningThreshold: 3,
    criticalThreshold: 5,
    globalCircuitBreakerThreshold: 8,
};

// ─── Known polling tools — these are expected to repeat but should show progress ──
const KNOWN_POLL_TOOLS = new Set([
    'execute_shell_command',
    'web_interact',
    'visual_inspect_page',
    'start_background_process',
]);

// ─── Hashing ─────────────────────────────────────────────────────

export function hashToolCall(toolName: string, args: unknown): string {
    const payload = JSON.stringify({ t: toolName, a: args });
    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function hashResult(result: string): string {
    return createHash('sha256').update(result).digest('hex').slice(0, 16);
}

// ─── Streak Detection ────────────────────────────────────────────

/** Count how many consecutive identical tool+args calls from the tail */
function getRepeatStreak(history: ToolCallHistoryEntry[], currentHash: string): number {
    let count = 0;
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i]!.argsHash !== currentHash) break;
        count++;
    }
    return count;
}

/** Check if results are also identical (no progress) */
function hasNoProgress(history: ToolCallHistoryEntry[], currentHash: string): boolean {
    const matching = history.filter(h => h.argsHash === currentHash && h.resultHash);
    if (matching.length < 2) return false;
    const firstResult = matching[0]!.resultHash;
    return matching.every(h => h.resultHash === firstResult);
}

/** Detect A-B-A-B ping-pong pattern */
function getPingPongStreak(history: ToolCallHistoryEntry[], currentHash: string): number {
    if (history.length < 3) return 0;
    const last = history[history.length - 1];
    if (!last || last.argsHash === currentHash) return 0; // Not alternating

    let count = 0;
    for (let i = history.length - 1; i >= 0; i--) {
        const expected = count % 2 === 0 ? last.argsHash : currentHash;
        if (history[i]!.argsHash !== expected) break;
        count++;
    }
    // Add 1 for the current call that would continue the pattern
    return count >= 2 ? count + 1 : 0;
}

// ─── Main Detector ───────────────────────────────────────────────

export function detectToolCallLoop(
    history: ToolCallHistoryEntry[],
    toolName: string,
    args: unknown,
    config: Partial<LoopDetectionConfig> = {},
): LoopDetectionResult {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    if (!cfg.enabled) return { stuck: false };

    const currentHash = hashToolCall(toolName, args);
    const repeatStreak = getRepeatStreak(history, currentHash);

    // Global circuit breaker
    if (repeatStreak >= cfg.globalCircuitBreakerThreshold) {
        return {
            stuck: true,
            level: 'critical',
            detector: 'global_circuit_breaker',
            count: repeatStreak,
            message: `CRITICAL: ${toolName} repeated ${repeatStreak} times. Circuit breaker activated.`,
        };
    }

    // Known poll tool with no progress
    const isKnownPoll = KNOWN_POLL_TOOLS.has(toolName);
    if (isKnownPoll && repeatStreak >= cfg.criticalThreshold && hasNoProgress(history, currentHash)) {
        return {
            stuck: true,
            level: 'critical',
            detector: 'known_poll_no_progress',
            count: repeatStreak,
            message: `CRITICAL: ${toolName} polled ${repeatStreak} times with identical results. Stopping.`,
        };
    }
    if (isKnownPoll && repeatStreak >= cfg.warningThreshold && hasNoProgress(history, currentHash)) {
        return {
            stuck: true,
            level: 'warning',
            detector: 'known_poll_no_progress',
            count: repeatStreak,
            message: `WARNING: ${toolName} polled ${repeatStreak} times with no progress. Consider a different approach.`,
        };
    }

    // Ping-pong detection
    const pingPongCount = getPingPongStreak(history, currentHash);
    if (pingPongCount >= cfg.criticalThreshold) {
        return {
            stuck: true,
            level: 'critical',
            detector: 'ping_pong',
            count: pingPongCount,
            message: `CRITICAL: Ping-pong loop detected (${pingPongCount} alternations). Stopping.`,
        };
    }

    // Generic repeat (non-poll tools)
    if (!isKnownPoll && repeatStreak >= cfg.criticalThreshold) {
        return {
            stuck: true,
            level: 'critical',
            detector: 'generic_repeat',
            count: repeatStreak,
            message: `CRITICAL: ${toolName} called ${repeatStreak} times with identical arguments. Stopping.`,
        };
    }
    if (!isKnownPoll && repeatStreak >= cfg.warningThreshold) {
        return {
            stuck: true,
            level: 'warning',
            detector: 'generic_repeat',
            count: repeatStreak,
            message: `WARNING: ${toolName} called ${repeatStreak} times with same arguments.`,
        };
    }

    return { stuck: false };
}

