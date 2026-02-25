import pc from 'picocolors';

export async function channelCommand(args: string[]): Promise<void> {
    const action = args[0];
    const channelName = args[1];

    if (action === 'login' && channelName === 'whatsapp') {
        const { WhatsAppChannel } = await import('@redbusagent/daemon/dist/channels/whatsapp.js');
        await WhatsAppChannel.loginInteractively();
        return;
    }

    console.log(`
${pc.bold('Channel Usage:')}
  ${pc.cyan('redbus channel login whatsapp')}
`);
    process.exit(1);
}
