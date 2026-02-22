/**
 * @redbusagent/cli — Command Router
 *
 * Parses CLI arguments and routes to the appropriate command handler.
 * Entry point for the `redbus` global command.
 *
 * Usage:
 *   redbus start   — Start daemon + TUI
 *   redbus config  — Run onboarding wizard
 *   redbus help    — Show available commands
 */

import pc from 'picocolors';
import { APP_NAME, APP_VERSION } from '@redbusagent/shared';

function showHelp(): void {
    console.log(`
${pc.bold(pc.red(`🔴 ${APP_NAME}`))} ${pc.dim(`v${APP_VERSION}`)}
${pc.dim('Agente autônomo de terminal com roteamento cognitivo')}

${pc.bold('Uso:')}
  ${pc.cyan('redbus')} ${pc.yellow('<comando>')}

${pc.bold('Comandos:')}
  ${pc.yellow('start')}    Inicia o Daemon + TUI interativa
  ${pc.yellow('config')}   Abre o assistente de configuração
  ${pc.yellow('help')}     Mostra esta mensagem

${pc.bold('Começando:')}
  ${pc.dim('1.')} ${pc.cyan('redbus config')}   ${pc.dim('— Configure suas chaves de API')}
  ${pc.dim('2.')} ${pc.cyan('redbus start')}    ${pc.dim('— Inicie o agente')}
  `);
}

export async function main(args: string[]): Promise<void> {
    const command = args[0];

    switch (command) {
        case 'start': {
            const { startCommand } = await import('./commands/start.js');
            await startCommand();
            break;
        }

        case 'config':
        case 'setup': {
            const { configCommand } = await import('./commands/config.js');
            await configCommand();
            break;
        }

        case 'help':
        case '--help':
        case '-h':
        case undefined: {
            showHelp();
            break;
        }

        default: {
            console.log(pc.red(`\n❌ Comando desconhecido: ${command}`));
            showHelp();
            process.exit(1);
        }
    }
}

// Auto-invoke when run directly
await main(process.argv.slice(2));
