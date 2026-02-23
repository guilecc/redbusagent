import { askTier2 } from './core/cognitive-router.js';

async function main() {
    console.log("Starting Web Tools Test...");

    // We are going to ask Tier 2 LLM to test our web tools.
    // The prompt explicitly asks it to open a page, extract 3 headlines, and return as JSON.
    const prompt = "Please open the Hacker News website (https://news.ycombinator.com). Use your web_interact tool, extract the top 3 headlines from the front page, and return them formatted as a JSON array.";

    const callbacks = {
        onChunk: (delta: string) => {
            process.stdout.write(delta);
        },
        onDone: (fullText: string) => {
            console.log("\n\nTest Finished. Resulting JSON:");
            console.log(fullText);
            process.exit(0);
        },
        onError: (error: Error) => {
            console.error("\nTest Failed with Error:", error);
            process.exit(1);
        },
        onToolCall: (name: string, args: any) => {
            console.log(`\n> Tool Called: ${name}`);
            console.log(`> Args: ${JSON.stringify(args, null, 2)}`);
        },
        onToolResult: (name: string, success: boolean, result: string) => {
            console.log(`\n> Tool Result (${name}): Success=${success}`);
            console.log(`> Output preview: ${result.substring(0, 200)}...`);
        }
    };

    try {
        await askTier2(prompt, callbacks);
    } catch (e) {
        console.error("Critical failure", e);
    }
}

main().catch(console.error);
