/**
 * @redbusagent/daemon — ARIA Semantic Snapshot
 *
 * Port of openclaw's pw-role-snapshot.ts with full feature parity:
 * - Three-tier role system (Interactive / Content / Structural)
 * - compactTree algorithm for pruning empty structural branches
 * - e-prefixed refs (e1, e2...) for LLM clarity
 * - Interactive-only mode for efficient snapshots
 * - maxDepth limit, character budget + truncation
 * - parseRoleRef() for tolerant ref input parsing
 * - AI snapshot path (_snapshotForAI) with CDP fallback
 * - Link understanding pipeline
 */

import type { Page } from 'playwright';
import WebSocket from 'ws';

// ─── Constants ────────────────────────────────────────────────────

/** Character budget for full AI snapshots */
export const SNAPSHOT_MAX_CHARS = 80_000;
/** Character budget for efficient/compact snapshots */
export const SNAPSHOT_EFFICIENT_MAX_CHARS = 10_000;
/** Default depth limit for efficient mode */
export const SNAPSHOT_EFFICIENT_DEPTH = 6;

export const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
    'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'treeitem',
]);

export const CONTENT_ROLES = new Set([
    'heading', 'cell', 'gridcell', 'columnheader', 'rowheader',
    'listitem', 'article', 'region', 'main', 'navigation',
]);

export const STRUCTURAL_ROLES = new Set([
    'generic', 'group', 'list', 'table', 'row', 'rowgroup',
    'grid', 'treegrid', 'menu', 'menubar', 'toolbar', 'tablist',
    'tree', 'directory', 'document', 'application', 'presentation', 'none',
]);

// ─── Types ────────────────────────────────────────────────────────

export interface SemanticRef {
    role: string;
    name?: string;
    /** Index used only when role+name duplicates exist. */
    nth?: number;
}

export type RoleRefMap = Record<string, SemanticRef>;

export interface RoleSnapshotOptions {
    /** Only include interactive elements (flat list). */
    interactive?: boolean;
    /** Maximum depth to include (0 = root only). */
    maxDepth?: number;
    /** Remove unnamed structural elements and prune empty branches. */
    compact?: boolean;
}

export interface SemanticSnapshot {
    /** The compact text representation of the accessibility tree */
    text: string;
    /** Map of ref IDs (e1, e2...) to role/name for tool targeting */
    refs: RoleRefMap;
    /** Stats about the snapshot */
    stats: { lines: number; chars: number; refs: number; interactive: number };
    /** Whether the snapshot was truncated to fit character budget */
    truncated?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Get the indentation level of a snapshot line (2 spaces per level). */
export function getIndentLevel(line: string): number {
    const match = line.match(/^(\s*)/);
    return match?.[1] ? Math.floor(match[1].length / 2) : 0;
}

export function getRoleSnapshotStats(snapshot: string, refs: RoleRefMap) {
    const interactive = Object.values(refs).filter(r => INTERACTIVE_ROLES.has(r.role)).length;
    return {
        lines: snapshot.split('\n').length,
        chars: snapshot.length,
        refs: Object.keys(refs).length,
        interactive,
    };
}

// ─── Role Name Tracker ───────────────────────────────────────────

interface RoleNameTracker {
    counts: Map<string, number>;
    refsByKey: Map<string, string[]>;
    getKey(role: string, name?: string): string;
    getNextIndex(role: string, name?: string): number;
    trackRef(role: string, name: string | undefined, ref: string): void;
    getDuplicateKeys(): Set<string>;
}

function createRoleNameTracker(): RoleNameTracker {
    const counts = new Map<string, number>();
    const refsByKey = new Map<string, string[]>();
    return {
        counts,
        refsByKey,
        getKey(role: string, name?: string) {
            return `${role}:${name ?? ''}`;
        },
        getNextIndex(role: string, name?: string) {
            const key = this.getKey(role, name);
            const current = counts.get(key) ?? 0;
            counts.set(key, current + 1);
            return current;
        },
        trackRef(role: string, name: string | undefined, ref: string) {
            const key = this.getKey(role, name);
            const list = refsByKey.get(key) ?? [];
            list.push(ref);
            refsByKey.set(key, list);
        },
        getDuplicateKeys() {
            const out = new Set<string>();
            for (const [key, refs] of refsByKey) {
                if (refs.length > 1) out.add(key);
            }
            return out;
        },
    };
}

function removeNthFromNonDuplicates(refs: RoleRefMap, tracker: RoleNameTracker) {
    const duplicates = tracker.getDuplicateKeys();
    for (const [_ref, data] of Object.entries(refs)) {
        const key = tracker.getKey(data.role, data.name);
        if (!duplicates.has(key)) {
            delete refs[_ref]?.nth;
        }
    }
}


// ─── compactTree ─────────────────────────────────────────────────

/**
 * Prunes structural-only branches from the snapshot tree.
 * Keeps a line if it contains [ref=] or has text content,
 * or if any descendant has [ref=].
 */
export function compactTree(tree: string): string {
    const lines = tree.split('\n');
    const result: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // Always keep lines with refs
        if (line.includes('[ref=')) {
            result.push(line);
            continue;
        }
        // Keep lines with inline text content (colon with value after it)
        if (line.includes(':') && !line.trimEnd().endsWith(':')) {
            result.push(line);
            continue;
        }

        // For structural lines, only keep if a descendant has [ref=]
        const currentIndent = getIndentLevel(line);
        let hasRelevantChildren = false;
        for (let j = i + 1; j < lines.length; j++) {
            const childLine = lines[j]!;
            const childIndent = getIndentLevel(childLine);
            if (childIndent <= currentIndent) break;
            if (childLine.includes('[ref=')) {
                hasRelevantChildren = true;
                break;
            }
        }
        if (hasRelevantChildren) {
            result.push(line);
        }
    }

    return result.join('\n');
}

// ─── Line Processing ─────────────────────────────────────────────

function processLine(
    line: string,
    refs: RoleRefMap,
    options: RoleSnapshotOptions,
    tracker: RoleNameTracker,
    nextRef: () => string,
): string | null {
    const depth = getIndentLevel(line);
    if (options.maxDepth !== undefined && depth > options.maxDepth) {
        return null;
    }

    const match = line.match(/^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/);
    if (!match) {
        return options.interactive ? null : line;
    }

    const [, prefix, roleRaw, name, suffix] = match as RegExpMatchArray;
    if (!roleRaw || roleRaw.startsWith('/')) {
        return options.interactive ? null : line;
    }

    const role = roleRaw.toLowerCase();
    const isInteractive = INTERACTIVE_ROLES.has(role);
    const isContent = CONTENT_ROLES.has(role);
    const isStructural = STRUCTURAL_ROLES.has(role);

    if (options.interactive && !isInteractive) return null;
    if (options.compact && isStructural && !name) return null;

    // Interactive elements and named content elements get refs
    const shouldHaveRef = isInteractive || (isContent && !!name);
    if (!shouldHaveRef) return line;

    const ref = nextRef();
    const nth = tracker.getNextIndex(role, name);
    tracker.trackRef(role, name, ref);
    refs[ref] = { role, ...(name ? { name } : {}), nth };

    let enhanced = `${prefix}${roleRaw}`;
    if (name) enhanced += ` "${name}"`;
    enhanced += ` [ref=${ref}]`;
    if (nth > 0) enhanced += ` [nth=${nth}]`;
    if (suffix) enhanced += suffix;
    return enhanced;
}

// ─── Build Snapshot ──────────────────────────────────────────────

/**
 * Build a role snapshot from Playwright's ariaSnapshot() output.
 * Annotates interactive + named content elements with [ref=eN] tags.
 */
export function buildRoleSnapshotFromAriaSnapshot(
    ariaSnapshot: string,
    options: RoleSnapshotOptions = {},
): { snapshot: string; refs: RoleRefMap } {
    const lines = ariaSnapshot.split('\n');
    const refs: RoleRefMap = {};
    const tracker = createRoleNameTracker();

    let counter = 0;
    const nextRef = () => `e${++counter}`;

    if (options.interactive) {
        // Interactive-only mode: flat list of actionable elements
        const result: string[] = [];
        for (const line of lines) {
            const processed = processLine(line, refs, { ...options, interactive: true }, tracker, nextRef);
            if (processed !== null) result.push(processed);
        }
        removeNthFromNonDuplicates(refs, tracker);
        return {
            snapshot: result.join('\n') || '(no interactive elements)',
            refs,
        };
    }

    const result: string[] = [];
    for (const line of lines) {
        const processed = processLine(line, refs, options, tracker, nextRef);
        if (processed !== null) result.push(processed);
    }

    removeNthFromNonDuplicates(refs, tracker);

    const tree = result.join('\n') || '(empty)';
    return {
        snapshot: options.compact ? compactTree(tree) : tree,
        refs,
    };
}

// ─── parseRoleRef ────────────────────────────────────────────────

/**
 * Tolerant ref input parsing. Handles LLM variations:
 * "e5", "@e5", "ref=e5", " e5 " → "e5"
 * Returns null for invalid input.
 */
export function parseRoleRef(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const normalized = trimmed.startsWith('@')
        ? trimmed.slice(1)
        : trimmed.startsWith('ref=')
            ? trimmed.slice(4)
            : trimmed;
    return /^e\d+$/.test(normalized) ? normalized : null;
}

// ─── Character Budget / Truncation ───────────────────────────────

/**
 * Truncate snapshot text to fit within character budget.
 * Appends [...TRUNCATED] marker if trimmed.
 */
export function truncateSnapshot(text: string, maxChars: number): { text: string; truncated: boolean } {
    if (text.length <= maxChars) return { text, truncated: false };
    const marker = '\n[...TRUNCATED]';
    const trimmed = text.slice(0, maxChars - marker.length);
    // Cut at last complete line
    const lastNewline = trimmed.lastIndexOf('\n');
    const clean = lastNewline > 0 ? trimmed.slice(0, lastNewline) : trimmed;
    return { text: clean + marker, truncated: true };
}

// ─── CDP Fallback Types ─────────────────────────────────────────

/** Raw accessibility node from CDP Accessibility.getFullAXTree */
export type RawAXNode = {
    nodeId?: string;
    role?: { value?: string };
    name?: { value?: string };
    value?: { value?: string };
    description?: { value?: string };
    childIds?: string[];
    backendDOMNodeId?: number;
};

/** Formatted node from CDP AX tree */
export type CdpAriaNode = {
    ref: string;
    role: string;
    name: string;
    value?: string;
    description?: string;
    backendDOMNodeId?: number;
    depth: number;
};

type CdpSendFn = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** Extract string value from CDP AX property wrapper */
function axValue(v: unknown): string {
    if (!v || typeof v !== 'object') return '';
    const value = (v as { value?: unknown }).value;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
}

/**
 * Opens a CDP WebSocket, runs a callback with a send function, then closes.
 * Ported from openclaw's cdp.helpers.ts.
 */
export async function withCdpSocket<T>(
    wsUrl: string,
    fn: (send: CdpSendFn) => Promise<T>,
    opts?: { handshakeTimeoutMs?: number },
): Promise<T> {
    const handshakeTimeoutMs = opts?.handshakeTimeoutMs ?? 5000;
    const ws = new WebSocket(wsUrl, { handshakeTimeout: handshakeTimeoutMs });

    let nextId = 1;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

    const send: CdpSendFn = (method, params) => {
        const id = nextId++;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise<unknown>((resolve, reject) => {
            pending.set(id, { resolve, reject });
        });
    };

    const closeWithError = (err: Error) => {
        for (const [, p] of pending) p.reject(err);
        pending.clear();
        try { ws.close(); } catch { /* ignore */ }
    };

    ws.on('error', (err) => closeWithError(err instanceof Error ? err : new Error(String(err))));
    ws.on('message', (data) => {
        try {
            const parsed = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: { message?: string } };
            if (typeof parsed.id !== 'number') return;
            const p = pending.get(parsed.id);
            if (!p) return;
            pending.delete(parsed.id);
            if (parsed.error?.message) { p.reject(new Error(parsed.error.message)); return; }
            p.resolve(parsed.result);
        } catch { /* ignore */ }
    });
    ws.on('close', () => closeWithError(new Error('CDP socket closed')));

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', (err) => reject(err));
        ws.once('close', () => reject(new Error('CDP socket closed before open')));
    });

    try {
        return await fn(send);
    } finally {
        try { ws.close(); } catch { /* ignore */ }
    }
}

/**
 * Formats raw CDP AX nodes into a flat list with depth info and ax-prefixed refs.
 * Ported from openclaw's cdp.ts formatAriaSnapshot.
 */
export function formatCdpAriaSnapshot(nodes: RawAXNode[], limit: number): CdpAriaNode[] {
    const byId = new Map<string, RawAXNode>();
    for (const n of nodes) {
        if (n.nodeId) byId.set(n.nodeId, n);
    }

    // Find root: a node not referenced as any other node's child
    const referenced = new Set<string>();
    for (const n of nodes) {
        for (const c of n.childIds ?? []) referenced.add(c);
    }
    const root = nodes.find((n) => n.nodeId && !referenced.has(n.nodeId)) ?? nodes[0];
    if (!root?.nodeId) return [];

    const out: CdpAriaNode[] = [];
    const stack: Array<{ id: string; depth: number }> = [{ id: root.nodeId, depth: 0 }];
    while (stack.length && out.length < limit) {
        const popped = stack.pop();
        if (!popped) break;
        const { id, depth } = popped;
        const n = byId.get(id);
        if (!n) continue;

        const role = axValue(n.role);
        const name = axValue(n.name);
        const value = axValue(n.value);
        const description = axValue(n.description);
        const ref = `ax${out.length + 1}`;
        out.push({
            ref,
            role: role || 'unknown',
            name: name || '',
            ...(value ? { value } : {}),
            ...(description ? { description } : {}),
            ...(typeof n.backendDOMNodeId === 'number' ? { backendDOMNodeId: n.backendDOMNodeId } : {}),
            depth,
        });

        const children = (n.childIds ?? []).filter((c) => byId.has(c));
        // Push in reverse so first child is processed first (stack is LIFO)
        for (let i = children.length - 1; i >= 0; i--) {
            const child = children[i];
            if (child) stack.push({ id: child, depth: depth + 1 });
        }
    }
    return out;
}

/**
 * Fetches the full accessibility tree via CDP's Accessibility.getFullAXTree.
 * This is the last-resort fallback when Playwright's ariaSnapshot APIs fail.
 */
export async function snapshotAriaCdp(opts: {
    wsUrl: string;
    limit?: number;
}): Promise<{ nodes: CdpAriaNode[] }> {
    const limit = Math.max(1, Math.min(2000, Math.floor(opts.limit ?? 500)));
    return await withCdpSocket(opts.wsUrl, async (send) => {
        await (send('Accessibility.enable') as Promise<unknown>).catch(() => { });
        const res = (await send('Accessibility.getFullAXTree')) as { nodes?: RawAXNode[] };
        const nodes = Array.isArray(res?.nodes) ? res.nodes : [];
        return { nodes: formatCdpAriaSnapshot(nodes, limit) };
    });
}

/**
 * Converts CDP AX nodes into the same text format as Playwright's ariaSnapshot,
 * so it can be fed into buildRoleSnapshotFromAriaSnapshot.
 */
export function cdpNodesToAriaText(nodes: CdpAriaNode[]): string {
    return nodes.map(n => {
        const indent = '  '.repeat(n.depth);
        let line = `${indent}- ${n.role}`;
        if (n.name) line += ` "${n.name}"`;
        if (n.value) line += `: ${n.value}`;
        return line;
    }).join('\n');
}

// ─── Main Capture Function ───────────────────────────────────────

/**
 * Captures a semantic snapshot of the page's accessibility tree.
 * Three-tier fallback strategy:
 *   1. _snapshotForAI (private Playwright API)
 *   2. locator.ariaSnapshot() (standard Playwright)
 *   3. CDP Accessibility.getFullAXTree (raw WebSocket fallback)
 */
export async function captureSemanticSnapshot(
    page: Page,
    options: RoleSnapshotOptions & { maxChars?: number; cdpWsUrl?: string } = {},
): Promise<SemanticSnapshot> {
    const maxChars = options.maxChars ?? SNAPSHOT_MAX_CHARS;

    try {
        // Tier 1: Try private Playwright _snapshotForAI API first
        let rawSnapshot: string | undefined;

        try {
            const mainFrame = page.mainFrame();
            if (typeof (mainFrame as any)._snapshotForAI === 'function') {
                rawSnapshot = await (mainFrame as any)._snapshotForAI();
            }
        } catch {
            // _snapshotForAI not available, fall through
        }

        // Tier 2: standard ariaSnapshot() API
        if (!rawSnapshot) {
            try {
                rawSnapshot = await page.locator(':root').ariaSnapshot();
            } catch {
                // ariaSnapshot failed, fall through to CDP
            }
        }

        // Tier 3: CDP fallback via Accessibility.getFullAXTree
        if (!rawSnapshot && options.cdpWsUrl) {
            try {
                const { nodes } = await snapshotAriaCdp({ wsUrl: options.cdpWsUrl });
                if (nodes.length > 0) {
                    rawSnapshot = cdpNodesToAriaText(nodes);
                }
            } catch {
                // CDP fallback also failed
            }
        }

        if (!rawSnapshot || rawSnapshot.trim().length === 0) {
            return {
                text: '(empty page — no accessibility tree)',
                refs: {},
                stats: { lines: 1, chars: 40, refs: 0, interactive: 0 },
            };
        }

        // Build annotated snapshot with role processing
        const { snapshot, refs } = buildRoleSnapshotFromAriaSnapshot(rawSnapshot, {
            compact: options.compact ?? true,
            interactive: options.interactive,
            maxDepth: options.maxDepth,
        });

        // Apply character budget
        const { text, truncated } = truncateSnapshot(snapshot, maxChars);
        const stats = getRoleSnapshotStats(text, refs);

        return { text, refs, stats, truncated };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
            text: `(aria snapshot failed: ${errMsg})`,
            refs: {},
            stats: { lines: 1, chars: 50, refs: 0, interactive: 0 },
        };
    }
}