import { tool } from 'ai';
import { z } from 'zod';
import { BrowserManager } from '../browser.js';

export const webSearchTool = tool({
    description: 'Searches the web (Google/DuckDuckGo) and returns parsed text results. Use to find up-to-date information dynamically.',
    inputSchema: z.object({
        query: z.string().describe('The search query or keywords'),
    }),
    execute: async ({ query }) => {
        console.log(`  🌐 Web Search: ${query}`);
        try {
            const { page, context } = await BrowserManager.getPageForDomain('duckduckgo.com');
            const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
            await page.goto(url, { waitUntil: 'domcontentloaded' });

            // Extract headlines and snippets
            const results = await page.evaluate(() => {
                const resultsNodes = document.querySelectorAll('.result');
                const parsed = [];
                for (let i = 0; i < Math.min(resultsNodes.length, 5); i++) {
                    const node = resultsNodes[i];
                    if (!node) continue;
                    const title = node.querySelector('.result__title')?.textContent?.trim();
                    const snippet = node.querySelector('.result__snippet')?.textContent?.trim();
                    if (title) parsed.push({ title, snippet });
                }
                return parsed;
            });

            await context.close();
            return { success: true, results };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }
});
