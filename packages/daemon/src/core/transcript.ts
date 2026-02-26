/**
 * @redbusagent/daemon — Transcript Logger (JSONL Audit Trail)
 *
 * Inspired by openclaw's session-files.ts pattern.
 * Appends every conversational turn (user, assistant, tool-call, tool-result)
 * as a single JSON line to per-session JSONL files.
 *
 * This is the raw, immutable audit log — Tier 0 of the two-tiered memory system.
 * The distilled knowledge lives in MEMORY.md (managed by CoreMemory).
 *
 * Improvements over v1 (aligned with openclaw):
 *  1. Per-session file rotation (transcript-<sessionId>.jsonl)
 *  2. In-memory ring buffer — avoids re-parsing the whole file on every LLM call
 *  3. Type-discriminated JSONL schema (type: message | tool-invocation | session-meta | error)
 *  4. Sensitive content redaction before writing to disk
 *  5. Duration/token metadata on tool calls
 *  6. Character-budget context window (replaces fixed 5-turn)
 *  7. Content hashing for change detection
 */

import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { existsSync, appendFileSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { Vault } from '@redbusagent/shared';

// ─── Constants ────────────────────────────────────────────────────

const TOOL_OUTPUT_MAX_CHARS = 1000;
/** Character budget for the context window injected into LLM prompts */
const CONTEXT_BUDGET_CHARS = 4000;
/** Smaller budget for Tier 1 prompts */
const CONTEXT_BUDGET_CHARS_TIER1 = 2000;
/** Max entries kept in the in-memory ring buffer */
const RING_BUFFER_SIZE = 100;

// ─── Redaction ────────────────────────────────────────────────────

/** Patterns that look like API keys, tokens, passwords, etc. */
const SENSITIVE_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
    // Generic API keys (32+ hex/base64 chars after common prefixes)
    { re: /(api[_-]?key|token|secret|password|auth|bearer)[\s:="']+[A-Za-z0-9+/=_-]{20,}/gi, replacement: '$1=[REDACTED]' },
    // AWS-style keys
    { re: /AKIA[0-9A-Z]{16}/g, replacement: '[REDACTED_AWS_KEY]' },
    // GitHub tokens
    { re: /gh[pousr]_[A-Za-z0-9_]{36,}/g, replacement: '[REDACTED_GH_TOKEN]' },
    // Slack tokens
    { re: /xox[bpras]-[A-Za-z0-9-]{10,}/g, replacement: '[REDACTED_SLACK_TOKEN]' },
];

function redactSensitive(text: string): string {
    let result = text;
    for (const { re, replacement } of SENSITIVE_PATTERNS) {
        result = result.replace(re, replacement);
    }
    return result;
}

// ─── Content Hashing ──────────────────────────────────────────────

function hashContent(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// ─── Types ────────────────────────────────────────────────────────

export type TranscriptEntryType = 'message' | 'tool-invocation' | 'session-meta' | 'error';

export interface TranscriptEntry {
    /** ISO-8601 timestamp */
    ts: string;
    /** Discriminated type for JSONL filtering (openclaw pattern) */
    type: TranscriptEntryType;
    /** Role: user | assistant | tool-call | tool-result | system */
    role: 'user' | 'assistant' | 'tool-call' | 'tool-result' | 'system';
    /** The content (truncated for tool results, redacted on disk) */
    content: string;
    /** Optional metadata */
    meta?: {
        tier?: 'tier1' | 'tier2';
        model?: string;
        toolName?: string;
        success?: boolean;
        requestId?: string;
        truncated?: boolean;
        originalLength?: number;
        /** How long a tool execution took (ms) */
        durationMs?: number;
        /** Input token count from LLM response */
        tokensIn?: number;
        /** Output token count from LLM response */
        tokensOut?: number;
        /** Structured error message on failure */
        error?: string;
        /** SHA-256 prefix hash of the content for dedup/change detection */
        hash?: string;
    };
}

/** Lightweight input type — callers don't need to supply ts, type, or hash */
export type TranscriptAppendInput = Omit<TranscriptEntry, 'ts' | 'type'> & {
    type?: TranscriptEntryType;
};

// ─── Transcript Manager ───────────────────────────────────────────

export class Transcript {
    /** Unique session ID — generated once per daemon process lifetime */
    private static _sessionId: string = generateSessionId();

    /** In-memory ring buffer of recent entries (avoids re-parsing the file) */
    private static _ringBuffer: TranscriptEntry[] = [];
    private static _coldStartLoaded = false;

    /** Returns the current session ID */
    static get sessionId(): string {
        return this._sessionId;
    }

    /** Directory where transcript files live */
    private static get transcriptDir(): string {
        const dir = join(Vault.dir, 'transcripts');
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        return dir;
    }

    /** Absolute path to the current session's JSONL file */
    static get filePath(): string {
        return join(this.transcriptDir, `transcript-${this._sessionId}.jsonl`);
    }

    /** List all session transcript files, sorted by name (newest last) */
    static listSessions(): string[] {
        try {
            return readdirSync(this.transcriptDir)
                .filter(f => f.startsWith('transcript-') && f.endsWith('.jsonl'))
                .sort()
                .map(f => join(this.transcriptDir, f));
        } catch {
            return [];
        }
    }


    /**
     * Append a single entry to the transcript JSONL file.
     * Tool outputs are automatically truncated. Content is redacted on disk.
     */
    static append(entry: TranscriptAppendInput): void {
        let content = entry.content;
        let truncated = false;
        let originalLength: number | undefined;

        // Enforce truncation on tool results
        if (entry.role === 'tool-result' && content.length > TOOL_OUTPUT_MAX_CHARS) {
            originalLength = content.length;
            content = content.substring(0, TOOL_OUTPUT_MAX_CHARS) + '\n[…truncated]';
            truncated = true;
        }

        // Infer discriminated type from role
        const type = entry.type ?? inferType(entry.role);

        const full: TranscriptEntry = {
            ts: new Date().toISOString(),
            type,
            role: entry.role,
            content: redactSensitive(content),
            meta: {
                ...entry.meta,
                ...(truncated ? { truncated, originalLength } : {}),
                hash: hashContent(content),
            },
        };

        // Write to disk
        const line = JSON.stringify(full) + '\n';
        appendFileSync(this.filePath, line, { encoding: 'utf-8', mode: 0o600 });

        // Push to ring buffer
        this._ringBuffer.push(full);
        if (this._ringBuffer.length > RING_BUFFER_SIZE) {
            this._ringBuffer.splice(0, this._ringBuffer.length - RING_BUFFER_SIZE);
        }
    }

    /** Write a session-meta entry at session start */
    static writeSessionMeta(info: Record<string, unknown>): void {
        this.append({
            role: 'system',
            type: 'session-meta',
            content: JSON.stringify(info),
            meta: { tier: 'tier1' },
        });
    }

    /**
     * Read the full transcript for the current session from disk.
     */
    static readAll(): TranscriptEntry[] {
        if (!existsSync(this.filePath)) return [];
        try {
            const raw = readFileSync(this.filePath, 'utf-8');
            return raw
                .split('\n')
                .filter(line => line.trim().length > 0)
                .map(line => JSON.parse(line) as TranscriptEntry);
        } catch {
            return [];
        }
    }

    /**
     * Loads the ring buffer from disk on cold start (process restart).
     */
    private static ensureRingBuffer(): void {
        if (this._coldStartLoaded) return;
        this._coldStartLoaded = true;
        if (this._ringBuffer.length === 0) {
            const all = this.readAll();
            this._ringBuffer = all.slice(-RING_BUFFER_SIZE);
        }
    }

    /**
     * Returns recent conversational turns fitting within a character budget.
     * Reads from the in-memory ring buffer (O(1) after cold start).
     */
    static getRecentContext(budgetChars: number = CONTEXT_BUDGET_CHARS): TranscriptEntry[] {
        this.ensureRingBuffer();
        const conversational = this._ringBuffer.filter(
            e => e.role === 'user' || e.role === 'assistant'
        );
        const result: TranscriptEntry[] = [];
        let chars = 0;
        for (let i = conversational.length - 1; i >= 0; i--) {
            const entry = conversational[i]!;
            const entryLen = entry.content.length;
            if (chars + entryLen > budgetChars && result.length > 0) break;
            result.unshift(entry);
            chars += entryLen;
        }
        return result;
    }

    /**
     * Converts recent transcript entries into AI SDK-compatible message objects.
     */
    static toMessages(entries?: TranscriptEntry[]): Array<{ role: 'user' | 'assistant'; content: string }> {
        const recent = entries ?? this.getRecentContext();
        return recent.map(e => ({
            role: e.role as 'user' | 'assistant',
            content: e.content,
        }));
    }

    /** Maximum chars for tool output truncation */
    static get toolOutputMaxChars(): number {
        return TOOL_OUTPUT_MAX_CHARS;
    }

    /** Character budget for context window */
    static get contextBudgetChars(): number {
        return CONTEXT_BUDGET_CHARS;
    }

    /** Character budget for Tier 1 context window */
    static get contextBudgetCharsTier1(): number {
        return CONTEXT_BUDGET_CHARS_TIER1;
    }
}

// ─── Helpers ─────────────────────────────────────────────────────

function generateSessionId(): string {
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const short = randomUUID().slice(0, 8);
    return `${date}-${short}`;
}

function inferType(role: string): TranscriptEntryType {
    switch (role) {
        case 'tool-call':
        case 'tool-result':
            return 'tool-invocation';
        case 'user':
        case 'assistant':
            return 'message';
        default:
            return 'message';
    }
}