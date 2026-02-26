/**
 * @redbusagent/daemon — Tool Policy (Owner-Only Authorization)
 *
 * Inspired by openclaw's tool-policy.ts.
 * Restricts sensitive tool execution based on sender authorization level.
 * "Owner" = direct TUI/WebSocket user. Non-owner = scheduled tasks, system alerts, etc.
 */

// ─── Types ───────────────────────────────────────────────────────

export type SenderRole = 'owner' | 'system' | 'scheduled';

export interface ToolPolicyResult {
    allowed: boolean;
    reason?: string;
}

// ─── Owner-Only Tools ────────────────────────────────────────────
// These tools should only be executed by the direct human operator.
// System-originated or scheduled task requests must NOT invoke them.

const OWNER_ONLY_TOOLS = new Set([
    'install_mcp',
    'schedule_recurring_task',
    'delete_scheduled_task',
    'update_persona',
    'core_memory_replace',
    'core_memory_append',
    'git_commit_changes',
    'send_whatsapp_message',
]);

// Tools that require approval gate regardless of sender
const APPROVAL_REQUIRED_TOOLS = new Set([
    'execute_shell_command',
    'edit_file_blocks',
    'git_commit_changes',
    'start_background_process',
]);

// ─── Policy Evaluation ──────────────────────────────────────────

/**
 * Check if a tool call is allowed for the given sender role.
 *
 * @param toolName - The tool being called
 * @param senderRole - Who is requesting the tool execution
 * @returns Whether the tool call is allowed
 */
export function evaluateToolPolicy(
    toolName: string,
    senderRole: SenderRole,
): ToolPolicyResult {
    // Owner can do anything
    if (senderRole === 'owner') {
        return { allowed: true };
    }

    // Non-owner trying to use owner-only tool
    if (OWNER_ONLY_TOOLS.has(toolName)) {
        return {
            allowed: false,
            reason: `Tool "${toolName}" is restricted to owner-only access. Current sender: ${senderRole}`,
        };
    }

    return { allowed: true };
}

/**
 * Check if a tool requires approval gate interaction.
 */
export function requiresApproval(toolName: string): boolean {
    return APPROVAL_REQUIRED_TOOLS.has(toolName);
}

/**
 * Filter a tools record, removing tools that the sender is not authorized to use.
 * Returns a new object with unauthorized tools stripped.
 */
export function applyToolPolicy(
    tools: Record<string, unknown>,
    senderRole: SenderRole,
): Record<string, unknown> {
    if (senderRole === 'owner') return tools;

    const filtered = { ...tools };
    for (const toolName of Object.keys(filtered)) {
        const policy = evaluateToolPolicy(toolName, senderRole);
        if (!policy.allowed) {
            delete filtered[toolName];
            console.log(`  🛡️ [tool-policy] Stripped "${toolName}" for ${senderRole}: ${policy.reason}`);
        }
    }
    return filtered;
}

/**
 * Determine sender role from clientId.
 * - 'system' clientId → system role (watcher, alerts)
 * - 'scheduled-*' clientId → scheduled role (cron tasks)
 * - anything else → owner (direct user interaction)
 */
export function resolveSenderRole(clientId: string): SenderRole {
    if (clientId === 'system') return 'system';
    if (clientId.startsWith('scheduled')) return 'scheduled';
    return 'owner';
}

