/**
 * @redbusagent/daemon — Transcript Repair
 *
 * Inspired by openclaw's session-transcript-repair.ts.
 * Ensures tool-use/tool-result parity (required by Anthropic APIs)
 * and strips large payloads before context window evaluation.
 */

// ─── Types ───────────────────────────────────────────────────────

export interface ConversationMessage {
    role: string;
    content: string | Array<{ type: string; [key: string]: unknown }>;
    [key: string]: unknown;
}

export interface RepairReport {
    messages: ConversationMessage[];
    syntheticResultsAdded: number;
    orphanResultsDropped: number;
    payloadsTrimmed: number;
}

// ─── Constants ──────────────────────────────────────────────────

const MAX_TOOL_RESULT_CHARS = 3_000;
const SYNTHETIC_ERROR_TEXT = '[redbusagent] Missing tool result — inserted synthetic error for transcript repair.';

// ─── Payload Stripping ──────────────────────────────────────────

/**
 * Trim oversized tool result payloads to prevent context window bloat.
 * Preserves the first and last portions of the result for context.
 */
export function stripLargePayloads(
    messages: ConversationMessage[],
    maxChars = MAX_TOOL_RESULT_CHARS,
): { messages: ConversationMessage[]; trimmed: number } {
    let trimmed = 0;
    const out: ConversationMessage[] = [];

    for (const msg of messages) {
        if (msg.role === 'tool' || msg.role === 'tool-result') {
            if (typeof msg.content === 'string' && msg.content.length > maxChars) {
                const half = Math.floor(maxChars / 2);
                const truncated = msg.content.slice(0, half) +
                    `\n\n[...truncated ${msg.content.length - maxChars} chars...]\n\n` +
                    msg.content.slice(-half);
                out.push({ ...msg, content: truncated });
                trimmed++;
                continue;
            }
        }
        out.push(msg);
    }

    return { messages: trimmed > 0 ? out : messages, trimmed };
}

// ─── Tool-Use / Tool-Result Parity Repair ───────────────────────

/**
 * Ensures every assistant tool_use block is followed by a matching tool_result.
 * Anthropic APIs reject transcripts with unpaired tool calls.
 *
 * This operates on the simplified message format used by Vercel AI SDK's
 * `messages` array (role: 'assistant' with tool_use content blocks,
 * followed by role: 'tool' results).
 */
export function repairToolUseResultPairing(
    messages: ConversationMessage[],
): RepairReport {
    let syntheticResultsAdded = 0;
    let orphanResultsDropped = 0;
    const out: ConversationMessage[] = [];

    // Track tool call IDs that need results
    const pendingToolCallIds = new Set<string>();

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!;

        // Extract tool_use IDs from assistant messages with content blocks
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            const toolUseBlocks = (msg.content as Array<{ type: string; id?: string }>)
                .filter(b => b.type === 'tool_use' || b.type === 'tool-call');

            for (const block of toolUseBlocks) {
                if (block.id) pendingToolCallIds.add(block.id);
            }
            out.push(msg);

            // Check if next message(s) provide results
            // If not, insert synthetic results
            const nextMsg = messages[i + 1];
            if (toolUseBlocks.length > 0 && (!nextMsg || nextMsg.role !== 'tool')) {
                for (const block of toolUseBlocks) {
                    if (block.id && pendingToolCallIds.has(block.id)) {
                        out.push({
                            role: 'tool',
                            content: SYNTHETIC_ERROR_TEXT,
                            tool_call_id: block.id,
                        });
                        pendingToolCallIds.delete(block.id);
                        syntheticResultsAdded++;
                    }
                }
            }
            continue;
        }

        // Tool results: check they match a pending call
        if (msg.role === 'tool' && typeof msg['tool_call_id'] === 'string') {
            if (pendingToolCallIds.has(msg['tool_call_id'])) {
                pendingToolCallIds.delete(msg['tool_call_id']);
                out.push(msg);
            } else {
                // Orphan result — no matching tool call
                orphanResultsDropped++;
            }
            continue;
        }

        out.push(msg);
    }

    const payloadStrip = stripLargePayloads(out);

    return {
        messages: payloadStrip.messages,
        syntheticResultsAdded,
        orphanResultsDropped,
        payloadsTrimmed: payloadStrip.trimmed,
    };
}

