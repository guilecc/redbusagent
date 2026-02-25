import { ToolRegistry } from './tool-registry.js';
import { MCPEngine } from './mcp-engine.js';
import { tool, jsonSchema } from 'ai';
import { z } from 'zod';
import { createAndRunTool } from './tools/create-and-run.js';
import { memorizeTool } from './tools/memorize.js';
import { searchMemoryTool } from './tools/search-memory.js';
import { forgetMemoryTool } from './tools/forget-memory.js';
import { searchMemoryAllTool } from './tools/search-memory-all.js';
import { scheduleTaskTool } from './tools/schedule-task.js';
import { listScheduledTasksTool } from './tools/list-scheduled-tasks.js';
import { deleteScheduledTaskTool } from './tools/delete-scheduled-task.js';
import { webSearchTool } from './tools/web-search.js';
import { webReadPageTool } from './tools/web-read-page.js';
import { webInteractTool } from './tools/web-interact.js';
import { updatePersonaTool } from './tools/update-persona.js';
import { sendWhatsappMessageTool } from './tools/send-whatsapp-message.js';
import { coreMemoryReplaceTool, coreMemoryAppendTool } from './tools/core-memory-replace.js';
import { executeShellCommandTool } from './shell-executor.js';
import { readFileChunkTool } from './tools/read-file-chunk.js';
import { searchCodePatternTool } from './tools/search-code-pattern.js';
import { editFileBlocksTool } from './tools/edit-file-blocks.js';
import { getGitStatusTool, getGitDiffTool, gitCommitChangesTool } from './tools/git-manager.js';
import { startBackgroundProcessTool, getProcessLogsTool, killBackgroundProcessTool } from './tools/process-manager.js';
import { visualInspectPageTool } from './tools/visual-inspect-page.js';
import { Forge } from './forge.js';
import { Vault } from '@redbusagent/shared';
import { WhatsAppChannel } from '../channels/whatsapp.js';

export class CapabilityRegistry {
    /**
     * Returns a Record of AI SDK compatible tool schemas combining
     * hardcoded native tools with dynamically loaded user-forged tools.
     */
    static getAvailableTools() {
        const hasWhatsapp = !!Vault.read()?.owner_phone_number && WhatsAppChannel.hasSession();
        const dynamicTools = ToolRegistry.getDynamicTools();
        const mcpTools = MCPEngine.getInstance().getTools();
        const mcpSdkTools: Record<string, any> = {};

        for (const t of mcpTools) {
            const safeName = t.toolName.replace(/[^a-zA-Z0-9_-]/g, '_');

            // Fallback for MCP tools that might legitimately lack an inputSchema
            const schema = (t.inputSchema && Object.keys(t.inputSchema).length > 0)
                ? jsonSchema(t.inputSchema)
                : z.object({ _params: z.record(z.string(), z.any()).optional() }).describe('Fallback schema');

            mcpSdkTools[`mcp_x_${safeName}`] = tool({
                description: `[MCP: ${t.mcpId}] ${t.description}`,
                parameters: schema,
                execute: async (args: any) => {
                    return await MCPEngine.getInstance().callTool(t.mcpId, t.toolName, args);
                }
            } as any);
        }

        return {
            execute_shell_command: executeShellCommandTool,
            create_and_run_tool: createAndRunTool,
            memorize: memorizeTool,
            search_memory: searchMemoryTool,
            forget_memory: forgetMemoryTool,
            search_memory_all: searchMemoryAllTool,
            schedule_task: scheduleTaskTool,
            list_scheduled_tasks: listScheduledTasksTool,
            delete_scheduled_task: deleteScheduledTaskTool,
            web_search: webSearchTool,
            web_read_page: webReadPageTool,
            web_interact: webInteractTool,
            update_persona: updatePersonaTool,
            ...(hasWhatsapp ? { send_whatsapp_message: sendWhatsappMessageTool } : {}),
            core_memory_replace: coreMemoryReplaceTool,
            core_memory_append: coreMemoryAppendTool,
            read_file_chunk: readFileChunkTool,
            search_code_pattern: searchCodePatternTool,
            edit_file_blocks: editFileBlocksTool,
            get_git_status: getGitStatusTool,
            get_git_diff: getGitDiffTool,
            git_commit_changes: gitCommitChangesTool,
            start_background_process: startBackgroundProcessTool,
            get_process_logs: getProcessLogsTool,
            kill_background_process: killBackgroundProcessTool,
            visual_inspect_page: visualInspectPageTool,
            ...dynamicTools,
            ...mcpSdkTools,
        };
    }

    /**
     * Returns a dynamic manifest string that grounds the Agent in reality,
     * ensuring it knows its boundaries and capabilities via prompt injection.
     */
    static getCapabilityManifest(): string {
        const hasWhatsapp = !!Vault.read()?.owner_phone_number && WhatsAppChannel.hasSession();
        const forgedTools = ToolRegistry.getAll();
        const forgedNames = forgedTools.map(t => t.name).join(', ');
        const mcpCount = MCPEngine.getInstance().getTools().length;

        return `You are redbusagent. You have a physical body and capabilities in the real world. Here is your current capability manifest:
- 🧠 Memory (Two-Tier MemGPT Architecture):
  - Core Working Memory: Always visible in your system prompt. Update with core_memory_replace/core_memory_append.
  - Archival Memory: Long-term vector DB. Auto-RAG retrieves relevant chunks automatically. Use search_memory for deep searches.
  - Distilled Wisdom: Cloud wisdom from past Tier 2 interactions is auto-injected.
${hasWhatsapp ? `- 📱 WhatsApp: You are connected to the user's WhatsApp. You can proactively send them messages using the send_whatsapp_message tool.` : ''}
- ⏱️ Task Scheduler: You can schedule, list, and delete recurring jobs using schedule_task, list_scheduled_tasks, delete_scheduled_task.
- 🔄 Background Processes: You can start long-running commands (like servers) using start_background_process. The system will watch the logs and notify you if it crashes so you can fix it automatically. Use kill_background_process to stop them.
- 👁️ Visual UI Debugging: You have access to a headless browser with vision capabilities. If a user asks you to check a layout, verify a visual bug, or "look" at a UI, use visual_inspect_page. DO NOT rely on text DOM scraping for visual issues.
- 🌐 Web: You can browse the internet headless using web_search, web_read_page, and web_interact.
- 🐙 Version Control (Git): You have full Git awareness. Use get_git_status to orient yourself, get_git_diff to review your code edits, and git_commit_changes to save milestones. When writing or modifying code, you are working inside a Git repository. ALWAYS use get_git_diff after modifying a file with edit_file_blocks to review your own work. If the diff looks wrong, fix it before communicating with the user. If the user asks you to save or finalize the work, use git_commit_changes.
- 🔍 Code Navigation: You can search the codebase using search_code_pattern and read specific parts of files using read_file_chunk. NEVER guess code structure; always search and read the exact lines before forging or modifying files.
- 🛠️ Surgical Code Editing: When you need to modify an existing file, DO NOT recreate the whole file. Use the edit_file_blocks tool. Provide the EXACT existing lines in the search_block, and your new lines in the replace_block. Always read the file first to get the exact indentation before attempting an edit.
- 💻 System Shell: You have direct terminal access. You can execute OS commands via the execute_shell_command tool.
- 🔨 Forge: You can write and execute Node.js tools. Your tools and workspace are physically located at: \`${Forge.dir}\`. You currently have ${forgedTools.length} custom tools forged${forgedTools.length > 0 ? `: ${forgedNames}` : '.'}
- 🔌 MCP (Model Context Protocol): You are connected to MCP servers exposing ${mcpCount} external tools dynamically.`;
    }
}

