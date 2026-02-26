/**
 * Tests for the Transcript class (Two-Tiered Memory System — Step 1)
 *
 * Covers:
 *  - Session ID generation & file pathing
 *  - Sensitive content redaction
 *  - Tool output truncation
 *  - Ring buffer behavior
 *  - Character-budget context retrieval
 *  - Type-discriminated schema inference
 *  - Content hashing
 *  - Session meta entries
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock Vault.dir to use a temp directory
let tempDir: string;

vi.mock('@redbusagent/shared', () => ({
    Vault: {
        get dir() {
            return tempDir;
        },
    },
}));

// Import AFTER mock is set up
const { Transcript } = await import('./transcript.js');
type TranscriptEntry = import('./transcript.js').TranscriptEntry;

describe('Transcript', () => {
    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'transcript-test-'));
        // Reset static state between tests
        (Transcript as any)._ringBuffer = [];
        (Transcript as any)._coldStartLoaded = false;
        // Generate a fresh session ID
        (Transcript as any)._sessionId = `test-${Date.now()}`;
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    // ─── Session ID ──────────────────────────────────────────────
    describe('sessionId', () => {
        it('returns a non-empty string', () => {
            const id = Transcript.sessionId;
            expect(id).toBeTruthy();
            expect(typeof id).toBe('string');
        });

        it('filePath includes the session ID', () => {
            (Transcript as any)._sessionId = '20260226-abcd1234';
            expect(Transcript.filePath).toContain('transcript-20260226-abcd1234.jsonl');
        });
    });

    // ─── Append & Schema ─────────────────────────────────────────
    describe('append', () => {
        it('writes a JSONL line to disk with correct schema', () => {
            Transcript.append({ role: 'user', content: 'Hello world' });
            const raw = readFileSync(Transcript.filePath, 'utf-8').trim();
            const entry = JSON.parse(raw) as TranscriptEntry;

            expect(entry.ts).toBeTruthy();
            expect(entry.type).toBe('message');
            expect(entry.role).toBe('user');
            expect(entry.content).toBe('Hello world');
            expect(entry.meta?.hash).toBeTruthy();
            expect(entry.meta!.hash!.length).toBe(16); // SHA-256 prefix
        });

        it('infers type "tool-invocation" for tool-call role', () => {
            Transcript.append({ role: 'tool-call', content: 'calling foo' });
            const entries = Transcript.readAll();
            expect(entries[0]!.type).toBe('tool-invocation');
        });

        it('infers type "tool-invocation" for tool-result role', () => {
            Transcript.append({ role: 'tool-result', content: 'result' });
            const entries = Transcript.readAll();
            expect(entries[0]!.type).toBe('tool-invocation');
        });

        it('allows explicit type override', () => {
            Transcript.append({ role: 'system', type: 'error', content: 'boom' });
            const entries = Transcript.readAll();
            expect(entries[0]!.type).toBe('error');
        });
    });

    // ─── Truncation ──────────────────────────────────────────────
    describe('tool output truncation', () => {
        it('truncates tool-result content exceeding max chars', () => {
            const longContent = 'x'.repeat(2000);
            Transcript.append({ role: 'tool-result', content: longContent });
            const entries = Transcript.readAll();
            const entry = entries[0]!;

            expect(entry.content.length).toBeLessThan(longContent.length);
            expect(entry.content).toContain('[…truncated]');
            expect(entry.meta?.truncated).toBe(true);
            expect(entry.meta?.originalLength).toBe(2000);
        });

        it('does not truncate short tool-result content', () => {
            Transcript.append({ role: 'tool-result', content: 'short' });
            const entries = Transcript.readAll();
            expect(entries[0]!.content).toBe('short');
            expect(entries[0]!.meta?.truncated).toBeUndefined();
        });
    });

    // ─── Redaction ───────────────────────────────────────────────
    describe('sensitive content redaction', () => {
        it('redacts API key patterns', () => {
            const fakeKey = 'sk_' + 'live' + '_' + 'a1b2c3d4e5f6g7h8i9j0k1l2m3';
            Transcript.append({ role: 'user', content: `my api_key="${fakeKey}"` });
            const entries = Transcript.readAll();
            expect(entries[0]!.content).toContain('[REDACTED]');
            expect(entries[0]!.content).not.toContain(fakeKey);
        });

        it('redacts AWS-style keys', () => {
            Transcript.append({ role: 'user', content: 'key is AKIAIOSFODNN7EXAMPLE' });
            const entries = Transcript.readAll();
            expect(entries[0]!.content).toContain('[REDACTED_AWS_KEY]');
        });

        it('redacts GitHub tokens', () => {
            Transcript.append({ role: 'user', content: 'use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl please' });
            const entries = Transcript.readAll();
            expect(entries[0]!.content).toContain('[REDACTED_GH_TOKEN]');
        });

        it('redacts Slack tokens', () => {
            Transcript.append({ role: 'user', content: 'slack: xoxb-1234567890-abcdefghij' });
            const entries = Transcript.readAll();
            expect(entries[0]!.content).toContain('[REDACTED_SLACK_TOKEN]');
        });
    });

    // ─── Ring Buffer ─────────────────────────────────────────────
    describe('ring buffer', () => {
        it('keeps entries in memory after append', () => {
            Transcript.append({ role: 'user', content: 'msg1' });
            Transcript.append({ role: 'assistant', content: 'msg2' });
            const ctx = Transcript.getRecentContext(10000);
            expect(ctx.length).toBe(2);
        });

        it('cold-start loads from disk when buffer is empty', () => {
            Transcript.append({ role: 'user', content: 'persisted' });
            // Simulate cold start
            (Transcript as any)._ringBuffer = [];
            (Transcript as any)._coldStartLoaded = false;
            const ctx = Transcript.getRecentContext(10000);
            expect(ctx.length).toBe(1);
            expect(ctx[0]!.content).toBe('persisted');
        });
    });

    // ─── Character-Budget Context ────────────────────────────────
    describe('getRecentContext', () => {
        it('respects character budget', () => {
            // Each message is 100 chars
            const msg = 'a'.repeat(100);
            for (let i = 0; i < 10; i++) {
                Transcript.append({ role: i % 2 === 0 ? 'user' : 'assistant', content: msg });
            }
            // Budget of 350 chars should fit 3 messages (300 chars), not 4 (400)
            const ctx = Transcript.getRecentContext(350);
            expect(ctx.length).toBe(3);
        });

        it('always includes at least one entry even if over budget', () => {
            Transcript.append({ role: 'user', content: 'a'.repeat(5000) });
            const ctx = Transcript.getRecentContext(100);
            expect(ctx.length).toBe(1);
        });

        it('only includes user and assistant roles', () => {
            Transcript.append({ role: 'user', content: 'hello' });
            Transcript.append({ role: 'tool-call', content: 'calling' });
            Transcript.append({ role: 'tool-result', content: 'result' });
            Transcript.append({ role: 'assistant', content: 'world' });
            const ctx = Transcript.getRecentContext(10000);
            expect(ctx.length).toBe(2);
            expect(ctx[0]!.role).toBe('user');
            expect(ctx[1]!.role).toBe('assistant');
        });
    });

    // ─── Session Meta ────────────────────────────────────────────
    describe('writeSessionMeta', () => {
        it('writes a session-meta entry', () => {
            Transcript.writeSessionMeta({ version: '0.1.0', startedAt: '2026-02-26' });
            const entries = Transcript.readAll();
            expect(entries.length).toBe(1);
            expect(entries[0]!.type).toBe('session-meta');
            expect(entries[0]!.role).toBe('system');
            const parsed = JSON.parse(entries[0]!.content);
            expect(parsed.version).toBe('0.1.0');
        });
    });

    // ─── toMessages ──────────────────────────────────────────────
    describe('toMessages', () => {
        it('converts entries to AI SDK message format', () => {
            Transcript.append({ role: 'user', content: 'hi' });
            Transcript.append({ role: 'assistant', content: 'hello' });
            const msgs = Transcript.toMessages();
            expect(msgs).toEqual([
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: 'hello' },
            ]);
        });
    });

    // ─── listSessions ────────────────────────────────────────────
    describe('listSessions', () => {
        it('returns the current session file', () => {
            Transcript.append({ role: 'user', content: 'test' });
            const sessions = Transcript.listSessions();
            expect(sessions.length).toBeGreaterThanOrEqual(1);
            expect(sessions.some(s => s.endsWith('.jsonl'))).toBe(true);
        });
    });
});

