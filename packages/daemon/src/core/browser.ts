import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { Vault } from '@redbusagent/shared';

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
     */
    static async captureWebpageScreenshot(url: string): Promise<string> {
        let domain = 'unknown';
        try {
            domain = new URL(url).hostname;
        } catch { }

        const { page, context } = await this.getPageForDomain(domain);

        try {
            // waitUntil: 'networkidle' ensures images and fonts are loaded for vision
            await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

            // Take a slightly compressed JPEG to optimize LLM payload size
            const buffer = await page.screenshot({
                fullPage: true,
                type: 'jpeg',
                quality: 80
            });

            // Convert to Base64
            const base64 = Buffer.from(buffer).toString('base64');
            return base64;
        } finally {
            // Always clean up resources immediately for one-off screenshots
            await context.close();
        }
    }
}
