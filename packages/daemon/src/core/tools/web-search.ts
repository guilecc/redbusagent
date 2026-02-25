import { tool } from 'ai';
import { z } from 'zod';
import * as cheerio from 'cheerio';

export const webSearchTool = tool({
    description: 'Searches the web and returns parsed text results. Use to find up-to-date information dynamically.',
    inputSchema: z.object({
        query: z.string().describe('The search query or keywords'),
    }),
    execute: async ({ query }) => {
        console.log(`  🌐 Web Search: ${query}`);
        try {
            const formData = new URLSearchParams();
            formData.append('q', query);

            const res = await fetch('https://lite.duckduckgo.com/lite/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                },
                body: formData.toString()
            });

            if (!res.ok) {
                throw new Error(`DuckDuckGo returned ${res.status}`);
            }

            const html = await res.text();
            const $ = cheerio.load(html);
            const results: { title: string, url: string, snippet: string }[] = [];

            $('.result-snippet').each((i: number, el: any) => {
                const snippet = $(el).text().trim();
                const trNode = $(el).closest('tr').prev();
                if (trNode) {
                    const titleNode = trNode.find('.result-link');
                    const title = titleNode.text().trim();
                    const url = titleNode.attr('href') || '';
                    if (title && snippet) {
                        results.push({ title, url, snippet });
                    }
                }
            });

            return { success: true, results: results.slice(0, 5) };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }
});
