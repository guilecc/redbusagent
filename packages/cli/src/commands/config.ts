import { join } from 'node:path';
import { rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { Vault } from '@redbusagent/shared';
import { runOnboardingWizard } from '../wizard/onboarding.js';

// ─── Reset Categories ────────────────────────────────────────────

export type ResetCategory = 'memory' | 'whatsapp' | 'mcps' | 'persona' | 'engines' | 'configuration' | 'forged_tools' | 'everything';

interface ResetResult {
    category: ResetCategory;
    filesDeleted: string[];
    dirsDeleted: string[];
}

/**
 * Executes a granular reset for the given categories.
 * Returns an array of results describing what was deleted.
 * This function is pure logic (no prompts) — testable in isolation.
 */
export function executeReset(categories: ResetCategory[]): ResetResult[] {
    const results: ResetResult[] = [];

    // If 'everything' is selected, expand to all individual categories
    const ALL_CATEGORIES: ResetCategory[] = ['memory', 'whatsapp', 'mcps', 'persona', 'engines', 'configuration', 'forged_tools'];
    const effective = categories.includes('everything')
        ? ALL_CATEGORIES
        : categories;

    for (const cat of effective) {
        const result: ResetResult = { category: cat, filesDeleted: [], dirsDeleted: [] };

        switch (cat) {
            case 'memory': {
                // Core Working Memory
                deleteFile('core-memory.md', result);
                // Cognitive Map
                deleteFile('cognitive-map.json', result);
                // Archival Memory (LanceDB)
                deleteDir('memory', result);
                // Transcript history
                deleteDir('transcripts', result);
                // Alerts
                deleteFile('alerts.json', result);
                break;
            }
            case 'whatsapp': {
                deleteDir('auth_whatsapp', result);
                // Also clear owner_phone_number from config if it exists
                const config = Vault.read();
                if (config?.owner_phone_number) {
                    Vault.write({ ...config, owner_phone_number: undefined });
                    Vault.clearCache();
                }
                break;
            }
            case 'mcps': {
                const config = Vault.read();
                if (config && config.mcps && Object.keys(config.mcps).length > 0) {
                    Vault.write({ ...config, mcps: {} });
                    Vault.clearCache();
                    result.filesDeleted.push('config.json [mcps section cleared]');
                }
                break;
            }
            case 'persona': {
                deleteFile('persona.json', result);
                break;
            }
            case 'engines': {
                // Clear LLM engine/tier config without nuking the entire config
                const config = Vault.read();
                if (config) {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    const { live_engine, worker_engine, tier1, tier2, tier2_enabled, default_chat_tier, hardware_profile, ...rest } = config;
                    Vault.write(rest as typeof config);
                    Vault.clearCache();
                    result.filesDeleted.push('config.json [live_engine, worker_engine, legacy tier1/tier2, hardware_profile cleared]');
                }
                break;
            }
            case 'configuration': {
                deleteFile('config.json', result);
                deleteFile('.masterkey', result);
                deleteFile('cron_jobs.json', result);
                deleteFile('daemon.pid', result);
                Vault.clearCache();
                break;
            }
            case 'forged_tools': {
                deleteDir('forge', result);
                // Reset registry to empty instead of deleting (preserves structure)
                const registryPath = join(Vault.dir, 'tools-registry.json');
                if (existsSync(registryPath)) {
                    writeFileSync(registryPath, JSON.stringify({ version: 1, tools: [] }, null, 2));
                    result.filesDeleted.push('tools-registry.json [reset to empty]');
                }
                break;
            }
        }

        results.push(result);
    }

    return results;
}

function deleteFile(name: string, result: ResetResult): void {
    const fullPath = join(Vault.dir, name);
    if (existsSync(fullPath)) {
        rmSync(fullPath, { force: true });
        result.filesDeleted.push(name);
    }
}

function deleteDir(name: string, result: ResetResult): void {
    const fullPath = join(Vault.dir, name);
    if (existsSync(fullPath)) {
        rmSync(fullPath, { recursive: true, force: true });
        result.dirsDeleted.push(name + '/');
    }
}

/**
 * Builds a human-readable summary of what will be deleted for a set of categories.
 */
export function buildResetPreview(categories: ResetCategory[]): string {
    const ALL_CATEGORIES: ResetCategory[] = ['memory', 'whatsapp', 'mcps', 'persona', 'engines', 'configuration', 'forged_tools'];
    const effective = categories.includes('everything')
        ? ALL_CATEGORIES
        : categories;

    const lines: string[] = [];

    for (const cat of effective) {
        switch (cat) {
            case 'memory':
                lines.push('🧠 Memory: core-memory.md, memory/ (LanceDB), cognitive-map.json, transcripts/, alerts.json');
                break;
            case 'whatsapp':
                lines.push('📱 WhatsApp: auth_whatsapp/ session, owner phone number');
                break;
            case 'mcps':
                lines.push('🔌 MCPs: All installed MCP server configurations');
                break;
            case 'persona':
                lines.push('👤 Persona: persona.json (name, personality, guidelines)');
                break;
            case 'engines':
                lines.push('🤖 Engines (LLMs): Live Engine, Worker Engine, hardware profile');
                lines.push('    → Keeps MCPs, persona, memory, credentials intact');
                break;
            case 'configuration':
                lines.push('⚙️  Configuration: config.json, .masterkey, cron_jobs.json, daemon.pid');
                lines.push('    → Includes engines, API keys, ALL settings — full wipe');
                break;
            case 'forged_tools':
                lines.push('🔨 Forged Tools: forge/ directory, tools-registry.json');
                break;
        }
    }

    return lines.join('\n');
}


// ─── Interactive Config Command ───────────────────────────────────

export async function configCommand(): Promise<void> {
    // Step 1: State Detection
    if (!Vault.exists()) {
        const success = await runOnboardingWizard();
        process.exit(success ? 0 : 1);
        return;
    }

    // Step 2: The Maintenance Menu
    p.intro(pc.bgRed(pc.white(' 🔴 redbusagent — Maintenance Menu ')));

    const choice = await p.select({
        message: 'I noticed redbusagent is already configured. What would you like to do?',
        options: [
            { value: 'reconfigure', label: '🔄 Reconfigure AI Providers (Keep Memory and Tools)', hint: 'Keys only' },
            { value: 'install_mcp', label: '🔌 Install MCP Extensions (Model Context Protocol)', hint: 'GitHub, Scrapling, etc.' },
            { value: 'remove_mcp', label: '🗑️ Remove MCP Extensions', hint: 'Uninstall active MCPs' },
            { value: 'reset', label: '🔄 Reset (Selective or Full)', hint: 'Choose what to clear' },
            { value: 'exit', label: '🚪 Cancel / Exit' },
        ],
    });

    if (p.isCancel(choice) || choice === 'exit') {
        p.log.info('Operation cancelled.');
        process.exit(0);
    }

    switch (choice) {
        case 'reconfigure': {
            const success = await runOnboardingWizard({ reconfigureOnly: true });
            process.exit(success ? 0 : 1);
            break;
        }

        case 'install_mcp': {
            const { runMcpInstallWizard } = await import('../wizard/mcp.js');
            await runMcpInstallWizard();
            process.exit(0);
            break;
        }

        case 'remove_mcp': {
            const config = Vault.read();
            const installedMcps = config?.mcps ? Object.keys(config.mcps) : [];

            if (installedMcps.length === 0) {
                p.log.warn('No MCP is currently installed.');
                process.exit(0);
            }

            const mcpsToRemove = await p.multiselect({
                message: 'Select which MCPs you want to remove:',
                options: installedMcps.map(id => ({ value: id, label: id })),
                required: false,
            });

            if (p.isCancel(mcpsToRemove) || mcpsToRemove.length === 0) {
                p.log.info('No MCP removed.');
                process.exit(0);
            }

            const updatedConfig = { ...config! };
            let count = 0;
            for (const id of mcpsToRemove as string[]) {
                delete updatedConfig.mcps![id];
                count++;
            }
            Vault.write(updatedConfig);

            p.log.success(`${count} MCP extension(s) successfully removed.`);
            process.exit(0);
            break;
        }

        case 'reset': {
            await resetCommand();
            break;
        }
    }
}

/**
 * Interactive granular reset — can be called directly via `redbus reset`
 * or from the config menu.
 */
export async function resetCommand(): Promise<void> {
    const selected = await p.multiselect({
        message: 'Select what you want to reset:',
        options: [
            { value: 'memory' as ResetCategory, label: '🧠 Memory', hint: 'Core memory, archival memory, transcripts, alerts' },
            { value: 'whatsapp' as ResetCategory, label: '📱 WhatsApp Session', hint: 'auth_whatsapp/, owner phone' },
            { value: 'mcps' as ResetCategory, label: '🔌 MCPs', hint: 'All installed MCP server configs' },
            { value: 'persona' as ResetCategory, label: '👤 Persona', hint: 'persona.json' },
            { value: 'engines' as ResetCategory, label: '🤖 Engines (LLMs)', hint: 'Live Engine, Worker Engine, model selections — keeps the rest' },
            { value: 'configuration' as ResetCategory, label: '⚙️  Configuration (Full Vault)', hint: 'config.json, .masterkey, cron_jobs — wipes everything' },
            { value: 'forged_tools' as ResetCategory, label: '🔨 Forged Tools', hint: 'forge/ directory, tools-registry.json' },
            { value: 'everything' as ResetCategory, label: '💀 EVERYTHING', hint: 'Nuclear option — deletes all of the above' },
        ],
        required: true,
    });

    if (p.isCancel(selected)) {
        p.log.info('Operation cancelled.');
        process.exit(0);
    }

    const categories = selected as ResetCategory[];

    // Show preview of what will be deleted
    const preview = buildResetPreview(categories);
    p.log.warn('The following will be permanently deleted:\n' + preview);

    const confirmed = await p.confirm({
        message: 'This action is irreversible. Continue?',
        initialValue: false,
    });

    if (!confirmed || p.isCancel(confirmed)) {
        p.log.info('Reset cancelled.');
        process.exit(0);
    }

    const s = p.spinner();
    s.start('Resetting selected categories...');

    const results = executeReset(categories);

    s.stop('Reset complete!');

    // Summary
    let totalFiles = 0;
    let totalDirs = 0;
    for (const r of results) {
        totalFiles += r.filesDeleted.length;
        totalDirs += r.dirsDeleted.length;
    }
    p.log.success(`Cleared ${totalFiles} file(s) and ${totalDirs} director(ies).`);

    // If engines or full configuration was reset, offer to reconfigure
    if (categories.includes('engines') || categories.includes('configuration') || categories.includes('everything')) {
        p.log.info('Engine/model configuration was cleared. Let\'s set up again.');
        const success = await runOnboardingWizard();
        process.exit(success ? 0 : 1);
    }

    process.exit(0);
}