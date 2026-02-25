import { tool } from 'ai';
import { z } from 'zod';
import { BrowserManager } from '../browser.js';
import { generateText } from 'ai';
import { createTier2Model } from '../cognitive-router.js';

export const visualInspectPageTool = tool({
    description: 'Use this tool to visually inspect a webpage using a headless browser. It takes a full-page screenshot and sends it to your Vision engine (Tier 2) to answer layout, styling, or rendering debugging questions (e.g. "Is the button overlapping?"). Never use the web_read_page tool for visual UI debugging.',
    inputSchema: z.object({
        url: z.string().describe('The completely formed URL to visually inspect.'),
        inspection_query: z.string().describe('The specific visual or layout question you want the Vision model to answer (e.g., "Are there any overlapping elements in the header?", "What color is the login button?").')
    }),
    execute: async ({ url, inspection_query }) => {
        console.log(`  👁️ [Vision] Taking screenshot of: ${url}`);

        try {
            // 1. Capture Base64 Full-Page Screenshot
            const base64Image = await BrowserManager.captureWebpageScreenshot(url);
            console.log(`  📸 [Vision] Screenshot captured. Analyzing with Tier 2 Engine...`);

            // 2. Instantiate Tier 2 Vision Model
            const model = createTier2Model();

            // 3. Isolated Multimodal LLM Execution
            // By doing this here, we prevent the massive base64 string from returning to the Tier 1 router's conversation history.
            const { text } = await generateText({
                model,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: `Please perform a detailed visual inspection of this webpage screenshot to answer the following query:\n\nQuery: "${inspection_query}"\n\nFocus specifically on layout bugs, overlapping elements, colors, and spatial positioning. Be precise.` },
                            { type: 'image', image: base64Image }
                        ]
                    }
                ]
            });

            console.log(`  ✅ [Vision] Analysis complete.`);

            // 4. Return the Textual Analysis back to the Agent
            return {
                success: true,
                analysis: text
            };

        } catch (err: any) {
            console.error(`  ❌ [Vision] Error:`, err.message);
            return {
                success: false,
                error: `Vision inspection failed: ${err.message}. Ensure your Tier 2 model supports multimodal Vision (e.g., gpt-4o, claude-3-5-sonnet).`
            };
        }
    }
});
