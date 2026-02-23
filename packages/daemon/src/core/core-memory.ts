/**
 * @redbusagent/daemon — Core Working Memory (MemGPT-style Tier 0)
 *
 * Manages a condensed, continuously updated text file (`core-memory.md`)
 * that holds the highly compressed summary of the user's current goals,
 * active context, and critical facts.
 *
 * This file is automatically injected into EVERY system prompt (both tiers),
 * eliminating the need for the LLM to actively decide to call search_memory.
 *
 * Max size: ~1000 tokens ≈ 4000 characters. The Heartbeat Compressor
 * periodically reviews and compresses this file using Tier 1.
 */

import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Vault } from '@redbusagent/shared';

// ─── Constants ────────────────────────────────────────────────────

const CORE_MEMORY_FILENAME = 'core-memory.md';
const MAX_CHARS = 4000; // ~1000 tokens

// ─── Core Memory Manager ─────────────────────────────────────────

export class CoreMemory {
    /** Absolute path to the core-memory.md file */
    static get filePath(): string {
        const dir = Vault.dir;
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        return join(dir, CORE_MEMORY_FILENAME);
    }

    /**
     * Initialize the core memory file with a default template if it doesn't exist.
     */
    static ensureFile(): void {
        if (!existsSync(this.filePath)) {
            const defaultContent = `# Core Working Memory
## Active Goals
- (none yet)

## User Context
- (waiting for first interaction)

## Critical Facts
- (none captured yet)

## Active Tasks
- (idle)
`;
            writeFileSync(this.filePath, defaultContent, { encoding: 'utf-8', mode: 0o600 });
            console.log('  🧠 CoreMemory: Initialized core-memory.md');
        }
    }

    /**
     * Read the current core memory contents.
     * Returns empty string if file doesn't exist yet.
     */
    static read(): string {
        if (!existsSync(this.filePath)) {
            return '';
        }
        try {
            return readFileSync(this.filePath, 'utf-8');
        } catch {
            return '';
        }
    }

    /**
     * Fully replace the core memory contents.
     * Enforces the max character limit by truncating if necessary.
     * Used by the `core_memory_replace` tool and the Heartbeat Compressor.
     */
    static replace(newContent: string): { success: boolean; charCount: number; truncated: boolean } {
        let truncated = false;
        let content = newContent;

        if (content.length > MAX_CHARS) {
            // Find the last complete line before the limit
            const cutoff = content.lastIndexOf('\n', MAX_CHARS);
            content = cutoff > 0 ? content.substring(0, cutoff) : content.substring(0, MAX_CHARS);
            content += '\n\n[⚠️ TRUNCATED — exceeds 1000 token limit]';
            truncated = true;
        }

        writeFileSync(this.filePath, content, { encoding: 'utf-8', mode: 0o600 });
        console.log(`  🧠 CoreMemory: Updated (${content.length} chars${truncated ? ', truncated' : ''})`);

        return { success: true, charCount: content.length, truncated };
    }

    /**
     * Append a fact to the core memory. If the result exceeds max size,
     * it signals that compression is needed.
     */
    static append(fact: string): { success: boolean; needsCompression: boolean } {
        const current = this.read();
        const updated = current + '\n' + fact;
        const needsCompression = updated.length > MAX_CHARS;

        if (!needsCompression) {
            writeFileSync(this.filePath, updated, { encoding: 'utf-8', mode: 0o600 });
        } else {
            // Write it anyway but flag compression needed
            writeFileSync(this.filePath, updated, { encoding: 'utf-8', mode: 0o600 });
        }

        return { success: true, needsCompression };
    }

    /**
     * Returns the size info for monitoring and heartbeat decisions.
     */
    static getStats(): { exists: boolean; charCount: number; percentFull: number } {
        if (!existsSync(this.filePath)) {
            return { exists: false, charCount: 0, percentFull: 0 };
        }
        const content = this.read();
        return {
            exists: true,
            charCount: content.length,
            percentFull: Math.round((content.length / MAX_CHARS) * 100),
        };
    }

    /** Maximum allowed characters */
    static get maxChars(): number {
        return MAX_CHARS;
    }
}
