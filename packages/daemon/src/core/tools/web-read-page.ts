import { tool } from 'ai';
import { z } from 'zod';
import { BrowserManager } from '../browser.js';
import { fetchLinkContent } from '../link-understanding.js';

export const webReadPageTool = tool({
    description: 'Navigates to a URL, strips out unnecessary HTML/scripts, and returns the raw markdown text.',
    inputSchema: z.object({
        url: z.string().describe('The completely formed URL to read'),
    }),
    execute: async ({ url }) => {
        console.log(`  📄 Web Read: ${url}`);
        let domain = 'unknown';
        try {
            domain = new URL(url).hostname;
        } catch { }

        // ── Strategy 1: Playwright (full browser) ──────────────────
        try {
            const { page, context } = await BrowserManager.getPageForDomain(domain);
            await page.goto(url, { waitUntil: 'domcontentloaded' });

            const text = await page.evaluate(() => {
                const body = document.querySelector('body');
                if (!body) return '';
                const clutter = body.querySelectorAll('script, style, noscript, svg, nav, footer');
                clutter.forEach(el => el.remove());
                return body.innerText.substring(0, 5000);
            });

            await context.close();
            return { success: true, text };
        } catch (playwrightErr: any) {
            // ── Strategy 2: Lightweight fetch fallback ──────────────
            // Triggered when Playwright/Chromium is not installed
            const isNotInstalled = playwrightErr.message?.includes('Executable doesn\'t exist')
                || playwrightErr.message?.includes('browserType.launch')
                || playwrightErr.message?.includes('ENOENT');

            if (isNotInstalled) {
                console.log(`  ⚠️ Playwright unavailable, falling back to fetch: ${url}`);
                try {
                    const content = await fetchLinkContent(url, { timeoutMs: 15000 });
                    if (content) {
                        return { success: true, text: content, fallback: true };
                    }
                    return { success: false, error: 'Fetch fallback returned no content' };
                } catch (fetchErr: any) {
                    return { success: false, error: `Playwright unavailable and fetch failed: ${fetchErr.message}` };
                }
            }

            return { success: false, error: playwrightErr.message };
        }
    }
});
