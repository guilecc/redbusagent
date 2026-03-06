import { describe, expect, it } from 'vitest';
import { getSystemPromptLiveGold, getSystemPromptTier2 } from './system-prompt.js';

describe('getSystemPromptLiveGold', () => {
    it('omits worker delegation instructions when the delegation tool is unavailable', () => {
        const prompt = getSystemPromptLiveGold({ delegationToolAvailable: false });

        expect(prompt).not.toContain('delegate_to_worker_engine');
        expect(prompt).toContain('Use only the tools that are actually exposed in this runtime.');
    });

    it('includes worker delegation instructions when the delegation tool is available', () => {
        const prompt = getSystemPromptLiveGold({ delegationToolAvailable: true });

        expect(prompt).toContain('## DELEGATION PROTOCOL (Live Engine → Worker Engine)');
        expect(prompt).toContain('delegate_to_worker_engine');
    });

    it('teaches forged runtimes to use injected daemon paths instead of guessing home or cwd', () => {
        const prompt = getSystemPromptTier2();

        expect(prompt).toContain('REDBUSAGENT_VAULT_DIR');
        expect(prompt).toContain('REDBUSAGENT_FORGE_DIR');
        expect(prompt).toContain('REDBUSAGENT_DAEMON_ROOT');
        expect(prompt).toContain('NEVER assume `~/.redbusagent/daemon`');
    });
});