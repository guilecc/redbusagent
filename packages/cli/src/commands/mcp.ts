/**
 * @redbusagent/cli — MCP Command
 *
 * Handles MCP installation from the CLI:
 * `redbus mcp install <id>`
 */

import pc from 'picocolors';
import * as p from '@clack/prompts';
import { Vault } from '@redbusagent/shared';
import { getMCPSuggestion } from '@redbusagent/shared';

export async function mcpCommand(args: string[]): Promise<void> {
    const action = args[0];
    const target = args[1];

    if (action === 'install') {
        if (!target) {
            p.log.error('Usage: redbus mcp install <name-or-cmd>');
            return;
        }

        const suggestion = getMCPSuggestion(target);
        const config = Vault.read();
        if (!config) {
            p.log.error('Cannot read Vault. Please run `redbus config` first.');
            return;
        }

        let mcpId = target;
        let command = '';
        let mcpArgs: string[] = [];
        const env: Record<string, string> = {};

        if (suggestion) {
            p.log.info(`Found suggested MCP: ${pc.bold(suggestion.name)}`);
            mcpId = suggestion.id;
            command = suggestion.command;
            mcpArgs = suggestion.args;

            if (suggestion.requiredEnvVars && suggestion.requiredEnvVars.length > 0) {
                p.log.message(`⚠️  This MCP requires ${suggestion.requiredEnvVars.length} environment variables.`);

                for (const envVar of suggestion.requiredEnvVars) {
                    const value = await p.text({
                        message: `Enter value for ${pc.cyan(envVar)}:`,
                        validate: (v) => !v ? 'Required value' : undefined
                    });

                    if (p.isCancel(value)) {
                        p.log.info('Installation cancelled.');
                        return;
                    }
                    env[envVar] = value as string;
                }
            }
        } else {
            // It's a custom command
            p.log.info(`Installing custom MCP command: ${pc.bold(target)}`);
            const parts = target.split(' ');
            command = parts[0]!;
            mcpArgs = parts.slice(1);
            mcpId = `custom-${Math.random().toString(36).substring(2, 8)}`;

            p.log.warn('We cannot determine required environment variables for custom MCPs automatically.');
            const wantsEnv = await p.confirm({
                message: 'Does this MCP require any environment variables (e.g. API Keys)?',
                initialValue: false
            });

            if (p.isCancel(wantsEnv)) return;

            if (wantsEnv) {
                let addMore = true;
                while (addMore) {
                    const envKey = await p.text({
                        message: 'Environment Variable Name (e.g. GITHUB_TOKEN):'
                    });
                    if (p.isCancel(envKey)) break;

                    if (envKey) {
                        const envVal = await p.text({
                            message: `Value for ${pc.cyan(envKey as string)}:`
                        });
                        if (!p.isCancel(envVal)) {
                            env[envKey as string] = envVal as string;
                        }
                    }

                    addMore = await p.confirm({ message: 'Add another environment variable?', initialValue: false }) as boolean;
                }
            }
        }

        p.log.info(`Saving MCP '${mcpId}' to Vault...`);
        const updatedMcps = config.mcps || {};
        updatedMcps[mcpId] = { command, args: mcpArgs, env };

        Vault.write({
            ...config,
            mcps: updatedMcps
        });

        p.log.success(pc.green(`✅ MCP ${mcpId} installed successfully! Restart the daemon for changes to take effect.`));
    } else {
        p.log.error(`Unknown mcp action: ${action}`);
        p.log.message('Available actions: install');
    }
}
