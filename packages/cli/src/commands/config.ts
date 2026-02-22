/**
 * @redbusagent/cli — Config Command
 *
 * Runs the onboarding wizard to configure LLM providers and credentials.
 * Usage: redbus config
 */

import { runOnboardingWizard } from '../wizard/onboarding.js';

export async function configCommand(): Promise<void> {
    const success = await runOnboardingWizard();
    process.exit(success ? 0 : 1);
}
