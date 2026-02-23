import { tool } from 'ai';
import { z } from 'zod';
import { BrowserManager } from '../browser.js';

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

        try {
            const { page, context } = await BrowserManager.getPageForDomain(domain);
            await page.goto(url, { waitUntil: 'domcontentloaded' });

            // Extract text roughly converted to markdown style logic
            const text = await page.evaluate(() => {
                const body = document.querySelector('body');
                if (!body) return '';
                // remove clutter
                const clutter = body.querySelectorAll('script, style, noscript, svg, nav, footer');
                clutter.forEach(el => el.remove());

                // Truncate to avoid massive payloads for LLM
                return body.innerText.substring(0, 5000);
            });

            await context.close();
            return { success: true, text };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }
});
