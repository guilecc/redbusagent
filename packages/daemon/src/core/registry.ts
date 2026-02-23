import { ToolRegistry } from './tool-registry.js';
import { createAndRunTool } from './tools/create-and-run.js';
import { memorizeTool } from './tools/memorize.js';
import { searchMemoryTool } from './tools/search-memory.js';
import { scheduleAlertTool } from './tools/schedule-alert.js';
import { webSearchTool } from './tools/web-search.js';
import { webReadPageTool } from './tools/web-read-page.js';
import { webInteractTool } from './tools/web-interact.js';
import { updatePersonaTool } from './tools/update-persona.js';
import { sendWhatsappMessageTool } from './tools/send-whatsapp-message.js';
import { coreMemoryReplaceTool, coreMemoryAppendTool } from './tools/core-memory-replace.js';

export class CapabilityRegistry {
    /**
     * Returns a Record of AI SDK compatible tool schemas combining
     * hardcoded native tools with dynamically loaded user-forged tools.
     */
    static getAvailableTools() {
        const dynamicTools = ToolRegistry.getDynamicTools();

        return {
            create_and_run_tool: createAndRunTool,
            memorize: memorizeTool,
            search_memory: searchMemoryTool,
            schedule_alert: scheduleAlertTool,
            web_search: webSearchTool,
            web_read_page: webReadPageTool,
            web_interact: webInteractTool,
            update_persona: updatePersonaTool,
            send_whatsapp_message: sendWhatsappMessageTool,
            core_memory_replace: coreMemoryReplaceTool,
            core_memory_append: coreMemoryAppendTool,
            ...dynamicTools,
        };
    }

    /**
     * Returns a dynamic manifest string that grounds the Agent in reality,
     * ensuring it knows its boundaries and capabilities via prompt injection.
     */
    static getCapabilityManifest(): string {
        const forgedTools = ToolRegistry.getAll();
        const forgedNames = forgedTools.map(t => t.name).join(', ');

        return `You are redbusagent. You have a physical body and capabilities in the real world. Here is your current capability manifest:
- 🧠 Memory (Two-Tier MemGPT Architecture):
  - Core Working Memory: Always visible in your system prompt. Update with core_memory_replace/core_memory_append.
  - Archival Memory: Long-term vector DB. Auto-RAG retrieves relevant chunks automatically. Use search_memory for deep searches.
  - Distilled Wisdom: Cloud wisdom from past Tier 2 interactions is auto-injected.
- 📱 WhatsApp: You are connected to the user's WhatsApp. You can proactively send them messages using the send_whatsapp_message tool.
- 🌐 Web: You can browse the internet headless using web_search, web_read_page, and web_interact.
- 🔨 Forge: You can write and execute Node.js tools. You currently have ${forgedTools.length} custom tools forged${forgedTools.length > 0 ? `: ${forgedNames}` : '.'}`;
    }
}

