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
${pc.dim('Autonomous terminal agent with cognitive routing')}

${pc.bold('Usage:')}
  ${pc.cyan('redbus')} ${pc.yellow('<command>')}

${pc.bold('Commands:')}
  ${pc.yellow('daemon')}   Starts the Daemon only (background service, no TUI)
  ${pc.yellow('start')}    Starts the interactive TUI (connects to running daemon)
  ${pc.yellow('stop')}     Stops the running daemon
  ${pc.yellow('config')}   Opens the configuration wizard
  ${pc.yellow('channel')}  Manages Extra Channels (e.g. whatsapp)
  ${pc.yellow('update')}   Downloads and installs the latest Redbus version
  ${pc.yellow('help')}     Shows this message

${pc.bold('Getting Started:')}
  ${pc.dim('1.')} ${pc.cyan('redbus config')}   ${pc.dim('— Configure your API keys')}
  ${pc.dim('2.')} ${pc.cyan('redbus daemon')}   ${pc.dim('— Start the daemon service')}
  ${pc.dim('3.')} ${pc.cyan('redbus start')}    ${pc.dim('— Connect the TUI client')}
  ${pc.dim('4.')} ${pc.cyan('redbus stop')}     ${pc.dim('— Stop the daemon')}
  `);
}

export async function main(args: string[]): Promise<void> {
    const command = args[0];

    switch (command) {
        case 'daemon': {
            const { daemonCommand } = await import('./commands/daemon.js');
            await daemonCommand();
            break;
        }

        case 'start': {
            const { startCommand } = await import('./commands/start.js');
            await startCommand();
            break;
        }

        case 'stop': {
            const { stopCommand } = await import('./commands/stop.js');
            await stopCommand();
            break;
        }

        case 'config':
        case 'setup': {
            const { configCommand } = await import('./commands/config.js');
            await configCommand();
            break;
        }

        case 'channel': {
            const { channelCommand } = await import('./commands/channel.js');
            await channelCommand(args.slice(1));
            break;
        }

        case 'mcp': {
            const { mcpCommand } = await import('./commands/mcp.js');
            await mcpCommand(args.slice(1));
            break;
        }

        case 'update': {
            const { updateCommand } = await import('./commands/update.js');
            await updateCommand();
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
            console.log(pc.red(`\n❌ Unknown command: ${command}`));
            showHelp();
            process.exit(1);
        }
    }
}

// Auto-invoke when run directly
await main(process.argv.slice(2));
