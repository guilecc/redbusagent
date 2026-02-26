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
            { value: 'wipe_brain', label: '🧠 Wipe Brain (Obliterate ALL agent state)', hint: 'Memory, Persona, Tools, MCPs, Core Memory' },
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
                message: 'Are you sure you want to obliterate ALL agent state (memory, persona, core memory, MCPs, forged tools)? This action is irreversible.',
                initialValue: false,
            });
            if (!confirm || p.isCancel(confirm)) {
                p.log.info('Operation cancelled.');
                process.exit(0);
            }

            const s = p.spinner();
            s.start('Obliterating brain (memory, persona, tools, core memory)...');

            // Delete all state directories
            const STATE_DIRS = ['memory', 'forge', 'auth_whatsapp'];
            for (const dir of STATE_DIRS) {
                rmSync(join(Vault.dir, dir), { recursive: true, force: true });
            }

            // Delete all state files
            const STATE_FILES = ['persona.json', 'core-memory.md', 'daemon.pid'];
            for (const file of STATE_FILES) {
                const fullPath = join(Vault.dir, file);
                if (existsSync(fullPath)) {
                    rmSync(fullPath, { force: true });
                }
            }

            // Reset tools-registry.json and cognitive-map.json
            writeFileSync(join(Vault.dir, 'tools-registry.json'), JSON.stringify({ version: 1, tools: [] }, null, 2));
            writeFileSync(join(Vault.dir, 'cognitive-map.json'), JSON.stringify([], null, 2));

            // Remove installed MCPs from the Vault config
            const config = Vault.read();
            if (config) {
                Vault.write({ ...config, mcps: {} });
            }

            s.stop('Brain obliterated!');
            p.log.success('Total wipe complete: memory, persona, core memory, forged tools, MCPs, WhatsApp session — all destroyed. The agent will start as a blank slate on the next boot.');
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
                'persona.json',
                'daemon.pid',
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
