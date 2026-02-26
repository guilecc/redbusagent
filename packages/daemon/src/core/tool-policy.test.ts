/**
 * Tests for Tool Policy module
 */
import { describe, it, expect } from 'vitest';
import {
    evaluateToolPolicy,
    applyToolPolicy,
    resolveSenderRole,
    requiresApproval,
} from './tool-policy.js';

describe('evaluateToolPolicy', () => {
    it('allows owner to use any tool', () => {
        expect(evaluateToolPolicy('install_mcp', 'owner').allowed).toBe(true);
        expect(evaluateToolPolicy('send_whatsapp_message', 'owner').allowed).toBe(true);
    });

    it('blocks system from owner-only tools', () => {
        const result = evaluateToolPolicy('install_mcp', 'system');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('owner-only');
    });

    it('blocks scheduled from owner-only tools', () => {
        const result = evaluateToolPolicy('send_whatsapp_message', 'scheduled');
        expect(result.allowed).toBe(false);
    });

    it('allows system to use non-restricted tools', () => {
        expect(evaluateToolPolicy('read_file', 'system').allowed).toBe(true);
        expect(evaluateToolPolicy('search_web', 'system').allowed).toBe(true);
    });
});

describe('applyToolPolicy', () => {
    it('returns all tools for owner', () => {
        const tools = { read_file: {}, install_mcp: {}, send_whatsapp_message: {} };
        const result = applyToolPolicy(tools, 'owner');
        expect(Object.keys(result)).toEqual(Object.keys(tools));
    });

    it('strips owner-only tools for system sender', () => {
        const tools = { read_file: {}, install_mcp: {}, search_web: {} };
        const result = applyToolPolicy(tools, 'system');
        expect(result).toHaveProperty('read_file');
        expect(result).toHaveProperty('search_web');
        expect(result).not.toHaveProperty('install_mcp');
    });
});

describe('resolveSenderRole', () => {
    it('returns owner for regular client IDs', () => {
        expect(resolveSenderRole('ws-client-123')).toBe('owner');
        expect(resolveSenderRole('browser')).toBe('owner');
    });

    it('returns system for system client', () => {
        expect(resolveSenderRole('system')).toBe('system');
    });

    it('returns scheduled for scheduled-* clients', () => {
        expect(resolveSenderRole('scheduled-cron-1')).toBe('scheduled');
        expect(resolveSenderRole('scheduled-task-abc')).toBe('scheduled');
    });
});

describe('requiresApproval', () => {
    it('returns boolean for any tool name', () => {
        expect(typeof requiresApproval('read_file')).toBe('boolean');
        expect(typeof requiresApproval('install_mcp')).toBe('boolean');
    });
});

