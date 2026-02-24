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
    p.intro(pc.bgRed(pc.white(' 🔴 redbusagent — Menu de Manutenção ')));

    const choice = await p.select({
        message: 'Notei que o redbusagent já está configurado. O que você gostaria de fazer?',
        options: [
            { value: 'reconfigure', label: '🔄 Reconfigurar Provedores de IA (Manter Memória e Ferramentas)', hint: 'Apenas chaves' },
            { value: 'install_mcp', label: '🔌 Instalar Extensões MCP (Model Context Protocol)', hint: 'GitHub, Scrapling, etc.' },
            { value: 'remove_mcp', label: '🗑️ Remover Extensões MCP', hint: 'Desinstalar MCPs ativos' },
            { value: 'wipe_brain', label: '🧠 Limpar Cérebro (Apagar Memória, MCPs e Ferramentas Forjadas)', hint: 'Resetar progresso' },
            { value: 'factory_reset', label: '🔥 Factory Reset (Apagar TUDO, incluindo MCPs)', hint: 'Cuidado!' },
            { value: 'exit', label: '🚪 Cancelar / Sair' },
        ],
    });

    if (p.isCancel(choice) || choice === 'exit') {
        p.log.info('Operação cancelada.');
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
                p.log.warn('Nenhum MCP está instalado no momento.');
                process.exit(0);
            }

            const mcpsToRemove = await p.multiselect({
                message: 'Selecione quais MCPs você deseja remover:',
                options: installedMcps.map(id => ({ value: id, label: id })),
                required: false,
            });

            if (p.isCancel(mcpsToRemove) || mcpsToRemove.length === 0) {
                p.log.info('Nenhum MCP removido.');
                process.exit(0);
            }

            const updatedConfig = { ...config! };
            let count = 0;
            for (const id of mcpsToRemove as string[]) {
                delete updatedConfig.mcps![id];
                count++;
            }
            Vault.write(updatedConfig);

            p.log.success(`${count} extensão(ões) MCP removida(s) com sucesso. Pressione Ctrl+C para voltar ao terminal.`);
            process.exit(0);
            break;
        }

        case 'wipe_brain': {
            const confirm = await p.confirm({
                message: 'Tem certeza que deseja apagar toda a memória, MCPs e ferramentas forjadas? Esta ação é irreversível.',
                initialValue: false,
            });
            if (!confirm || p.isCancel(confirm)) {
                p.log.info('Operação cancelada.');
                process.exit(0);
            }

            const s = p.spinner();
            s.start('Limpando cérebro (memória e ferramentas)...');

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

            s.stop('Cérebro limpo com sucesso!');
            p.log.success('Cérebro apagado. Extensões MCP desinstaladas. O agente começará do zero na próxima inicialização.');
            process.exit(0);
            break;
        }

        case 'factory_reset': {
            const confirm = await p.confirm({
                message: 'AVISO: Isso apagará TODA a configuração, chaves e memória. Continuar?',
                initialValue: false,
            });
            if (!confirm || p.isCancel(confirm)) {
                p.log.info('Operação cancelada.');
                process.exit(0);
            }

            const s = p.spinner();
            s.start('Iniciando Factory Reset...');

            // Delete entire ~/.redbusagent directory (except bin/ to save bandwidth for Ollama)
            if (existsSync(Vault.dir)) {
                const files = readdirSync(Vault.dir);
                for (const file of files) {
                    if (file === 'bin') continue;
                    rmSync(join(Vault.dir, file), { recursive: true, force: true });
                }
            }

            s.stop('Factory Reset concluído.');
            p.log.success('Tudo limpo! Vamos configurar novamente do zero.');

            const success = await runOnboardingWizard();
            process.exit(success ? 0 : 1);
            break;
        }
    }
}
