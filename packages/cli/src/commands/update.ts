import { checkForUpdates, performUpdate } from '@redbusagent/shared';
import * as p from '@clack/prompts';
import pc from 'picocolors';

export async function updateCommand(): Promise<void> {
    p.intro(pc.bgRed(pc.white(' 🔴 redbusagent — Updater ')));

    const s = p.spinner();
    s.start('Checking for updates...');

    try {
        const info = await checkForUpdates();

        if (info.updateAvailable) {
            s.stop(pc.green(`New version found: v${info.latestVersion} (Current: v${info.currentVersion})`));

            const confirm = await p.confirm({
                message: 'Would you like to start the update now?',
                initialValue: true,
            });

            if (!confirm || p.isCancel(confirm)) {
                p.log.info('Update cancelled.');
                process.exit(0);
            }

            s.start('Downloading new version and compiling dependencies (This may take a few minutes)...');
            await performUpdate();
            s.stop('✅ Update successfully completed!');

            p.log.success('Redbus Agent was updated. Run `redbus start` to start the new version.');
        } else {
            s.stop(pc.gray(`You are already on the latest version (v${info.currentVersion}).`));
        }
    } catch (err: any) {
        s.stop('Failed to update.');
        p.log.error(err.message);
        process.exit(1);
    }
}
