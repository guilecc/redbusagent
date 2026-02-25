import * as p from '@clack/prompts';
import pc from 'picocolors';
import { Vault, SUGGESTED_MCPS, getMCPSuggestion } from '@redbusagent/shared';

export async function runMcpInstallWizard(): Promise<void> {
    const selectedMcps = await p.multiselect({
        message: 'Select the MCPs you want to install (Space to select, Enter to confirm):',
        options: SUGGESTED_MCPS.map(mcp => ({
            value: mcp.id,
            label: mcp.name,
            hint: mcp.description,
        })),
        required: false,
    });

    if (!p.isCancel(selectedMcps) && Array.isArray(selectedMcps) && selectedMcps.length > 0) {
        const config = Vault.read();
        const updatedMcps = config?.mcps || {};

        for (const mcpId of selectedMcps) {
            const suggestion = getMCPSuggestion(mcpId as string);
            if (!suggestion) continue;

            const env: Record<string, string> = {};
            if (suggestion.requiredEnvVars && suggestion.requiredEnvVars.length > 0) {
                p.note(`The MCP ${pc.bold(suggestion.name)} requires environment variables.`, 'MCP Configuration');
                for (const envVar of suggestion.requiredEnvVars) {
                    const value = await p.text({
                        message: `Enter the value for ${pc.cyan(envVar)}:`,
                        validate: (v) => !v ? 'Required' : undefined
                    });
                    if (!p.isCancel(value)) {
                        env[envVar] = value as string;
                    }
                }
            }

            updatedMcps[suggestion.id] = {
                command: suggestion.command,
                args: suggestion.args,
                env
            };
        }

        Vault.write({
            ...Vault.read()!,
            mcps: updatedMcps
        });
        p.log.success('✅ MCPs successfully installed in the Vault.');
    } else {
        p.log.info('No MCP selected or operation cancelled.');
    }
}
