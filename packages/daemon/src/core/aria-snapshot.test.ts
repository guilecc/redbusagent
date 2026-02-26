import { describe, it, expect } from 'vitest';
import {
    buildRoleSnapshotFromAriaSnapshot,
    compactTree,
    parseRoleRef,
    truncateSnapshot,
    getIndentLevel,
    getRoleSnapshotStats,
    INTERACTIVE_ROLES,
    CONTENT_ROLES,
    STRUCTURAL_ROLES,
    formatCdpAriaSnapshot,
    cdpNodesToAriaText,
    type RawAXNode,
} from './aria-snapshot.js';
import {
    extractLinksFromMessage,
    formatLinkUnderstandingBody,
} from './link-understanding.js';

// ─── Sample ARIA snapshot (mimics Playwright ariaSnapshot() output) ───
const SAMPLE_SNAPSHOT = `- document:
  - navigation "Main":
    - list:
      - listitem:
        - link "Home"
      - listitem:
        - link "About"
  - main:
    - heading "Welcome" [level=1]
    - group:
      - generic:
        - textbox "Email"
        - textbox "Password"
        - button "Sign In"
        - button "Sign In"
    - region "Content":
      - article "First Post":
        - heading "Hello World" [level=2]
        - paragraph: Some text here
      - article "Second Post":
        - heading "Another Post" [level=2]`;

describe('getIndentLevel', () => {
    it('returns 0 for no indent', () => {
        expect(getIndentLevel('- document:')).toBe(0);
    });
    it('returns correct level for indented lines', () => {
        expect(getIndentLevel('  - heading "X"')).toBe(1);
        expect(getIndentLevel('    - button "Y"')).toBe(2);
        expect(getIndentLevel('      - link "Z"')).toBe(3);
    });
});

describe('buildRoleSnapshotFromAriaSnapshot', () => {
    it('assigns e-prefixed refs to interactive elements', () => {
        const { refs, snapshot } = buildRoleSnapshotFromAriaSnapshot(SAMPLE_SNAPSHOT);
        // All refs should be e-prefixed
        for (const key of Object.keys(refs)) {
            expect(key).toMatch(/^e\d+$/);
        }
        expect(snapshot).toContain('[ref=e');
    });

    it('assigns refs to named content elements (headings, articles, regions)', () => {
        const { refs } = buildRoleSnapshotFromAriaSnapshot(SAMPLE_SNAPSHOT);
        const roles = Object.values(refs).map(r => r.role);
        expect(roles).toContain('heading');
        expect(roles).toContain('article');
        expect(roles).toContain('region');
    });

    it('assigns refs to links and buttons', () => {
        const { refs } = buildRoleSnapshotFromAriaSnapshot(SAMPLE_SNAPSHOT);
        const roles = Object.values(refs).map(r => r.role);
        expect(roles).toContain('link');
        expect(roles).toContain('button');
        expect(roles).toContain('textbox');
    });

    it('adds [nth=N] only for duplicates', () => {
        const { snapshot, refs } = buildRoleSnapshotFromAriaSnapshot(SAMPLE_SNAPSHOT);
        // "Sign In" button appears twice → should have nth on second
        const signInRefs = Object.values(refs).filter(r => r.role === 'button' && r.name === 'Sign In');
        expect(signInRefs.length).toBe(2);
        // One should have nth=0 (removed as non-dup would remove it, but both are dups)
        expect(signInRefs.some(r => r.nth === 0)).toBe(true);
        expect(signInRefs.some(r => r.nth === 1)).toBe(true);
        expect(snapshot).toContain('[nth=1]');
    });

    it('removes nth from non-duplicate refs', () => {
        const { refs } = buildRoleSnapshotFromAriaSnapshot(SAMPLE_SNAPSHOT);
        // "Home" link appears only once → should NOT have nth
        const homeRef = Object.values(refs).find(r => r.role === 'link' && r.name === 'Home');
        expect(homeRef).toBeDefined();
        expect(homeRef!.nth).toBeUndefined();
    });

    describe('interactive-only mode', () => {
        it('returns only interactive elements', () => {
            const { snapshot, refs } = buildRoleSnapshotFromAriaSnapshot(SAMPLE_SNAPSHOT, { interactive: true });
            const roles = new Set(Object.values(refs).map(r => r.role));
            for (const role of roles) {
                expect(INTERACTIVE_ROLES.has(role)).toBe(true);
            }
            // Should NOT contain headings or articles
            expect(Object.values(refs).some(r => r.role === 'heading')).toBe(false);
        });

        it('returns empty marker when no interactive elements', () => {
            const { snapshot } = buildRoleSnapshotFromAriaSnapshot('- document:\n  - heading "Title"', { interactive: true });
            expect(snapshot).toBe('(no interactive elements)');
        });
    });

    describe('maxDepth option', () => {
        it('excludes elements beyond max depth', () => {
            const { snapshot } = buildRoleSnapshotFromAriaSnapshot(SAMPLE_SNAPSHOT, { maxDepth: 1 });
            // Depth-2+ elements like textbox/button should be excluded
            expect(snapshot).not.toContain('textbox');
            expect(snapshot).not.toContain('button');
        });
    });

    describe('compact mode', () => {
        it('removes unnamed structural elements', () => {
            const { snapshot } = buildRoleSnapshotFromAriaSnapshot(SAMPLE_SNAPSHOT, { compact: true });
            // "generic" and "group" without names should be removed (unless they have ref children)
            // The compacted tree should be shorter than the full one
            const full = buildRoleSnapshotFromAriaSnapshot(SAMPLE_SNAPSHOT, { compact: false });
            expect(snapshot.length).toBeLessThan(full.snapshot.length);
        });
    });
});

describe('compactTree', () => {
    it('keeps lines with [ref=]', () => {
        const tree = '- group:\n  - button "X" [ref=e1]';
        expect(compactTree(tree)).toContain('[ref=e1]');
    });

    it('keeps parent structural lines that have ref descendants', () => {
        const tree = '- group:\n  - generic:\n    - button "X" [ref=e1]';
        const result = compactTree(tree);
        expect(result).toContain('- group:');
        expect(result).toContain('- generic:');
    });

    it('removes structural lines with no ref descendants', () => {
        const tree = '- group:\n  - generic:\n    - paragraph: text\n- button "Y" [ref=e1]';
        const result = compactTree(tree);
        // group and generic have no ref children → removed
        expect(result).not.toContain('- group:');
        expect(result).toContain('- paragraph: text');
        expect(result).toContain('[ref=e1]');
    });
});

describe('parseRoleRef', () => {
    it('parses "e5" → "e5"', () => {
        expect(parseRoleRef('e5')).toBe('e5');
    });
    it('parses "@e5" → "e5"', () => {
        expect(parseRoleRef('@e5')).toBe('e5');
    });
    it('parses "ref=e5" → "e5"', () => {
        expect(parseRoleRef('ref=e5')).toBe('e5');
    });
    it('parses " e5 " with whitespace → "e5"', () => {
        expect(parseRoleRef(' e5 ')).toBe('e5');
    });
    it('returns null for invalid input', () => {
        expect(parseRoleRef('')).toBeNull();
        expect(parseRoleRef('5')).toBeNull();
        expect(parseRoleRef('abc')).toBeNull();
        expect(parseRoleRef('ref=')).toBeNull();
    });
});

describe('truncateSnapshot', () => {
    it('returns unchanged text under budget', () => {
        const { text, truncated } = truncateSnapshot('short text', 1000);
        expect(text).toBe('short text');
        expect(truncated).toBe(false);
    });
    it('truncates at line boundary and adds marker', () => {
        const longText = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
        const { text, truncated } = truncateSnapshot(longText, 200);
        expect(truncated).toBe(true);
        expect(text).toContain('[...TRUNCATED]');
        expect(text.length).toBeLessThanOrEqual(200);
    });
    it('cuts at last complete line', () => {
        const longText = 'line-aaa\nline-bbb\nline-ccc\nline-ddd\nline-eee';
        const { text, truncated } = truncateSnapshot(longText, 30);
        expect(truncated).toBe(true);
        expect(text).toContain('[...TRUNCATED]');
        // No partial lines before the marker
        const beforeMarker = text.split('[...TRUNCATED]')[0]!;
        expect(beforeMarker.endsWith('\n')).toBe(true);
    });
});

describe('getRoleSnapshotStats', () => {
    it('counts lines, chars, refs, and interactive correctly', () => {
        const { snapshot, refs } = buildRoleSnapshotFromAriaSnapshot(SAMPLE_SNAPSHOT);
        const stats = getRoleSnapshotStats(snapshot, refs);
        expect(stats.lines).toBeGreaterThan(0);
        expect(stats.chars).toBeGreaterThan(0);
        expect(stats.refs).toBe(Object.keys(refs).length);
        expect(stats.interactive).toBeGreaterThan(0);
        expect(stats.interactive).toBeLessThanOrEqual(stats.refs);
    });
});

describe('role categories are disjoint', () => {
    it('no role appears in multiple categories', () => {
        for (const role of INTERACTIVE_ROLES) {
            expect(CONTENT_ROLES.has(role)).toBe(false);
            expect(STRUCTURAL_ROLES.has(role)).toBe(false);
        }
        for (const role of CONTENT_ROLES) {
            expect(INTERACTIVE_ROLES.has(role)).toBe(false);
            expect(STRUCTURAL_ROLES.has(role)).toBe(false);
        }
        for (const role of STRUCTURAL_ROLES) {
            expect(INTERACTIVE_ROLES.has(role)).toBe(false);
            expect(CONTENT_ROLES.has(role)).toBe(false);
        }
    });
});


// ─── CDP Fallback Tests ──────────────────────────────────────────

describe('formatCdpAriaSnapshot', () => {
    const sampleNodes: RawAXNode[] = [
        { nodeId: 'n1', role: { value: 'document' }, name: { value: '' }, childIds: ['n2', 'n3'] },
        { nodeId: 'n2', role: { value: 'heading' }, name: { value: 'Title' }, childIds: [] },
        { nodeId: 'n3', role: { value: 'button' }, name: { value: 'Submit' }, childIds: [] },
    ];

    it('formats nodes with correct refs and depth', () => {
        const result = formatCdpAriaSnapshot(sampleNodes, 100);
        expect(result.length).toBe(3);
        expect(result[0]!.ref).toBe('ax1');
        expect(result[0]!.role).toBe('document');
        expect(result[0]!.depth).toBe(0);
        expect(result[1]!.ref).toBe('ax2');
        expect(result[1]!.role).toBe('heading');
        expect(result[1]!.name).toBe('Title');
        expect(result[1]!.depth).toBe(1);
        expect(result[2]!.ref).toBe('ax3');
        expect(result[2]!.role).toBe('button');
        expect(result[2]!.depth).toBe(1);
    });

    it('respects limit parameter', () => {
        const result = formatCdpAriaSnapshot(sampleNodes, 2);
        expect(result.length).toBe(2);
    });

    it('returns empty for empty nodes', () => {
        expect(formatCdpAriaSnapshot([], 100)).toEqual([]);
    });

    it('handles nodes with value and description', () => {
        const nodes: RawAXNode[] = [
            { nodeId: 'n1', role: { value: 'textbox' }, name: { value: 'Email' }, value: { value: 'test@example.com' }, description: { value: 'Enter email' } },
        ];
        const result = formatCdpAriaSnapshot(nodes, 100);
        expect(result[0]!.value).toBe('test@example.com');
        expect(result[0]!.description).toBe('Enter email');
    });

    it('includes backendDOMNodeId when present', () => {
        const nodes: RawAXNode[] = [
            { nodeId: 'n1', role: { value: 'button' }, name: { value: 'OK' }, backendDOMNodeId: 42 },
        ];
        const result = formatCdpAriaSnapshot(nodes, 100);
        expect(result[0]!.backendDOMNodeId).toBe(42);
    });
});

describe('cdpNodesToAriaText', () => {
    it('converts CDP nodes to Playwright-like ARIA text format', () => {
        const nodes = [
            { ref: 'ax1', role: 'document', name: '', depth: 0 },
            { ref: 'ax2', role: 'heading', name: 'Title', depth: 1 },
            { ref: 'ax3', role: 'button', name: 'Submit', depth: 1 },
        ];
        const text = cdpNodesToAriaText(nodes);
        expect(text).toContain('- document');
        expect(text).toContain('  - heading "Title"');
        expect(text).toContain('  - button "Submit"');
    });

    it('includes value in output', () => {
        const nodes = [
            { ref: 'ax1', role: 'textbox', name: 'Email', value: 'hello', depth: 0 },
        ];
        const text = cdpNodesToAriaText(nodes);
        expect(text).toContain('- textbox "Email": hello');
    });
});

// ─── Link Understanding Tests ────────────────────────────────────

describe('extractLinksFromMessage', () => {
    it('extracts bare URLs from text', () => {
        const urls = extractLinksFromMessage('Check out https://example.com and https://test.org');
        expect(urls).toEqual(['https://example.com', 'https://test.org']);
    });

    it('deduplicates URLs', () => {
        const urls = extractLinksFromMessage('Visit https://example.com twice https://example.com');
        expect(urls).toEqual(['https://example.com']);
    });

    it('respects maxLinks', () => {
        const urls = extractLinksFromMessage(
            'https://a.com https://b.com https://c.com https://d.com',
            { maxLinks: 2 },
        );
        expect(urls.length).toBe(2);
    });

    it('ignores markdown link text, keeps bare URLs', () => {
        const urls = extractLinksFromMessage(
            'See [docs](https://docs.example.com) and also https://bare.example.com',
        );
        // markdown link URL is stripped; only bare URL remains
        expect(urls).toEqual(['https://bare.example.com']);
    });

    it('blocks localhost URLs', () => {
        const urls = extractLinksFromMessage('http://localhost:3000/api');
        expect(urls).toEqual([]);
    });

    it('blocks loopback IPs', () => {
        expect(extractLinksFromMessage('http://127.0.0.1/test')).toEqual([]);
        expect(extractLinksFromMessage('http://0.0.0.0/test')).toEqual([]);
    });

    it('returns empty for no URLs', () => {
        expect(extractLinksFromMessage('no links here')).toEqual([]);
    });

    it('returns empty for empty/blank input', () => {
        expect(extractLinksFromMessage('')).toEqual([]);
        expect(extractLinksFromMessage('   ')).toEqual([]);
    });
});

describe('formatLinkUnderstandingBody', () => {
    it('returns body unchanged when no outputs', () => {
        expect(formatLinkUnderstandingBody({ body: 'hello', outputs: [] })).toBe('hello');
    });

    it('appends outputs to body', () => {
        const result = formatLinkUnderstandingBody({
            body: 'Check this link',
            outputs: ['[Link: https://example.com]\nSome content'],
        });
        expect(result).toContain('Check this link');
        expect(result).toContain('[Link: https://example.com]');
    });

    it('returns only outputs when no body', () => {
        const result = formatLinkUnderstandingBody({
            outputs: ['content1', 'content2'],
        });
        expect(result).toBe('content1\ncontent2');
    });

    it('filters blank outputs', () => {
        const result = formatLinkUnderstandingBody({
            body: 'hello',
            outputs: ['', '  ', 'real content'],
        });
        expect(result).toContain('real content');
        expect(result).not.toContain('\n\n\n');
    });
});
