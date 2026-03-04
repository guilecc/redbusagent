/**
 * @redbusagent/cli — Onboarding Wizard
 *
 * Interactive step-by-step configuration assistant using @clack/prompts.
 * Guides the user through Live Engine + Worker Engine setup (Local or Cloud),
 * then persists everything to the Vault (~/.redbusagent/config.json).
 *
 * Flow: Live Engine → Worker Engine → Save
 *
 * NO hardware detection is performed — the full model catalog is always
 * presented unrestricted so users can freely mix and match engines.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';
import { execSync } from 'node:child_process';
import { Vault, type VaultTier2Config, type VaultLiveEngineConfig, type VaultWorkerEngineConfig, type Tier2Provider, type EngineProvider, fetchTier2Models, SUGGESTED_MCPS, getMCPSuggestion } from '@redbusagent/shared';
import { WhatsAppChannel } from '@redbusagent/daemon/dist/channels/whatsapp.js';
import { OllamaManager } from '@redbusagent/daemon/dist/core/ollama-manager.js';

// ─── Master Catalog: All Supported Local Models (sorted by size) ──

const LOCAL_MODEL_CATALOG = [
    { value: 'gemma3:1b', label: '🪶 gemma3:1b', hint: '~1B params — ultra-lightweight' },
    { value: 'gemma3:4b', label: '🪶 gemma3:4b', hint: '~4B params — good all-rounder' },
    { value: 'gemma3:12b', label: '🪶 gemma3:12b', hint: '~12B params — strong reasoning' },
    { value: 'gemma3:27b', label: '🪶 gemma3:27b', hint: '~27B params — near cloud-quality' },
    { value: '__custom__', label: '✏️  Custom (Type sua tag desejada)', hint: 'Recomendação: Mantenha na família Gemma 3' },
] as const;

// ─── Helper: Local Model Selection ───────────────────────────────

async function selectLocalModel(engineLabel: string): Promise<string | null> {
    const selected = await p.select({
        message: `Select a local model for the ${engineLabel}:`,
        options: LOCAL_MODEL_CATALOG.map(m => ({ value: m.value, label: m.label, hint: m.hint })),
    });
    if (p.isCancel(selected)) return null;

    if (selected === '__custom__') {
        const custom = await p.text({
            message: `Type the Ollama model tag for the ${engineLabel}:`,
            placeholder: 'e.g. mistral:7b, codellama:13b, deepseek-coder:33b',
            validate: (v) => { if (!v || v.trim().length < 2) return 'Invalid model tag.'; },
        });
        if (p.isCancel(custom)) return null;
        return (custom as string).trim();
    }

    return selected as string;
}

// ─── Helper: Cloud Provider Configuration ────────────────────────

async function configureCloudProvider(engineLabel: string): Promise<{ provider: Tier2Provider; apiKey: string; model: string } | null> {
    const selectedProvider = await p.select({
        message: `Which Cloud provider for the ${engineLabel}?`,
        options: [
            { value: 'anthropic' as const, label: '🟣 Anthropic (Claude)', hint: 'recommended' },
            { value: 'google' as const, label: '🔵 Google (Gemini)' },
            { value: 'openai' as const, label: '🟢 OpenAI (GPT)' },
        ],
        initialValue: 'anthropic' as const,
    });
    if (p.isCancel(selectedProvider)) return null;
    const provider = selectedProvider as Tier2Provider;

    const keyLabel = provider === 'anthropic' ? 'Paste your Anthropic API key (sk-ant-...):'
        : provider === 'google' ? 'Paste your Google AI API key:'
            : 'Paste your OpenAI API key (sk-...):';

    const key = await p.password({
        message: keyLabel,
        validate: (v) => { if (!v || v.trim().length < 10) return 'Invalid key.'; },
    });
    if (p.isCancel(key)) return null;
    const apiKey = key.trim();

    // Fetch available models
    let fetchResult!: Awaited<ReturnType<typeof fetchTier2Models>>;
    let shouldRetry = true;
    while (shouldRetry) {
        const s = p.spinner();
        s.start(`Fetching models from ${provider}...`);
        fetchResult = await fetchTier2Models(provider, { apiKey });
        if (fetchResult.usingFallback) {
            s.stop(pc.yellow(`⚠️  Could not list models (${fetchResult.error ?? 'error'})`));
            const retry = await p.select({
                message: 'What would you like to do?',
                options: [
                    { value: 'retry', label: '🔄 Try again' },
                    { value: 'fallback', label: '📋 Continue with default model list' },
                ],
            });
            if (p.isCancel(retry)) return null;
            if (retry === 'fallback') shouldRetry = false;
        } else {
            s.stop(pc.green(`${fetchResult.models.length} models found!`));
            shouldRetry = false;
        }
    }

    if (fetchResult.models.length === 0) {
        p.log.error('No models available. Check your credential.');
        return null;
    }

    const model = await p.select({
        message: `Which model from ${provider} for the ${engineLabel}?`,
        options: fetchResult.models.map(m => ({ value: m.id, label: m.label, hint: m.hint })),
    });
    if (p.isCancel(model)) return null;

    return { provider, apiKey, model: model as string };
}

// ─── Wizard ───────────────────────────────────────────────────────

export async function runOnboardingWizard(options: { reconfigureOnly?: boolean } = {}): Promise<boolean> {
    p.intro(pc.bgRed(pc.white(' 🔴 redbusagent — Configuration Wizard ')));

    const existingConfig = Vault.read();
    if (existingConfig) {
        const liveInfo = existingConfig.live_engine
            ? `${existingConfig.live_engine.provider ?? 'ollama'}/${existingConfig.live_engine.model}`
            : 'not configured';
        p.note(
            `Live Engine: ${pc.bold(liveInfo)}\n` +
            `Worker Engine: ${pc.bold(existingConfig.worker_engine?.enabled ? existingConfig.worker_engine.model : 'disabled')}\n` +
            `Vault: ${pc.dim(Vault.configPath)}`,
            '⚙️  Existing configuration detected',
        );
    }

    // ════════════════════════════════════════════════════════════
    // ██  STEP A — LIVE ENGINE CONFIGURATION                   ██
    // ════════════════════════════════════════════════════════════

    p.note(
        pc.bold(pc.cyan('⚡ LIVE ENGINE')) + ' — Your real-time chat brain.\n\n' +
        'The Live Engine handles all interactive TUI and WhatsApp messages.\n' +
        'It must be fast and low-latency for a responsive experience.\n\n' +
        `${pc.dim('Local: Run a model via Ollama on your machine (free, private)')}\n` +
        `${pc.dim('Cloud: Use Google, Anthropic, or OpenAI')}`,
        '⚡ Step A — Live Engine',
    );

    const liveEngineType = await p.select({
        message: 'Select provider for the LIVE Engine:',
        options: [
            { value: 'local' as const, label: '🏠 Local (Ollama)', hint: 'free, private, runs on your machine' },
            { value: 'cloud' as const, label: '☁️  Cloud API', hint: 'Google, Anthropic, or OpenAI' },
        ],
    });
    if (p.isCancel(liveEngineType)) return false;

    let liveEngineConfig: VaultLiveEngineConfig;
    // Legacy tier2 config kept for backward compatibility
    let tier2Config: VaultTier2Config;
    let skipTier2 = true;

    if (liveEngineType === 'local') {
        // ── Live Engine: Local Ollama ─────────────────────────────
        const model = await selectLocalModel('Live Engine');
        if (!model) return false;

        p.log.success(`🏠 Live Engine: Local Ollama — ${pc.bold(model)}`);

        liveEngineConfig = {
            enabled: true,
            provider: 'ollama',
            url: 'http://localhost:11434',
            model,
        };
        tier2Config = { provider: 'anthropic', model: 'none', apiKey: '' };
    } else {
        // ── Live Engine: Cloud Configuration ──────────────────────
        const result = await configureCloudProvider('Live Engine');
        if (!result) return false;

        liveEngineConfig = {
            enabled: true,
            provider: result.provider as EngineProvider,
            url: '',
            model: result.model,
            apiKey: result.apiKey,
        };
        tier2Config = { provider: result.provider as Tier2Provider, model: result.model, apiKey: result.apiKey };
        skipTier2 = false;
    }

    // ══════════════════════════════════════════════════════════════
    // ██  STEP B — WORKER ENGINE CONFIGURATION                   ██
    // ══════════════════════════════════════════════════════════════

    p.note(
        pc.bold(pc.blue('🏗️  WORKER ENGINE')) + ' — Your background reasoning brain.\n\n' +
        'The Worker Engine handles heavy tasks like memory distillation,\n' +
        'insight generation, deep analysis — without blocking chat.\n\n' +
        `${pc.dim('Local: Run a model via Ollama on your machine (free, private)')}\n` +
        `${pc.dim('Cloud: Use Anthropic, Google, or OpenAI')}`,
        '🏗️ Step B — Worker Engine',
    );

    const workerEngineType = await p.select({
        message: 'Configure the WORKER Engine (for coding/forging):',
        options: [
            { value: 'local' as const, label: '🏠 Local (Ollama)', hint: 'free, private, runs on your machine' },
            { value: 'cloud' as const, label: '☁️  Cloud API', hint: 'Anthropic, Google, or OpenAI' },
            { value: 'disabled' as const, label: '⏭️  Skip — Use Live Engine for everything', hint: 'Simplifies routing' },
        ],
    });
    if (p.isCancel(workerEngineType)) return false;

    let workerEngineConfig: VaultWorkerEngineConfig;

    if (workerEngineType === 'local') {
        // ── Worker Engine: Local Ollama ───────────────────────────
        const model = await selectLocalModel('Worker Engine');
        if (!model) return false;

        p.log.success(`🏠 Worker Engine: Local Ollama — ${pc.bold(model)}`);

        workerEngineConfig = {
            enabled: true,
            provider: 'ollama',
            url: 'http://localhost:11434',
            model,
        };
    } else if (workerEngineType === 'cloud') {
        const result = await configureCloudProvider('Worker Engine');
        if (!result) return false;
        workerEngineConfig = {
            enabled: true,
            provider: result.provider as EngineProvider,
            url: '',
            model: result.model,
            apiKey: result.apiKey,
        };
    } else {
        workerEngineConfig = { enabled: false, url: '', model: null, provider: null };
    }

    let default_chat_tier: 1 | 2 = 1;

    // ── Step 6: Save to Vault (initial — before WhatsApp) ─────

    // Preserve existing fields if re-running config
    let ownerPhoneNumber: string | undefined = existingConfig?.owner_phone_number;
    const credentials = existingConfig?.credentials || {};
    const sessions = existingConfig?.sessions || {};

    const saveSpinner = p.spinner();
    saveSpinner.start('Saving configuration to Vault...');

    let gpu_acceleration = false;

    // ── Pre-Flight NVIDIA Check ───────────────────────────────
    if (process.platform === 'linux') {
        try {
            const output = execSync('nvidia-smi --query-gpu=name --format=csv,noheader', { stdio: 'pipe' }).toString().trim();
            gpu_acceleration = true;
            p.log.success(pc.green(`✅ NVIDIA GPU Detected: [${output}]. Hardware acceleration enabled.`));
        } catch (err) {
            gpu_acceleration = false;
            p.log.warn(pc.yellow('⚠️ NVIDIA driver not found (nvidia-smi failed). Models will run on CPU, which is significantly slower. Please install NVIDIA proprietary drivers to enable GPU acceleration.'));
        }
    } else {
        // Fallback for non-linux or when we want to conservatively test
        gpu_acceleration = false;
    }

    Vault.write({
        version: Vault.schemaVersion,
        tier2_enabled: !skipTier2,
        tier2: tier2Config,
        live_engine: liveEngineConfig,
        worker_engine: workerEngineConfig,
        default_chat_tier,
        owner_phone_number: ownerPhoneNumber,
        credentials,
        sessions,
        gpu_acceleration,
    });

    await new Promise(r => setTimeout(r, 500));
    saveSpinner.stop('Configuration saved!');

    // ── Download Local Models (if any configured) ─────────────
    if (!skipTier2 || liveEngineConfig.provider === 'ollama') {
        try {
            p.note('Checking local AI Engine and downloading required models... This might take a few minutes if the models are large.', '📦 Ollama Engine Setup');
            const dlSpinner = p.spinner();
            dlSpinner.start('Initializing OllamaManager...');
            OllamaManager.setCallbacks((msg) => {
                dlSpinner.message(pc.cyan(msg));
            });
            await OllamaManager.startup();
            OllamaManager.shutdown();
            dlSpinner.stop('Local AI Engine is ready ✅');
        } catch (err) {
            p.log.warn(`Ollama setup issue: ${(err as Error).message}. Models will be verified on daemon startup.`);
        }
    }

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
            live_engine: liveEngineConfig,
            worker_engine: workerEngineConfig,
            default_chat_tier,
            owner_phone_number: ownerPhoneNumber,
            credentials,
            sessions,
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
            // Ignore if the folder doesn't exist or is locked
        }

        ownerPhoneNumber = undefined;
        // Re-save Vault without owner_phone_number
        Vault.write({
            version: Vault.schemaVersion,
            tier2_enabled: !skipTier2,
            tier2: tier2Config,
            live_engine: liveEngineConfig,
            worker_engine: workerEngineConfig,
            default_chat_tier,
            owner_phone_number: undefined,
            credentials,
            sessions,
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

    const liveLabel = liveEngineConfig.provider === 'ollama'
        ? `🏠 ${liveEngineConfig.model} (Local Ollama)`
        : `${liveEngineConfig.provider}/${liveEngineConfig.model}`;
    const workerLabel = !workerEngineConfig.enabled ? 'disabled'
        : workerEngineConfig.provider === 'ollama'
            ? `🏠 ${workerEngineConfig.model} (Local Ollama)`
            : `${workerEngineConfig.provider}/${workerEngineConfig.model}`;

    p.note(
        `⚡ Live Engine: ${pc.bold(pc.cyan(liveLabel))}\n` +
        `🏗️  Worker Engine: ${pc.bold(pc.blue(workerLabel))}\n` +
        `Routing: ${pc.bold('Heuristic (Auto)')}\n` +
        `WhatsApp: ${pc.bold(WhatsAppChannel.hasSession() ? 'Connected ✅' : 'Not connected')}\n` +
        (ownerPhoneNumber
            ? `Firewall: ${pc.bold(pc.green(`🛡️  ACTIVE — ${ownerPhoneNumber}@c.us`))}\n`
            : `Firewall: ${pc.bold(pc.dim('not configured'))}\n`) +
        `MCPs: ${pc.bold(Object.keys(finalConfig.mcps || {}).length)} installed\n` +
        `God Mode: ${pc.bold(shellGodMode ? pc.red('ON') : 'OFF')}\n` +
        `Vault: ${pc.dim(Vault.configPath)}`,
        '✅ Configuration Complete.',
    );

    p.outro(pc.green('Configuration complete! Run: ') + pc.bold(pc.cyan('redbus start')));

    return true;
}
