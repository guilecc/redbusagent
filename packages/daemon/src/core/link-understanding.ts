/**
 * @redbusagent/daemon — Link Understanding
 *
 * Port of openclaw's link-understanding pipeline:
 * - Detects URLs in user messages (bare + markdown)
 * - Fetches page content via lightweight HTTP
 * - Formats output for LLM context injection
 */

// ─── Constants ────────────────────────────────────────────────────

export const DEFAULT_MAX_LINKS = 3;
export const DEFAULT_LINK_TIMEOUT_MS = 30_000;
/** Max characters to keep from fetched page content */
export const MAX_CONTENT_CHARS = 8_000;

// ─── URL Detection ───────────────────────────────────────────────

/** Matches markdown link syntax: [text](url) */
const MARKDOWN_LINK_RE = /\[[^\]]*]\((https?:\/\/\S+?)\)/gi;
/** Matches bare http(s) URLs */
const BARE_LINK_RE = /https?:\/\/\S+/gi;

/** Strips markdown links so we only detect bare URLs (avoids double-counting) */
function stripMarkdownLinks(message: string): string {
    return message.replace(MARKDOWN_LINK_RE, ' ');
}

/** Checks if a URL is safe to fetch (http/https only, no localhost) */
function isAllowedUrl(raw: string): boolean {
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
        // Block localhost / loopback
        const host = parsed.hostname.toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return false;
        return true;
    } catch {
        return false;
    }
}

/**
 * Extracts unique URLs from a user message.
 * Handles both bare URLs and markdown link syntax.
 * Returns up to `maxLinks` unique, allowed URLs.
 */
export function extractLinksFromMessage(message: string, opts?: { maxLinks?: number }): string[] {
    const source = message?.trim();
    if (!source) return [];

    const maxLinks = (typeof opts?.maxLinks === 'number' && opts.maxLinks > 0)
        ? Math.floor(opts.maxLinks)
        : DEFAULT_MAX_LINKS;

    const sanitized = stripMarkdownLinks(source);
    const seen = new Set<string>();
    const results: string[] = [];

    for (const match of sanitized.matchAll(BARE_LINK_RE)) {
        const raw = match[0]?.trim();
        if (!raw || !isAllowedUrl(raw) || seen.has(raw)) continue;
        seen.add(raw);
        results.push(raw);
        if (results.length >= maxLinks) break;
    }

    return results;
}

// ─── Content Fetching ────────────────────────────────────────────

/**
 * Fetches a URL and extracts a text summary for LLM context.
 * Uses lightweight fetch with timeout; extracts text from HTML.
 */
export async function fetchLinkContent(url: string, opts?: { timeoutMs?: number }): Promise<string | null> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_LINK_TIMEOUT_MS;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
        const res = await fetch(url, {
            signal: ctrl.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; RedbusAgent/1.0)',
                'Accept': 'text/html, text/plain, application/json',
            },
        });
        if (!res.ok) return null;

        const contentType = res.headers.get('content-type') ?? '';
        const body = await res.text();

        if (contentType.includes('application/json')) {
            // JSON: return truncated pretty-print
            try {
                const parsed = JSON.parse(body);
                const pretty = JSON.stringify(parsed, null, 2);
                return pretty.slice(0, MAX_CONTENT_CHARS);
            } catch {
                return body.slice(0, MAX_CONTENT_CHARS);
            }
        }

        // HTML: strip tags and extract text
        const text = stripHtmlTags(body);
        return text.slice(0, MAX_CONTENT_CHARS) || null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** Strips HTML tags and collapses whitespace for text extraction */
function stripHtmlTags(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

// ─── Formatting ──────────────────────────────────────────────────

/** Appends link understanding outputs to the user message body */
export function formatLinkUnderstandingBody(params: { body?: string; outputs: string[] }): string {
    const outputs = params.outputs.map(o => o.trim()).filter(Boolean);
    if (outputs.length === 0) return params.body ?? '';
    const base = (params.body ?? '').trim();
    if (!base) return outputs.join('\n');
    return `${base}\n\n${outputs.join('\n')}`;
}

// ─── Runner ──────────────────────────────────────────────────────

export type LinkUnderstandingResult = {
    urls: string[];
    outputs: string[];
};

/**
 * Main entry point: detects URLs in a message, fetches their content,
 * and returns structured results for LLM context injection.
 */
export async function runLinkUnderstanding(message: string, opts?: {
    maxLinks?: number;
    timeoutMs?: number;
}): Promise<LinkUnderstandingResult> {
    const urls = extractLinksFromMessage(message, { maxLinks: opts?.maxLinks });
    if (urls.length === 0) return { urls: [], outputs: [] };

    const outputs: string[] = [];
    for (const url of urls) {
        const content = await fetchLinkContent(url, { timeoutMs: opts?.timeoutMs });
        if (content) {
            outputs.push(`[Link: ${url}]\n${content}`);
        }
    }

    return { urls, outputs };
}

