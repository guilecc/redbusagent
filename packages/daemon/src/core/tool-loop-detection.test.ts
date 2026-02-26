/**
 * Tests for Tool Loop Detection module
 */
import { describe, it, expect } from 'vitest';
import {
    detectToolCallLoop,
    hashToolCall,
    hashResult,
    type ToolCallHistoryEntry,
} from './tool-loop-detection.js';

describe('hashToolCall', () => {
    it('produces consistent hashes for same input', () => {
        const h1 = hashToolCall('read_file', { path: '/foo' });
        const h2 = hashToolCall('read_file', { path: '/foo' });
        expect(h1).toBe(h2);
    });

    it('produces different hashes for different input', () => {
        const h1 = hashToolCall('read_file', { path: '/foo' });
        const h2 = hashToolCall('read_file', { path: '/bar' });
        expect(h1).not.toBe(h2);
    });

    it('returns a 16-char hex string', () => {
        const h = hashToolCall('test', {});
        expect(h).toMatch(/^[0-9a-f]{16}$/);
    });
});

describe('hashResult', () => {
    it('produces consistent hashes', () => {
        const h1 = hashResult('some output');
        const h2 = hashResult('some output');
        expect(h1).toBe(h2);
    });

    it('returns a 16-char hex string', () => {
        const h = hashResult('test');
        expect(h).toMatch(/^[0-9a-f]{16}$/);
    });
});

describe('detectToolCallLoop', () => {
    it('returns not stuck for empty history', () => {
        const result = detectToolCallLoop([], 'read_file', { path: '/foo' });
        expect(result.stuck).toBe(false);
    });

    it('returns not stuck for few calls', () => {
        const hash = hashToolCall('read_file', { path: '/foo' });
        const history: ToolCallHistoryEntry[] = [
            { toolName: 'read_file', argsHash: hash },
            { toolName: 'read_file', argsHash: hash },
        ];
        const result = detectToolCallLoop(history, 'read_file', { path: '/foo' });
        expect(result.stuck).toBe(false);
    });

    it('detects generic repeat loop at critical threshold', () => {
        const hash = hashToolCall('read_file', { path: '/foo' });
        const history: ToolCallHistoryEntry[] = Array.from({ length: 5 }, () => ({
            toolName: 'read_file',
            argsHash: hash,
            resultHash: hashResult('same result'),
        }));
        const result = detectToolCallLoop(history, 'read_file', { path: '/foo' });
        expect(result.stuck).toBe(true);
        expect(result.level).toBe('critical');
    });

    it('detects warning level before critical', () => {
        const hash = hashToolCall('read_file', { path: '/foo' });
        const history: ToolCallHistoryEntry[] = Array.from({ length: 3 }, () => ({
            toolName: 'read_file',
            argsHash: hash,
        }));
        const result = detectToolCallLoop(history, 'read_file', { path: '/foo' });
        expect(result.stuck).toBe(true);
        expect(result.level).toBe('warning');
    });

    it('respects disabled config', () => {
        const hash = hashToolCall('read_file', { path: '/foo' });
        const history: ToolCallHistoryEntry[] = Array.from({ length: 10 }, () => ({
            toolName: 'read_file',
            argsHash: hash,
        }));
        const result = detectToolCallLoop(history, 'read_file', { path: '/foo' }, { enabled: false });
        expect(result.stuck).toBe(false);
    });

    it('detects global circuit breaker (consecutive identical hashes)', () => {
        const hash = hashToolCall('read_file', { path: '/foo' });
        // 8 consecutive identical calls → repeat streak = 8
        const history: ToolCallHistoryEntry[] = Array.from({ length: 8 }, () => ({
            toolName: 'read_file',
            argsHash: hash,
        }));
        const result = detectToolCallLoop(history, 'read_file', { path: '/foo' }, { globalCircuitBreakerThreshold: 8 });
        expect(result.stuck).toBe(true);
        expect(result.detector).toBe('global_circuit_breaker');
    });
});

