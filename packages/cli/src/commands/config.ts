import { join } from 'node:path';
import { rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { Vault } from '@redbusagent/shared';
import { runOnboardingWizard } from '../wizard/onboarding.js';

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
            { value: 'wipe_brain', label: '🧠 Wipe Brain (Delete Memory, MCPs and Forged Tools)', hint: 'Reset progress' },
            { value: 'factory_reset', label: '🔥 Factory Reset (Delete EVERYTHING, including MCPs)', hint: 'Careful!' },
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

            p.log.success(`${count} MCP extension(s) successfully removed. Press Ctrl+C to return to terminal.`);
            process.exit(0);
            break;
        }

        case 'wipe_brain': {
            const confirm = await p.confirm({
                message: 'Are you sure you want to delete all memory, MCPs and forged tools? This action is irreversible.',
                initialValue: false,
            });
            if (!confirm || p.isCancel(confirm)) {
                p.log.info('Operation cancelled.');
                process.exit(0);
            }

            const s = p.spinner();
            s.start('Wiping brain (memory and tools)...');

            // Delete memory/ and forge/
            const memoryDir = join(Vault.dir, 'memory');
            const forgeDir = join(Vault.dir, 'forge');

            rmSync(memoryDir, { recursive: true, force: true });
            rmSync(forgeDir, { recursive: true, force: true });

            // Reset tools-registry.json and cognitive-map.json
            const registryPath = join(Vault.dir, 'tools-registry.json');
            const cognitiveMapPath = join(Vault.dir, 'cognitive-map.json');

            writeFileSync(registryPath, JSON.stringify({ version: 1, tools: [] }, null, 2));
            writeFileSync(cognitiveMapPath, JSON.stringify([], null, 2));

            // Remove installed MCPs from the Vault config
            const config = Vault.read();
            if (config) {
                Vault.write({ ...config, mcps: {} });
            }

            s.stop('Brain successfully wiped!');
            p.log.success('Brain wiped. MCP extensions uninstalled. The agent will start from scratch on the next boot.');
            process.exit(0);
            break;
        }

        case 'factory_reset': {
            const confirm = await p.confirm({
                message: 'WARNING: This will delete ALL configuration, keys and memory. Continue?',
                initialValue: false,
            });
            if (!confirm || p.isCancel(confirm)) {
                p.log.info('Operation cancelled.');
                process.exit(0);
            }

            const s = p.spinner();
            s.start('Starting Factory Reset...');

            // Delete only user data — preserve the application structure (node_modules, packages, .git, bin, etc.)
            const USER_DATA = [
                'config.json',
                '.masterkey',
                'memory',
                'forge',
                'auth_whatsapp',
                'tools-registry.json',
                'cognitive-map.json',
                'core-memory.md',
            ];
            for (const entry of USER_DATA) {
                const fullPath = join(Vault.dir, entry);
                if (existsSync(fullPath)) {
                    rmSync(fullPath, { recursive: true, force: true });
                }
            }

            s.stop('Factory Reset complete.');
            p.log.success('Everything clean! Let\'s configure again from scratch.');

            const success = await runOnboardingWizard();
            process.exit(success ? 0 : 1);
            break;
        }
    }
}
