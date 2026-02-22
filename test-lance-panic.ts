import { MemoryManager } from './packages/daemon/src/core/memory-manager.js';

async function test() {
    try {
        console.log("Memorizing...");
        await MemoryManager.memorize("TestCategory", "I need to talk to Sabrina tomorrow.");
        console.log("Done.");
    } catch (err) {
        console.error("Caught error:", err);
    }
}

test();
