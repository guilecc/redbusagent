import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { Vault } from '@redbusagent/shared';
import { captureSemanticSnapshot, parseRoleRef, type SemanticSnapshot, type RoleRefMap } from './aria-snapshot.js';

export class BrowserManager {
    private static browser: Browser | null = null;

    static async init() {
        if (!this.browser) {
            // Launch the headless browser securely
            this.browser = await chromium.launch({ headless: true });
        }
    }

    static async close() {
        if (this.browser) {
            await this.browser.close();
        }
        this.browser = null;
    }

    /**
     * Opens a new page specifically configured for the given domain.
     * Injects session state from the Vault if it exists.
     */
    static async getPageForDomain(domain: string): Promise<{ page: Page; context: BrowserContext }> {
        await this.init();

        const sessionState = Vault.getBrowserSession(domain);

        const contextOptions: any = {};
        if (sessionState) {
            contextOptions.storageState = sessionState;
        }

        const context = await this.browser!.newContext(contextOptions);
        const page = await context.newPage();

        return { page, context };
    }

    /**
     * Extracts the current session state (cookies, localStorage) from the context
     * and saves it into the Vault for the given domain.
     */
    static async saveSessionForDomain(domain: string, context: BrowserContext) {
        const stateJson = await context.storageState();
        Vault.storeBrowserSession(domain, stateJson);
    }

    /**
     * Navigates to a URL, optionally injecting auth state, waits for network idle,
     * and returns a base64 encoded JPEG screenshot.
     * @deprecated Prefer captureSemanticSnapshot for LLM consumption.
     */
    static async captureWebpageScreenshot(url: string): Promise<string> {
        let domain = 'unknown';
        try {
            domain = new URL(url).hostname;
        } catch { }

        const { page, context } = await this.getPageForDomain(domain);

        try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

            const buffer = await page.screenshot({
                fullPage: true,
                type: 'jpeg',
                quality: 80
            });

            const base64 = Buffer.from(buffer).toString('base64');
            return base64;
        } finally {
            await context.close();
        }
    }

    /**
     * Navigates to a URL and captures a semantic ARIA snapshot of the page.
     * Returns a lightweight text representation of the accessibility tree
     * with [ref=N] tags on interactive elements.
     *
     * This is dramatically more token-efficient than Base64 screenshots
     * and gives the LLM structural precision for web interaction.
     */
    static async captureWebpageSnapshot(url: string): Promise<{
        snapshot: SemanticSnapshot;
        title: string;
        url: string;
    }> {
        let domain = 'unknown';
        try {
            domain = new URL(url).hostname;
        } catch { }

        const { page, context } = await this.getPageForDomain(domain);

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            // Brief wait for dynamic content to render
            await page.waitForTimeout(1500);

            const snapshot = await captureSemanticSnapshot(page);
            const title = await page.title();
            const finalUrl = page.url();

            console.log(`  🌐 Semantic snapshot: ${snapshot.stats.lines} lines, ${snapshot.stats.refs} refs (${snapshot.stats.interactive} interactive)`);

            return { snapshot, title, url: finalUrl };
        } finally {
            await context.close();
        }
    }

    /**
     * Resolves a ref string (e.g. "e5", "@e5", "ref=e5") from a snapshot's ref map.
     * Uses parseRoleRef for tolerant input handling.
     */
    static resolveRef(rawRef: string, refs: RoleRefMap): { role: string; name?: string; nth?: number } | null {
        const parsed = parseRoleRef(rawRef);
        if (!parsed) return null;
        return refs[parsed] ?? null;
    }

    /**
     * Interacts with an element identified by its [ref=eN] tag from a semantic snapshot.
     * Supports click, fill, and select actions.
     * Accepts raw ref strings like "e5", "@e5", "ref=e5".
     */
    static async interactByRef(
        page: Page,
        refInput: string | { role: string; name?: string; nth?: number },
        action: 'click' | 'fill' | 'select',
        value?: string,
        refs?: RoleRefMap,
    ): Promise<string> {
        // Resolve ref from map if string input
        let refData: { role: string; name?: string; nth?: number };
        if (typeof refInput === 'string') {
            if (!refs) throw new Error('refs map required when using string ref input');
            const resolved = this.resolveRef(refInput, refs);
            if (!resolved) throw new Error(`Unknown ref: ${refInput}`);
            refData = resolved;
        } else {
            refData = refInput;
        }

        // Build a Playwright role-based locator from the ref metadata
        const locator = page.getByRole(refData.role as any, {
            name: refData.name,
            exact: true,
        });

        const target = refData.nth !== undefined ? locator.nth(refData.nth) : locator.first();

        switch (action) {
            case 'click':
                await target.click();
                return `Clicked ${refData.role}${refData.name ? ` "${refData.name}"` : ''}`;
            case 'fill':
                await target.fill(value ?? '');
                return `Filled ${refData.role}${refData.name ? ` "${refData.name}"` : ''} with "${value}"`;
            case 'select':
                await target.selectOption(value ?? '');
                return `Selected "${value}" in ${refData.role}${refData.name ? ` "${refData.name}"` : ''}`;
            default:
                return `Unknown action: ${action}`;
        }
    }
}
