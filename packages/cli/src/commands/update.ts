import { checkForUpdates, performUpdate } from '@redbusagent/shared';
import * as p from '@clack/prompts';
import pc from 'picocolors';

export async function updateCommand(): Promise<void> {
    p.intro(pc.bgRed(pc.white(' 🔴 redbusagent — Atualizador ')));

    const s = p.spinner();
    s.start('Verificando atualizações...');

    try {
        const info = await checkForUpdates();

        if (info.updateAvailable) {
            s.stop(pc.green(`Nova versão encontrada: v${info.latestVersion} (Atual: v${info.currentVersion})`));

            const confirm = await p.confirm({
                message: 'Deseja iniciar a atualização agora?',
                initialValue: true,
            });

            if (!confirm || p.isCancel(confirm)) {
                p.log.info('Atualização cancelada.');
                process.exit(0);
            }

            s.start('Baixando nova versão e compilando dependências (Isso pode demorar alguns minutos)...');
            await performUpdate();
            s.stop('✅ Atualização concluída com sucesso!');

            p.log.success('O Redbus Agent foi atualizado. Execute `redbus start` para iniciar a nova versão.');
        } else {
            s.stop(pc.gray(`Você já está na versão mais recente (v${info.currentVersion}).`));
        }
    } catch (err: any) {
        s.stop('Falha ao atualizar.');
        p.log.error(err.message);
        process.exit(1);
    }
}
