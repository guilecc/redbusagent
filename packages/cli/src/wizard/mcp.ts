import * as p from '@clack/prompts';
import pc from 'picocolors';
import { Vault, SUGGESTED_MCPS, getMCPSuggestion } from '@redbusagent/shared';

export async function runMcpInstallWizard(): Promise<void> {
    const selectedMcps = await p.multiselect({
        message: 'Selecione os MCPs que deseja instalar (Espaço seleciona, Enter confirma):',
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
                p.note(`O MCP ${pc.bold(suggestion.name)} requer variáveis de ambiente.`, 'Configuração de MCP');
                for (const envVar of suggestion.requiredEnvVars) {
                    const value = await p.text({
                        message: `Digite o valor para ${pc.cyan(envVar)}:`,
                        validate: (v) => !v ? 'Obrigatório' : undefined
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
        p.log.success('✅ MCPs instalados com sucesso no Cofre.');
    } else {
        p.log.info('Nenhum MCP selecionado ou operação cancelada.');
    }
}
