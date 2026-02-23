import { tool } from 'ai';
import { z } from 'zod';
import { BrowserManager } from '../browser.js';
import { Vault } from '@redbusagent/shared';

export const webInteractTool = tool({
    description: 'Advanced web tool for interacting with complex sites. Takes a list of actions and executes them sequentially. Automates logins, clicks, extract text, and saves session for persistence.',
    inputSchema: z.object({
        url: z.string().describe('URL to navigate to initially'),
        actions: z.array(z.object({
            action: z.enum(['click', 'type', 'wait', 'extract']),
            selector: z.string().optional().describe('CSS selector to interact with'),
            value: z.string().optional().describe('Text to type or time in ms to wait'),
        })).describe('List of sequence actions'),
        useDomainCredentials: z.boolean().optional().describe('Inject domain credentials if input matches "VAULT_USER" or "VAULT_PASS"')
    }),
    execute: async ({ url, actions, useDomainCredentials }) => {
        console.log(`  🤖 Web Interact: ${url} with ${actions.length} actions`);

        let domain = 'unknown';
        try { domain = new URL(url).hostname; } catch { }

        try {
            const { page, context } = await BrowserManager.getPageForDomain(domain);
            await page.goto(url, { waitUntil: 'domcontentloaded' });

            const extractedData: any[] = [];
            const credentials = useDomainCredentials ? Vault.getCredential(domain) : null;

            for (const act of actions) {
                try {
                    if (act.action === 'click' && act.selector) {
                        await page.waitForSelector(act.selector, { timeout: 5000 });
                        await page.click(act.selector);
                    } else if (act.action === 'type' && act.selector && act.value) {
                        await page.waitForSelector(act.selector, { timeout: 5000 });
                        let textToType = act.value;
                        if (useDomainCredentials && credentials) {
                            if (textToType === 'VAULT_USER') textToType = credentials.username;
                            if (textToType === 'VAULT_PASS') textToType = credentials.passwordPlain;
                        }
                        await page.fill(act.selector, textToType);
                    } else if (act.action === 'wait' && act.value) {
                        const num = parseInt(act.value, 10);
                        if (!isNaN(num)) {
                            await page.waitForTimeout(num);
                        } else {
                            await page.waitForSelector(act.value, { timeout: 10000 });
                        }
                    } else if (act.action === 'extract' && act.selector) {
                        await page.waitForSelector(act.selector, { timeout: 5000 });
                        const data = await page.evaluate((sel: string) => {
                            const els = document.querySelectorAll(sel);
                            return Array.from(els).map(e => e.textContent?.trim());
                        }, act.selector);
                        extractedData.push({ selector: act.selector, data });
                    }
                } catch (e: any) {
                    console.log(`  ⚠️ Action failed: ${act.action} on ${act.selector}: ${e.message}`);
                }
            }

            // Always save session at the end of interactions for seamless later use
            await BrowserManager.saveSessionForDomain(domain, context);
            await context.close();

            return { success: true, extractedData };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }
});
