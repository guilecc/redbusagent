/**
 * @redbusagent/daemon — Thinking & XML Tag Stream Filter
 *
 * Stateful streaming parser that intercepts and strips unwanted XML blocks
 * from LLM output:
 *   - `<thinking>...</thinking>` — internal reasoning (replaced with 💭 indicator)
 *   - `<tool_call>...</tool_call>` — raw tool call XML that leaks from some models
 *   - `<tool_code>...</tool_code>` — raw tool code fragments
 *   - Any `<tool_` prefixed tags that models sometimes output as text
 *
 * Designed to work with the incremental character-by-character streaming from
 * the AI SDK's `text-delta` events.
 *
 * Usage:
 *   const filter = createThinkingFilter(cleanDelta => broadcast(cleanDelta));
 *   // For each streaming chunk:
 *   filter.push(delta);
 *   // After stream ends:
 *   filter.flush();
 */

export interface ThinkingFilter {
    /** Feed a streaming text delta through the filter */
    push(delta: string): void;
    /** Flush any buffered content at end of stream */
    flush(): void;
    /** Whether the model is currently inside a <thinking> block */
    get isThinking(): boolean;
}

// ─── Tag Definitions to Strip ────────────────────────────────────

interface TagPair {
    /** The opening tag prefix to detect (e.g. '<thinking>') */
    open: string;
    /** The closing tag to detect (e.g. '</thinking>') */
    close: string;
    /** If true, emit an indicator when this tag is first seen */
    indicator?: string;
}

const TAGS_TO_STRIP: TagPair[] = [
    { open: '<thinking>', close: '</thinking>', indicator: '\n💭 Reasoning...\n' },
    { open: '<tool_call', close: '</tool_call>' },
    { open: '<tool_code', close: '</tool_code>' },
];

/**
 * Creates a stateful streaming filter that strips `<thinking>`, `<tool_call>`,
 * and other unwanted XML blocks from the LLM stream.
 *
 * @param emit - Called with clean text chunks (stripped content removed).
 */
export function createThinkingFilter(emit: (clean: string) => void): ThinkingFilter {
    let insideBlock = false;
    let activeCloseTag: string | null = null;
    let buffer = '';
    let emittedIndicators = new Set<string>();

    function findEarliestOpenTag(text: string): { index: number; tag: TagPair; fullOpenEnd: number } | null {
        let earliest: { index: number; tag: TagPair; fullOpenEnd: number } | null = null;

        for (const tag of TAGS_TO_STRIP) {
            const idx = text.indexOf(tag.open);
            if (idx !== -1 && (earliest === null || idx < earliest.index)) {
                // For tags like <tool_call that may have attributes (e.g. <tool_call name="...">),
                // find the closing '>' to consume the full opening tag
                let fullEnd = idx + tag.open.length;
                if (!tag.open.endsWith('>')) {
                    const closeBracket = text.indexOf('>', fullEnd);
                    fullEnd = closeBracket !== -1 ? closeBracket + 1 : -1; // -1 = incomplete
                }
                earliest = { index: idx, tag, fullOpenEnd: fullEnd };
            }
        }

        return earliest;
    }

    function couldBePartialOpenTag(text: string): boolean {
        // Check if buffer ends with something that could be the start of any tag to strip
        for (const tag of TAGS_TO_STRIP) {
            if (couldBePartialTag(text, tag.open)) return true;
        }
        return false;
    }

    function processBuffer(): void {
        while (buffer.length > 0) {
            if (insideBlock && activeCloseTag) {
                // Inside a block — look for closing tag
                const closeIdx = buffer.indexOf(activeCloseTag);
                if (closeIdx !== -1) {
                    buffer = buffer.slice(closeIdx + activeCloseTag.length);
                    insideBlock = false;
                    activeCloseTag = null;
                    continue;
                }
                // Check partial close tag
                if (couldBePartialTag(buffer, activeCloseTag)) {
                    return; // Keep buffering
                }
                // No close tag — discard content
                buffer = '';
                return;
            }

            // Not inside a block — look for any opening tag
            const match = findEarliestOpenTag(buffer);
            if (match) {
                // Emit clean text before the tag
                if (match.index > 0) {
                    emit(buffer.slice(0, match.index));
                }

                if (match.fullOpenEnd === -1) {
                    // Opening tag is incomplete (no closing '>') — buffer and wait
                    buffer = buffer.slice(match.index);
                    insideBlock = true;
                    activeCloseTag = match.tag.close;
                    return;
                }

                // Enter block suppression mode
                insideBlock = true;
                activeCloseTag = match.tag.close;
                buffer = buffer.slice(match.fullOpenEnd);

                // Emit one-time indicator if configured
                if (match.tag.indicator && !emittedIndicators.has(match.tag.open)) {
                    emit(match.tag.indicator);
                    emittedIndicators.add(match.tag.open);
                }
                continue;
            }

            // Check if buffer ends with a partial match of any open tag
            if (couldBePartialOpenTag(buffer)) {
                return; // Keep buffering
            }

            // No tag or partial — emit everything
            emit(buffer);
            buffer = '';
            return;
        }
    }

    return {
        push(delta: string): void {
            buffer += delta;
            processBuffer();
        },

        flush(): void {
            if (buffer.length > 0) {
                if (!insideBlock) {
                    emit(buffer);
                }
                buffer = '';
            }
            insideBlock = false;
            activeCloseTag = null;
            emittedIndicators = new Set();
        },

        get isThinking(): boolean {
            return insideBlock;
        },
    };
}

/**
 * Checks if `text` ends with a substring that could be the beginning of `tag`.
 * e.g. text="foo<thi" and tag="<thinking>" → true
 */
function couldBePartialTag(text: string, tag: string): boolean {
    const maxCheck = Math.min(text.length, tag.length - 1);
    for (let len = maxCheck; len >= 1; len--) {
        if (text.endsWith(tag.slice(0, len))) {
            return true;
        }
    }
    return false;
}

