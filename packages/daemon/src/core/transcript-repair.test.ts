/**
 * Tests for Transcript Repair module
 */
import { describe, it, expect } from 'vitest';
import {
    stripLargePayloads,
    repairToolUseResultPairing,
    type ConversationMessage,
} from './transcript-repair.js';

describe('stripLargePayloads', () => {
    it('leaves short payloads untouched', () => {
        const msgs: ConversationMessage[] = [
            { role: 'tool', content: 'short result' },
            { role: 'user', content: 'hello' },
        ];
        const { messages, trimmed } = stripLargePayloads(msgs);
        expect(trimmed).toBe(0);
        expect(messages).toBe(msgs); // reference equality when no changes
    });

    it('truncates large tool results', () => {
        const largeContent = 'x'.repeat(10_000);
        const msgs: ConversationMessage[] = [
            { role: 'tool', content: largeContent },
        ];
        const { messages, trimmed } = stripLargePayloads(msgs, 3000);
        expect(trimmed).toBe(1);
        expect((messages[0]!.content as string).length).toBeLessThan(largeContent.length);
        expect(messages[0]!.content).toContain('truncated');
    });

    it('does not truncate non-tool messages', () => {
        const msgs: ConversationMessage[] = [
            { role: 'user', content: 'x'.repeat(10_000) },
        ];
        const { trimmed } = stripLargePayloads(msgs, 3000);
        expect(trimmed).toBe(0);
    });
});

describe('repairToolUseResultPairing', () => {
    it('passes through well-formed conversations', () => {
        const msgs: ConversationMessage[] = [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi there' },
        ];
        const report = repairToolUseResultPairing(msgs);
        expect(report.syntheticResultsAdded).toBe(0);
        expect(report.orphanResultsDropped).toBe(0);
        expect(report.messages).toHaveLength(2);
    });

    it('inserts synthetic result for unpaired tool_use', () => {
        const msgs: ConversationMessage[] = [
            { role: 'user', content: 'read my file' },
            {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'call_123', name: 'read_file', input: {} }],
            },
            // Missing tool result!
            { role: 'user', content: 'what happened?' },
        ];
        const report = repairToolUseResultPairing(msgs);
        expect(report.syntheticResultsAdded).toBe(1);
        // The synthetic result should be inserted after the assistant message
        const toolResultIdx = report.messages.findIndex(m => m.role === 'tool');
        expect(toolResultIdx).toBeGreaterThan(0);
        expect(report.messages[toolResultIdx]!.content).toContain('synthetic error');
    });

    it('drops orphan tool results', () => {
        const msgs: ConversationMessage[] = [
            { role: 'user', content: 'hello' },
            { role: 'tool', content: 'some result', tool_call_id: 'nonexistent_id' },
            { role: 'assistant', content: 'ok' },
        ];
        const report = repairToolUseResultPairing(msgs);
        expect(report.orphanResultsDropped).toBe(1);
        expect(report.messages.find(m => m.role === 'tool')).toBeUndefined();
    });

    it('keeps valid tool-use / tool-result pairs', () => {
        const msgs: ConversationMessage[] = [
            {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: {} }],
            },
            { role: 'tool', content: 'file contents here', tool_call_id: 'call_1' },
        ];
        const report = repairToolUseResultPairing(msgs);
        expect(report.syntheticResultsAdded).toBe(0);
        expect(report.orphanResultsDropped).toBe(0);
        expect(report.messages).toHaveLength(2);
    });
});

