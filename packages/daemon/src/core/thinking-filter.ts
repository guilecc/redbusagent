/**
 * @redbusagent/daemon — Thinking Tag Stream Filter
 *
 * Stateful streaming parser that intercepts `<thinking>...</thinking>` XML blocks
 * from LLM output, stripping raw XML and replacing it with an elegant indicator.
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

/**
 * Creates a stateful streaming filter that strips `<thinking>` blocks.
 *
 * @param emit - Called with clean text chunks (thinking content removed).
 *               The indicator `💭 Reasoning...\n` is emitted once when
 *               a thinking block opens.
 */
export function createThinkingFilter(emit: (clean: string) => void): ThinkingFilter {
    let insideThinking = false;
    let buffer = '';
    let emittedIndicator = false;

    // Possible partial tag fragments we need to buffer
    const OPEN_TAG = '<thinking>';
    const CLOSE_TAG = '</thinking>';

    function processBuffer(): void {
        while (buffer.length > 0) {
            if (insideThinking) {
                // Look for closing tag
                const closeIdx = buffer.indexOf(CLOSE_TAG);
                if (closeIdx !== -1) {
                    // End of thinking block — discard content, consume tag
                    buffer = buffer.slice(closeIdx + CLOSE_TAG.length);
                    insideThinking = false;
                    continue;
                }
                // Check if buffer ends with a partial match of </thinking>
                if (couldBePartialTag(buffer, CLOSE_TAG)) {
                    // Keep buffering — might complete next push
                    return;
                }
                // No close tag or partial — discard thinking content
                buffer = '';
                return;
            }

            // Not inside thinking — look for opening tag
            const openIdx = buffer.indexOf(OPEN_TAG);
            if (openIdx !== -1) {
                // Emit everything before the tag
                if (openIdx > 0) {
                    emit(buffer.slice(0, openIdx));
                }
                // Enter thinking mode
                insideThinking = true;
                buffer = buffer.slice(openIdx + OPEN_TAG.length);
                // Emit a one-time indicator
                if (!emittedIndicator) {
                    emit('\n💭 Reasoning...\n');
                    emittedIndicator = true;
                }
                continue;
            }

            // Check if buffer ends with a partial match of <thinking>
            if (couldBePartialTag(buffer, OPEN_TAG)) {
                // Keep the potential partial tag in the buffer
                return;
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
                if (!insideThinking) {
                    // Emit any remaining buffered text
                    emit(buffer);
                }
                buffer = '';
            }
            insideThinking = false;
            emittedIndicator = false;
        },

        get isThinking(): boolean {
            return insideThinking;
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

