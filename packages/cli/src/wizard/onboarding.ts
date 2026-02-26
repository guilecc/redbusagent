/**
 * @redbusagent/cli — Onboarding Wizard
 *
 * Interactive step-by-step configuration assistant using @clack/prompts.
 * Guides the user through Tier 2 (cloud LLM) and Tier 1 (local Ollama)
 * setup, then persists everything to the Vault (~/.redbusagent/config.json).
 *
 * Flow: Provider → Credentials → Fetch Models (live) → Select Model → Ollama → Save
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';
import { Vault, type VaultTier2Config, type VaultTier1Config, type Tier1PowerClass, type Tier2Provider, fetchTier2Models, SUGGESTED_MCPS, getMCPSuggestion, inspectHardwareProfile } from '@redbusagent/shared';
import { WhatsAppChannel } from '@redbusagent/daemon/dist/channels/whatsapp.js';

// ─── Wizard ───────────────────────────────────────────────────────

export async function runOnboardingWizard(options: { reconfigureOnly?: boolean } = {}): Promise<boolean> {
    p.intro(pc.bgRed(pc.white(' 🔴 redbusagent — Configuration Wizard ')));

    const existingConfig = Vault.read();
    if (existingConfig) {
        p.note(
            `Current Provider: ${pc.bold(existingConfig.tier2.provider)}/${pc.bold(existingConfig.tier2.model)}\n` +
            `Vault: ${pc.dim(Vault.configPath)}`,
            '⚙️  Existing configuration detected',
        );
    }

    // ── Step 0: Hardware Detection (VRAM-based) ───────────────

    const hwSpinner = p.spinner();
    hwSpinner.start('Detecting hardware profile (GPU/VRAM)...');
    const hwProfile = await inspectHardwareProfile();
    hwSpinner.stop('Hardware detected!');

    const { gpuName, vramGB, systemRamGB, powerClass } = hwProfile;

    let recommendedTier1Model = 'qwen2.5-coder:7b';
    if (powerClass === 'platinum') {
        recommendedTier1Model = 'llama3.3:70b';
    } else if (powerClass === 'gold') {
        recommendedTier1Model = 'gemma2:27b';
    } else if (powerClass === 'silver') {
        recommendedTier1Model = 'qwen2.5-coder:14b';
    }

    let hardwareMessage = `🖥️  ${pc.bold(gpuName)}${vramGB > 0 ? ` (${pc.bold(`${vramGB}GB VRAM`)})` : ''} | ${pc.bold(`${systemRamGB}GB RAM`)}\n` +
        `Processing Class: ${pc.bold(pc.yellow(powerClass.toUpperCase()))}\n` +
        `Recommended Local Model: ${pc.bold(pc.cyan(recommendedTier1Model))}`;

    if (powerClass === 'gold') {
        hardwareMessage += `\n\n${pc.green('Excellent GPU detected (12GB+ VRAM). We recommend 20B-35B parameter models like Gemma 2 or Command R.')}`;
    } else if (powerClass === 'platinum') {
        hardwareMessage += `\n\n${pc.green('Workstation-grade GPU detected (24GB+ VRAM). You can run 70B+ parameter models like Llama 3.3. You likely will not need a Cloud API.')}`;
    }

    p.note(hardwareMessage, '🖥️ Hardware Profile');

    let skipTier2 = false;

    // ── Local-Only Bypass for Gold/Platinum ──────────────────────
    if (powerClass === 'gold' || powerClass === 'platinum') {
        const skipCloud = await p.confirm({
            message: 'Your hardware is powerful enough for a fully offline setup. Would you like to skip Cloud API (Tier 2) configuration entirely?',
            initialValue: powerClass === 'platinum',
        });
        if (p.isCancel(skipCloud)) return false;
        skipTier2 = skipCloud as boolean;
    }

    if (!skipTier2) {
        if (powerClass === 'gold' || powerClass === 'platinum') {
            p.note('Great — Cloud API will complement your powerful local engine for the most complex tasks.', '☁️ CLOUD REASONING (OPTIONAL BOOST)');
        } else {
            p.note('Your hardware has limited RAM, so a Cloud Provider is essential for advanced reasoning and complex agentic tasks.', '☁️ CLOUD REASONING (RECOMMENDED)');
        }
    }

    // ── Step 1: Tier 2 Provider ───────────────────────────────

    let provider: Tier2Provider = existingConfig?.tier2.provider ?? 'anthropic';
    let tier2Config: VaultTier2Config;

    if (skipTier2) {
        tier2Config = { provider: 'anthropic', model: 'skipped-cloud' };
        p.log.info('Skipping Cloud configuration (Tier 2).');
    } else {
        const selectedProvider = await p.select({
            message: 'Which Cloud LLM (Tier 2) would you like to use?',
            options: [
                { value: 'anthropic' as const, label: '🟣 Anthropic (Claude)', hint: 'recommended' },
                { value: 'google' as const, label: '🔵 Google (Gemini)' },
                { value: 'openai' as const, label: '🟢 OpenAI (GPT)' },
            ],
            initialValue: provider,
        });
        if (p.isCancel(selectedProvider)) return false;
        provider = selectedProvider as Tier2Provider;

        // ── Step 2: Authentication (BEFORE model selection) ────────

        let authToken: string | undefined;
        let apiKey: string | undefined;

        if (provider === 'anthropic') {
            const key = await p.password({
                message: 'Paste your Anthropic API key (sk-ant-...):',
                validate: (v) => {
                    if (!v || !v.startsWith('sk-ant-')) return 'API key must start with sk-ant-';
                },
            });
            if (p.isCancel(key)) return false;
            apiKey = key.trim();
        } else {
            const keyLabel = provider === 'google'
                ? 'Paste your Google AI API key:'
                : 'Paste your OpenAI API key (sk-...):';

            const key = await p.password({
                message: keyLabel,
                validate: (v) => {
                    if (!v || v.trim().length < 10) return 'Invalid key.';
                },
            });
            if (p.isCancel(key)) return false;
            apiKey = key.trim();
        }

        // ── Step 3: Fetch Models (dynamic!) ────────────────────────

        let fetchResult!: Awaited<ReturnType<typeof fetchTier2Models>>;
        let shouldRetry = true;

        while (shouldRetry) {
            const s = p.spinner();
            s.start(`Fetching available models from ${provider}...`);

            fetchResult = await fetchTier2Models(provider, { apiKey, authToken });

            if (fetchResult.usingFallback) {
                s.stop(pc.yellow(`⚠️  Could not list models (${fetchResult.error ?? 'error'})`));

                const retryChoice = await p.select({
                    message: 'What would you like to do?',
                    options: [
                        { value: 'retry', label: '🔄 Try again' },
                        { value: 'fallback', label: '📋 Continue with default model list' },
                    ],
                });
                if (p.isCancel(retryChoice)) return false;

                if (retryChoice === 'retry') {
                    continue;
                }
                // fallback — exit loop with fallback models
                shouldRetry = false;
            } else {
                s.stop(pc.green(`${fetchResult.models.length} models found!`));
                shouldRetry = false;
            }
        }

        if (fetchResult!.models.length === 0) {
            p.log.error('No models available. Check your credential.');
            return false;
        }

        // ── Step 4: Model Selection ────────────────────────────────

        const model = await p.select({
            message: `Which model from ${provider} would you like to use?`,
            options: fetchResult.models.map(m => ({
                value: m.id,
                label: m.label,
                hint: m.hint,
            })),
        });
        if (p.isCancel(model)) return false;

        tier2Config = {
            provider,
            model: model as string,
            ...(authToken ? { authToken } : {}),
            ...(apiKey ? { apiKey } : {}),
        };
    }

    // ── Step 5: Tier 1 (Ollama Local) ─────────────────────────

    let configureTier1 = true;
    if (powerClass === 'platinum') {
        p.note('Now let\'s configure your local AI engine — with 64GB+ RAM, this will be your primary workhorse.', '💻 LOCAL ENGINE (PRIMARY)');
    } else if (powerClass === 'gold') {
        p.note('Now let\'s configure your local AI engine — with 32GB+ RAM, you can run very capable models locally.', '💻 LOCAL ENGINE (PRIMARY)');
    } else {
        p.note('Tier 1 (Local AI Engine) handles offline tasks and simple reasoning. Let\'s configure it now.', '💻 LOCAL ENGINE');
    }

    let tier1Config: VaultTier1Config;

    if (configureTier1) {
        const { execSync } = await import('node:child_process');
        try {
            execSync('ollama --version', { stdio: 'ignore' });
        } catch (e) {
            const installPrompt = await p.confirm({
                message: 'Ollama software was not detected on the system. Would you like to install it automatically now?',
                initialValue: true,
            });
            if (p.isCancel(installPrompt)) return false;

            if (installPrompt) {
                const sInstall = p.spinner();
                sInstall.start('Downloading and installing Ollama via terminal (this may take a while and ask for sudo password)...');
                try {
                    if (process.platform === 'win32') {
                        execSync('winget install --id Ollama.Ollama -e --source winget --accept-package-agreements --accept-source-agreements', { stdio: 'inherit' });
                    } else {
                        execSync('curl -fsSL https://ollama.com/install.sh | sh', { stdio: 'inherit' });
                    }
                    sInstall.stop('✅ Ollama successfully installed!');
                } catch (err) {
                    sInstall.stop('⚠️ Auto-installation failed. Please download manually from https://ollama.com/download');
                }
            }
        }

        // Bronze options
        const LOCAL_MODELS: Array<{ value: string; label: string; hint: string }> = [
            { value: 'qwen2.5-coder:7b', label: '💻 qwen2.5-coder:7b', hint: 'Excellent for code (~8GB RAM)' },
            { value: 'llama3.1:8b', label: '🧠 llama3.1:8b', hint: 'General, great reasoning (~8GB RAM)' },
        ];

        // Silver options
        if (powerClass === 'silver' || powerClass === 'gold' || powerClass === 'platinum') {
            LOCAL_MODELS.push(
                { value: 'qwen2.5-coder:14b', label: '💻 qwen2.5-coder:14b', hint: 'Code, high precision (~16GB RAM)' },
                { value: 'deepseek-r1:14b', label: '🔬 deepseek-r1:14b', hint: 'Exceptional deep reasoning (~16GB RAM)' },
            );
        }

        // Gold options
        if (powerClass === 'gold' || powerClass === 'platinum') {
            LOCAL_MODELS.push(
                { value: 'gemma2:27b', label: '🌟 gemma2:27b', hint: `Google's highly efficient model (~32GB RAM)${powerClass === 'gold' ? ' ⭐ recommended' : ''}` },
                { value: 'command-r:35b', label: '🤖 command-r:35b', hint: `Cohere's agentic model (~32GB RAM)${powerClass === 'gold' ? ' ⭐ recommended' : ''}` },
                { value: 'codestral:22b', label: '💻 codestral:22b', hint: `Mistral's coding model (~32GB RAM)${powerClass === 'gold' ? ' ⭐ recommended' : ''}` },
            );
        }

        // Platinum options
        if (powerClass === 'platinum') {
            LOCAL_MODELS.push(
                { value: 'llama3.3:70b', label: '🏆 llama3.3:70b', hint: "Meta's flagship, GPT-4 level (~64GB RAM) ⭐ recommended" },
                { value: 'qwen2.5-coder:72b', label: '🚀 qwen2.5-coder:72b', hint: 'Ultimate coding powerhouse (~64GB RAM) ⭐ recommended' },
            );
        }

        LOCAL_MODELS.push({ value: 'custom', label: '✏️  Other...', hint: 'Type the model name manually' });

        const selectedModel = await p.select({
            message: 'Which Ollama model do you want to use for Tier 1 (Local)?',
            options: LOCAL_MODELS,
            initialValue: recommendedTier1Model,
        });
        if (p.isCancel(selectedModel)) return false;

        let finalModel = selectedModel as string;

        if (finalModel === 'custom') {
            const customModel = await p.text({
                message: 'Enter the exact Ollama model name (e.g. mistral, phi3)...',
                placeholder: recommendedTier1Model,
            });
            if (p.isCancel(customModel)) return false;
            finalModel = customModel.trim();
        }

        tier1Config = { enabled: true, url: 'http://127.0.0.1:11434', model: finalModel || recommendedTier1Model, power_class: powerClass };

        const pullSpinner = p.spinner();
        try {
            pullSpinner.start(`Checking/Downloading model '${tier1Config.model}' in Ollama via API... (0%)`);
            const response = await fetch(`${tier1Config.url}/api/pull`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: tier1Config.model, stream: true })
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            if (response.body) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder('utf-8');
                let done = false;

                while (!done) {
                    const { value, done: readerDone } = await reader.read();
                    done = readerDone;
                    if (value) {
                        const chunk = decoder.decode(value, { stream: true });
                        const lines = chunk.split('\n').filter(l => l.trim().length > 0);

                        for (const line of lines) {
                            try {
                                const data = JSON.parse(line);
                                if (data.total && data.completed) {
                                    const percent = Math.round((data.completed / data.total) * 100);
                                    pullSpinner.message(`Checking/Downloading model '${tier1Config.model}' in Ollama via API... (${percent}%)`);
                                } else if (data.status) {
                                    // Mostra fallback status if no progress is available yet e.g "pulling manifest"
                                    pullSpinner.message(`Configuring model '${tier1Config.model}'... (${data.status})`);
                                }
                            } catch (e) {
                                // Ignore parse errors
                            }
                        }
                    }
                }
            }

            pullSpinner.stop(`✅ Model '${tier1Config.model}' ready to use!`);
        } catch (e) {
            pullSpinner.stop(`⚠️ Could not download model via API. Run manually in terminal: ollama pull ${tier1Config.model}`);
        }
    } else {
        tier1Config = { enabled: false, url: 'http://127.0.0.1:11434', model: recommendedTier1Model, power_class: powerClass };
    }

    let default_chat_tier: 1 | 2 = 1;

    // ── Step 6: Save to Vault (initial — before WhatsApp) ─────

    // Preserve existing fields if re-running config
    let ownerPhoneNumber: string | undefined = existingConfig?.owner_phone_number;
    const credentials = existingConfig?.credentials || {};
    const sessions = existingConfig?.sessions || {};

    const saveSpinner = p.spinner();
    saveSpinner.start('Saving configuration to Vault...');

    Vault.write({
        version: Vault.schemaVersion,
        tier2_enabled: !skipTier2,
        tier2: tier2Config,
        tier1: tier1Config,
        default_chat_tier,
        owner_phone_number: ownerPhoneNumber,
        credentials,
        sessions,
        hardware_profile: {
            gpu_name: hwProfile.gpuName,
            vram_gb: hwProfile.vramGB,
            system_ram_gb: hwProfile.systemRamGB,
        },
    });

    await new Promise(r => setTimeout(r, 500));
    saveSpinner.stop('Configuration saved!');

    // ── Skip Remaining if reconfigureOnly ──────────────────────

    if (options.reconfigureOnly) {
        p.outro(pc.green('Reconfiguration complete! Run: ') + pc.bold(pc.cyan('redbus start')));
        return true;
    }

    // ── Step 7: WhatsApp Integration (Channel Extension) ───────

    const configureWhatsApp = await p.confirm({
        message: 'Would you like to connect redbusagent to your WhatsApp to control it remotely via mobile?',
        initialValue: false,
    });
    if (p.isCancel(configureWhatsApp)) return false;

    if (configureWhatsApp) {
        // ── 🛡️ OWNER FIREWALL: Ask for phone number BEFORE QR ──
        p.note(
            pc.bold(pc.red('🛡️  OWNER SECURITY FIREWALL')) + '\n\n' +
            'For security, the agent will be ' + pc.bold('BLOCKED') + ' to interact\n' +
            pc.bold('EXCLUSIVELY') + ' with the number provided below.\n' +
            'No messages from groups or other contacts will be processed.',
            '🔒 WhatsApp Security',
        );

        const phoneNumber = await p.text({
            message: 'What is your WhatsApp number? (Numbers only, with country and area code. Ex: 5511999999999)',
            placeholder: '5511999999999',
            defaultValue: ownerPhoneNumber,
            validate: (v) => {
                const cleaned = v.replace(/\D/g, '');
                if (cleaned.length < 10) return 'Number too short. Use country + area code + number. Ex: 5511999999999';
                if (cleaned.length > 15) return 'Number too long. Maximum 15 digits.';
                if (cleaned !== v.trim()) return 'Use only numbers, no spaces, dashes, or parentheses.';
            },
        });
        if (p.isCancel(phoneNumber)) return false;

        ownerPhoneNumber = phoneNumber.trim().replace(/\D/g, '');

        // Re-save Vault with owner_phone_number
        Vault.write({
            version: Vault.schemaVersion,
            tier2_enabled: !skipTier2,
            tier2: tier2Config,
            tier1: tier1Config,
            default_chat_tier,
            owner_phone_number: ownerPhoneNumber,
            credentials,
            sessions,
            hardware_profile: {
                gpu_name: hwProfile.gpuName,
                vram_gb: hwProfile.vramGB,
                system_ram_gb: hwProfile.systemRamGB,
            },
        });

        p.log.success(`🛡️  Firewall activated for: ${pc.bold(ownerPhoneNumber)}@c.us`);

        if (WhatsAppChannel.hasSession()) {
            p.note('WhatsApp already perfectly paired in the Vault.', 'WhatsApp Connected');
        } else {
            // Interactive WhatsApp Pair via terminal
            await WhatsAppChannel.loginInteractively();
        }
    } else {
        const { rmSync } = await import('node:fs');
        const { join } = await import('node:path');
        const authDir = join(Vault.dir, 'auth_whatsapp');

        let hadSession = false;
        if (WhatsAppChannel.hasSession()) {
            hadSession = true;
        }

        try {
            rmSync(authDir, { recursive: true, force: true });
        } catch (e) {
            // Ignora caso a pasta não exista ou esteja bloqueada
        }

        ownerPhoneNumber = undefined;
        // Re-save Vault without owner_phone_number
        Vault.write({
            version: Vault.schemaVersion,
            tier2_enabled: !skipTier2,
            tier2: tier2Config,
            tier1: tier1Config,
            default_chat_tier,
            owner_phone_number: undefined,
            credentials,
            sessions,
            hardware_profile: {
                gpu_name: hwProfile.gpuName,
                vram_gb: hwProfile.vramGB,
                system_ram_gb: hwProfile.systemRamGB,
            },
        });

        if (hadSession || existingConfig?.owner_phone_number) {
            p.log.info('🧹 Previous WhatsApp configuration successfully deleted.');
        }
    }

    // ── Step 8: Suggested MCPs ────────────────────────────────

    const installMcp = await p.confirm({
        message: 'Would you like to install suggested MCP (Model Context Protocol) extensions to give the agent superpowers?',
        initialValue: true,
    });

    if (installMcp && !p.isCancel(installMcp)) {
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

            // re-save vault
            Vault.write({
                ...Vault.read()!,
                mcps: updatedMcps
            });
            p.log.success('✅ MCPs successfully installed in the Vault.');
        }
    }

    // ── Step 9: God Mode (Omni-Shell Tool) ─────────────────────

    p.note(
        pc.bold(pc.red('⚡ THE OMNI-SHELL CONFIGURATION (DANGEROUS)')) + '\n\n' +
        'God Mode allows the agent to execute any terminal command\n' +
        '(Bash/PowerShell) autonomously WITHOUT human supervision.\n' +
        'Only enable this in disposable VMs or if you completely trust the AI.',
        '⚠️  GOD MODE',
    );

    const godModePrompt = await p.confirm({
        message: 'Do you want to enable GOD MODE? (Y=Execute instantly, N=Require manual approval)',
        initialValue: false,
    });
    let shellGodMode = false;
    if (!p.isCancel(godModePrompt)) {
        shellGodMode = godModePrompt as boolean;
    }

    // Re-save vault with God Mode
    const finalConfig = Vault.read()!;
    Vault.write({
        ...finalConfig,
        shell_god_mode: shellGodMode
    });
    p.log.success(`✅ God Mode: ${shellGodMode ? pc.red('ACTIVATED') : pc.green('Secured with HITL')}.`);

    p.note(
        `Provider: ${skipTier2 ? pc.bold('skipped') : pc.bold(tier2Config.provider) + '/' + pc.bold(tier2Config.model)}\n` +
        `Auth: ${skipTier2 ? pc.bold('none') : pc.bold(tier2Config.authToken ? 'OAuth token' : 'API key')}\n` +
        `Ollama: ${pc.bold(tier1Config.enabled ? `${tier1Config.model} @ ${tier1Config.url} [${tier1Config.power_class?.toUpperCase()}]` : 'disabled')}\n` +
        `Default: ${pc.bold('Heuristic Routing (Auto)')}\n` +
        `WhatsApp: ${pc.bold(WhatsAppChannel.hasSession() ? 'Connected ✅' : 'Not connected')}\n` +
        (ownerPhoneNumber
            ? `Firewall: ${pc.bold(pc.green(`🛡️  ACTIVE — ${ownerPhoneNumber}@c.us`))}\n`
            : `Firewall: ${pc.bold(pc.dim('not configured'))}\n`) +
        `MCPs: ${pc.bold(Object.keys(finalConfig.mcps || {}).length)} installed\n` +
        `God Mode: ${pc.bold(shellGodMode ? pc.red('ON') : 'OFF')}\n` +
        `Vault: ${pc.dim(Vault.configPath)}`,
        '✅ Configuration summary',
    );

    p.outro(pc.green('Configuration complete! Run: ') + pc.bold(pc.cyan('redbus start')));

    return true;
}
