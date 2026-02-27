/**
 * @redbusagent/cli — Onboarding Wizard
 *
 * Interactive step-by-step configuration assistant using @clack/prompts.
 * Guides the user through Live Engine + Worker Engine (Dual-Local Architecture)
 * setup, then persists everything to the Vault (~/.redbusagent/config.json).
 *
 * Flow: Hardware Detection → Live Engine (Local or Cloud) → Worker Engine (Local, Cloud, or Disabled) → Save
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';
import { Vault, type VaultTier2Config, type VaultTier1Config, type VaultLiveEngineConfig, type VaultWorkerEngineConfig, type Tier1PowerClass, type Tier2Provider, type EngineProvider, fetchTier2Models, SUGGESTED_MCPS, getMCPSuggestion, inspectHardwareProfile } from '@redbusagent/shared';
import { WhatsAppChannel } from '@redbusagent/daemon/dist/channels/whatsapp.js';

// ─── Helper: RunPod Serverless Configuration ─────────────────────

async function configureRunpod(engineLabel: string): Promise<{ provider: 'runpod'; apiKey: string; endpointId: string; model: string } | null> {
    const apiKey = await p.password({
        message: `Paste your RunPod API key:`,
        validate: (v) => { if (!v || v.trim().length < 10) return 'Invalid key.'; },
    });
    if (p.isCancel(apiKey)) return null;

    const endpointId = await p.text({
        message: `Paste your RunPod Serverless Endpoint ID:`,
        placeholder: 'e.g. abc123def456',
        validate: (v) => { if (!v || v.trim().length < 5) return 'Invalid endpoint ID.'; },
    });
    if (p.isCancel(endpointId)) return null;

    const model = await p.text({
        message: `Which Ollama model is deployed on this RunPod worker?`,
        placeholder: 'gemma3:27b',
        initialValue: 'gemma3:27b',
        validate: (v) => { if (!v || v.trim().length < 2) return 'Invalid model name.'; },
    });
    if (p.isCancel(model)) return null;

    p.log.success(`🚀 ${engineLabel}: RunPod Serverless — ${pc.bold(model as string)} (endpoint: ${(endpointId as string).slice(0, 8)}...)`);
    return { provider: 'runpod', apiKey: (apiKey as string).trim(), endpointId: (endpointId as string).trim(), model: (model as string).trim() };
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

// ─── Helper: Ensure Ollama Installed ─────────────────────────────

async function ensureOllamaInstalled(): Promise<boolean> {
    const { execSync } = await import('node:child_process');
    try {
        execSync('ollama --version', { stdio: 'ignore' });
        return true;
    } catch {
        const install = await p.confirm({
            message: 'Ollama not detected. Install automatically?',
            initialValue: true,
        });
        if (p.isCancel(install)) return false;
        if (!install) return true; // skip but continue

        const s = p.spinner();
        s.start('Installing Ollama...');
        try {
            if (process.platform === 'win32') {
                execSync('winget install --id Ollama.Ollama -e --source winget --accept-package-agreements --accept-source-agreements', { stdio: 'inherit' });
            } else {
                execSync('curl -fsSL https://ollama.com/install.sh | sh', { stdio: 'inherit' });
            }
            s.stop('✅ Ollama installed!');
            return true;
        } catch {
            s.stop('⚠️ Auto-install failed. Download from https://ollama.com/download');
            return true; // continue anyway
        }
    }
}

// ─── Helper: Pull Ollama Model ───────────────────────────────────

async function pullOllamaModel(model: string, url: string): Promise<void> {
    const s = p.spinner();
    try {
        s.start(`Checking/Downloading '${model}'...`);
        const response = await fetch(`${url}/api/pull`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: model, stream: true }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (response.body) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let done = false;
            while (!done) {
                const { value, done: d } = await reader.read();
                done = d;
                if (value) {
                    const lines = decoder.decode(value, { stream: true }).split('\n').filter(l => l.trim());
                    for (const line of lines) {
                        try {
                            const data = JSON.parse(line);
                            if (data.total && data.completed) {
                                s.message(`Downloading '${model}'... (${Math.round((data.completed / data.total) * 100)}%)`);
                            } else if (data.status) {
                                s.message(`${model}: ${data.status}`);
                            }
                        } catch {}
                    }
                }
            }
        }
        s.stop(`✅ Model '${model}' ready!`);
    } catch {
        s.stop(`⚠️ Could not download. Run: ollama pull ${model}`);
    }
}

// ─── Wizard ───────────────────────────────────────────────────────

export async function runOnboardingWizard(options: { reconfigureOnly?: boolean } = {}): Promise<boolean> {
    p.intro(pc.bgRed(pc.white(' 🔴 redbusagent — Configuration Wizard ')));

    const existingConfig = Vault.read();
    if (existingConfig) {
        const liveInfo = existingConfig.live_engine
            ? `${existingConfig.live_engine.provider ?? 'ollama'}/${existingConfig.live_engine.model}`
            : existingConfig.tier1?.model ?? 'not configured';
        p.note(
            `Live Engine: ${pc.bold(liveInfo)}\n` +
            `Worker Engine: ${pc.bold(existingConfig.worker_engine?.enabled ? existingConfig.worker_engine.model : 'disabled')}\n` +
            `Vault: ${pc.dim(Vault.configPath)}`,
            '⚙️  Existing configuration detected',
        );
    }

    // ── Step 0: Hardware Detection ────────────────────────────

    const hwSpinner = p.spinner();
    hwSpinner.start('Detecting hardware profile (GPU/VRAM/RAM)...');
    const hwProfile = await inspectHardwareProfile();
    hwSpinner.stop('Hardware detected!');

    const { gpuName, vramGB, systemRamGB, powerClass } = hwProfile;

    let recommendedLiveModel = 'qwen2.5-coder:7b';
    if (powerClass === 'platinum') {
        recommendedLiveModel = 'llama3.3:70b';
    } else if (powerClass === 'gold') {
        recommendedLiveModel = 'gemma3:27b';
    } else if (powerClass === 'silver') {
        recommendedLiveModel = 'qwen2.5-coder:14b';
    } else if (powerClass === 'bronze') {
        recommendedLiveModel = 'llama3.2:3b';
    }

    let hardwareMessage = `🖥️  ${pc.bold(gpuName)}${vramGB > 0 ? ` (${pc.bold(`${vramGB}GB VRAM`)})` : ''} | ${pc.bold(`${systemRamGB}GB RAM`)}\n` +
        `Processing Class: ${pc.bold(pc.yellow(powerClass.toUpperCase()))}`;

    if (powerClass === 'bronze') {
        hardwareMessage += `\n\n${pc.yellow('⚠️  ≤4GB VRAM Detected (Bronze Class).')}\n` +
            `${pc.yellow('Live Engine: Small models (≤3B) recommended for real-time chat.')}\n` +
            `${pc.yellow('Worker Engine: Use CPU/RAM for larger background models.')}`;
    } else if (powerClass === 'gold') {
        hardwareMessage += `\n\n${pc.green('Excellent GPU detected (12GB+ VRAM). Live Engine can run 20B-35B models locally.')}`;
    } else if (powerClass === 'platinum') {
        hardwareMessage += `\n\n${pc.green('Workstation-grade GPU (24GB+ VRAM). You may not need any Cloud API.')}`;
    }

    p.note(hardwareMessage, '🖥️ Hardware Profile');

    // ════════════════════════════════════════════════════════════
    // ██  STEP A — LIVE ENGINE CONFIGURATION                   ██
    // ════════════════════════════════════════════════════════════

    p.note(
        pc.bold(pc.cyan('⚡ LIVE ENGINE')) + ' — Your real-time chat brain.\n\n' +
        'The Live Engine handles all interactive TUI and WhatsApp messages.\n' +
        'It must be fast (30+ tokens/sec) for a responsive experience.\n\n' +
        `${pc.dim('Choose Local (Ollama on GPU) for privacy and speed,')}\n` +
        `${pc.dim('or Cloud for maximum intelligence without local hardware.')}`,
        '⚡ Step A — Live Engine',
    );

    const liveEngineType = await p.select({
        message: 'How do you want to run the Live Engine?',
        options: [
            { value: 'local' as const, label: '💻 Local (Ollama)', hint: `GPU/VRAM — ${vramGB}GB available${powerClass === 'bronze' ? ' (limited)' : ''}` },
            { value: 'cloud' as const, label: '☁️  Cloud API', hint: 'Anthropic, Google, or OpenAI' },
            { value: 'runpod' as const, label: '🚀 RunPod Serverless (Ollama)', hint: 'Cloud GPU running your own Ollama models' },
        ],
        initialValue: 'local' as const,
    });
    if (p.isCancel(liveEngineType)) return false;

    let liveEngineConfig: VaultLiveEngineConfig;
    let tier1Config: VaultTier1Config;
    let tier2Config: VaultTier2Config;
    let skipTier2 = true;
    let runpodApiKey: string | undefined;

    if (liveEngineType === 'runpod') {
        // ── Live Engine: RunPod Serverless Configuration ──────
        const result = await configureRunpod('Live Engine');
        if (!result) return false;
        runpodApiKey = result.apiKey;

        liveEngineConfig = {
            enabled: true,
            provider: 'runpod',
            url: '',
            model: result.model,
            apiKey: result.apiKey,
            runpod_endpoint_id: result.endpointId,
        };
        tier1Config = { enabled: false, url: 'http://127.0.0.1:11434', model: 'none', power_class: powerClass };
        tier2Config = { provider: 'anthropic', model: 'none', apiKey: '' };
    } else if (liveEngineType === 'cloud') {
        // ── Live Engine: Cloud Configuration ──────────────────
        const result = await configureCloudProvider('Live Engine');
        if (!result) return false;

        liveEngineConfig = {
            enabled: true,
            provider: result.provider as EngineProvider,
            url: '',
            model: result.model,
            apiKey: result.apiKey,
        };
        tier1Config = { enabled: false, url: 'http://127.0.0.1:11434', model: 'none', power_class: powerClass };
        tier2Config = { provider: result.provider as Tier2Provider, model: result.model, apiKey: result.apiKey };
        skipTier2 = false;
    } else {
        // ── Live Engine: Local (Ollama) Configuration ─────────
        const ollamaReady = await ensureOllamaInstalled();
        if (!ollamaReady) return false;
        // Live Engine: Local model selection
        const LOCAL_MODELS: Array<{ value: string; label: string; hint: string }> = powerClass === 'bronze'
            ? [
                { value: 'llama3.2:3b', label: '⚡ Llama 3.2 (3B) — The Sweet Spot', hint: 'Best balance of intelligence and speed for 4GB GPUs ⭐ recommended' },
                { value: 'gemma3:4b', label: '🌟 Gemma 3 (4B) — Google\'s Newest Lightweight', hint: 'Incredible reasoning density (Note: Requires solid quantization for exactly 4GB VRAM)' },
                { value: 'phi3:mini', label: '🧠 Phi-3 Mini (3.8B) — Logic Expert', hint: "Microsoft's optimized logic model" },
                { value: 'qwen2.5-coder:1.5b', label: '🚀 Qwen 2.5 Coder (1.5B) — Ultra-Fast', hint: 'Sub-second responses, code-focused' },
                { value: 'deepseek-r1:1.5b', label: '🔬 DeepSeek R1 (1.5B) — Chain-of-Thought', hint: 'Built-in reasoning, tiny footprint' },
            ]
            : [
                { value: 'gemma3:4b', label: '🌟 Gemma 3 (4B) — Google\'s Newest Lightweight', hint: 'Top-tier conversational intelligence (~5GB VRAM)' },
                { value: 'qwen2.5-coder:7b', label: '💻 qwen2.5-coder:7b', hint: 'Excellent for code (~8GB VRAM)' },
                { value: 'llama3.1:8b', label: '🧠 llama3.1:8b', hint: 'General, great reasoning (~8GB VRAM)' },
            ];

        if (powerClass === 'silver' || powerClass === 'gold' || powerClass === 'platinum') {
            LOCAL_MODELS.push(
                { value: 'qwen2.5-coder:14b', label: '💻 qwen2.5-coder:14b', hint: 'Code, high precision (~16GB VRAM)' },
                { value: 'deepseek-r1:14b', label: '🔬 deepseek-r1:14b', hint: 'Exceptional deep reasoning (~16GB VRAM)' },
            );
        }
        if (powerClass === 'gold' || powerClass === 'platinum') {
            LOCAL_MODELS.push(
                { value: 'gemma3:27b', label: '🌟 gemma3:27b', hint: `Google's latest, exceptional reasoning (~32GB VRAM)${powerClass === 'gold' ? ' ⭐' : ''}` },
                { value: 'codestral:22b', label: '💻 codestral:22b', hint: `Mistral's coding model (~32GB VRAM)` },
            );
        }
        if (powerClass === 'platinum') {
            LOCAL_MODELS.push(
                { value: 'llama3.3:70b', label: '🏆 llama3.3:70b', hint: "Meta's flagship, GPT-4 level (~64GB VRAM) ⭐" },
            );
        }
        LOCAL_MODELS.push({ value: 'custom', label: '✏️  Other...', hint: 'Type the model name manually' });

        const selectedModel = await p.select({
            message: 'Which Ollama model for the Live Engine?',
            options: LOCAL_MODELS,
            initialValue: recommendedLiveModel,
        });
        if (p.isCancel(selectedModel)) return false;

        let finalModel = selectedModel as string;
        if (finalModel === 'custom') {
            const customModel = await p.text({
                message: 'Enter the Ollama model name:',
                placeholder: recommendedLiveModel,
            });
            if (p.isCancel(customModel)) return false;
            finalModel = customModel.trim();
        }

        const liveModel = finalModel || recommendedLiveModel;
        liveEngineConfig = { enabled: true, provider: 'ollama', url: 'http://127.0.0.1:11434', model: liveModel, power_class: powerClass };
        tier1Config = { enabled: true, url: 'http://127.0.0.1:11434', model: liveModel, power_class: powerClass };
        tier2Config = existingConfig?.tier2 ?? { provider: 'anthropic', model: 'skipped-cloud' };

        await pullOllamaModel(liveModel, 'http://127.0.0.1:11434');
    }

    // ══════════════════════════════════════════════════════════════
    // ██  STEP B — WORKER ENGINE CONFIGURATION                   ██
    // ══════════════════════════════════════════════════════════════

    const cpuCount = (await import('node:os')).default.cpus().length;
    const recommendedThreads = Math.max(4, Math.floor(cpuCount * 0.6));

    let recommendedWorkerModel = 'qwen2.5-coder:14b';
    if (systemRamGB >= 32) recommendedWorkerModel = 'gemma3:27b';
    if (systemRamGB >= 64) recommendedWorkerModel = 'qwen2.5-coder:32b';
    if (systemRamGB >= 128) recommendedWorkerModel = 'llama3.3:70b';

    p.note(
        pc.bold(pc.blue('🏗️  WORKER ENGINE')) + ' — Your background processing brain.\n\n' +
        'The Worker Engine handles heavy tasks like memory distillation,\n' +
        'deep code review, and complex analysis — without blocking chat.\n\n' +
        `${pc.dim('Choose Local (Ollama on CPU/RAM) for privacy,')}` +
        `\n${pc.dim('Cloud for power, or Disable if not needed.')}`,
        '🏗️ Step B — Worker Engine',
    );

    const workerEngineType = await p.select({
        message: 'How do you want to run the Worker Engine?',
        options: [
            { value: 'local' as const, label: '💻 Local (Ollama on CPU)', hint: `${systemRamGB}GB RAM, ${cpuCount} cores — GPU stays free` },
            { value: 'cloud' as const, label: '☁️  Cloud API', hint: 'Anthropic, Google, or OpenAI' },
            { value: 'runpod' as const, label: '🚀 RunPod Serverless (Ollama)', hint: 'Cloud GPU running your own Ollama models' },
            { value: 'disabled' as const, label: '⏸️  Disabled', hint: 'Skip Worker Engine for now' },
        ],
        initialValue: systemRamGB >= 16 ? 'local' as const : 'disabled' as const,
    });
    if (p.isCancel(workerEngineType)) return false;

    let workerEngineConfig: VaultWorkerEngineConfig;

    if (workerEngineType === 'runpod') {
        const result = await configureRunpod('Worker Engine');
        if (!result) return false;
        if (!runpodApiKey) runpodApiKey = result.apiKey;
        workerEngineConfig = {
            enabled: true,
            provider: 'runpod',
            url: '',
            model: result.model,
            apiKey: result.apiKey,
            num_threads: recommendedThreads,
            num_ctx: 8192,
            runpod_endpoint_id: result.endpointId,
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
            num_threads: recommendedThreads,
            num_ctx: 8192,
        };
    } else if (workerEngineType === 'local') {
        const WORKER_MODELS: Array<{ value: string; label: string; hint: string }> = [];
        if (systemRamGB >= 16) {
            WORKER_MODELS.push(
                { value: 'qwen2.5-coder:14b', label: '💻 Qwen 2.5 Coder (14B)', hint: 'Code review and analysis (~16GB RAM)' },
                { value: 'deepseek-r1:14b', label: '🔬 DeepSeek R1 (14B)', hint: 'Deep reasoning (~16GB RAM)' },
            );
        }
        if (systemRamGB >= 32) {
            WORKER_MODELS.push(
                { value: 'gemma3:27b', label: '🌟 Gemma 3 (27B) — The Distillation Master', hint: 'Exceptional logic and context handling for background tasks (~32GB RAM) ⭐' },
                { value: 'qwen2.5-coder:32b', label: '🚀 Qwen 2.5 Coder (32B)', hint: `High-precision (~32GB RAM)${systemRamGB < 64 ? '' : ''}` },
            );
        }
        if (systemRamGB >= 64) {
            WORKER_MODELS.push(
                { value: 'llama3.3:70b', label: '🏆 Llama 3.3 (70B)', hint: 'GPT-4 level (~64GB RAM) ⭐' },
                { value: 'qwen2.5-coder:72b', label: '🚀 Qwen 2.5 Coder (72B)', hint: 'Ultimate coding (~64GB RAM)' },
            );
        }
        if (WORKER_MODELS.length === 0) {
            WORKER_MODELS.push({ value: 'qwen2.5-coder:7b', label: '💻 Qwen 2.5 Coder (7B)', hint: 'Lightweight (~8GB RAM)' });
        }
        WORKER_MODELS.push({ value: 'custom', label: '✏️  Other...', hint: 'Type the model name manually' });

        const selectedWorker = await p.select({
            message: 'Which model for the Worker Engine?',
            options: WORKER_MODELS,
            initialValue: recommendedWorkerModel,
        });
        if (p.isCancel(selectedWorker)) return false;

        let workerModel = selectedWorker as string;
        if (workerModel === 'custom') {
            const custom = await p.text({ message: 'Enter the Worker Engine model name:', placeholder: recommendedWorkerModel });
            if (p.isCancel(custom)) return false;
            workerModel = custom.trim();
        }

        workerEngineConfig = {
            enabled: true,
            provider: 'ollama',
            url: 'http://127.0.0.1:11434',
            model: workerModel || recommendedWorkerModel,
            num_threads: recommendedThreads,
            num_ctx: 8192,
        };
        await pullOllamaModel(workerEngineConfig.model, workerEngineConfig.url);
        p.log.success(`🏗️ Worker Engine: ${pc.bold(workerEngineConfig.model)} (${recommendedThreads} threads, CPU-only)`);
    } else {
        workerEngineConfig = { enabled: false, provider: 'ollama', url: 'http://127.0.0.1:11434', model: 'none', num_threads: 8, num_ctx: 8192 };
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
        live_engine: liveEngineConfig,
        worker_engine: workerEngineConfig,
        default_chat_tier,
        owner_phone_number: ownerPhoneNumber,
        credentials,
        sessions,
        hardware_profile: {
            gpu_name: hwProfile.gpuName,
            vram_gb: hwProfile.vramGB,
            system_ram_gb: hwProfile.systemRamGB,
        },
        ...(runpodApiKey ? { runpod_api_key: runpodApiKey } : {}),
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
            live_engine: liveEngineConfig,
            worker_engine: workerEngineConfig,
            default_chat_tier,
            owner_phone_number: ownerPhoneNumber,
            credentials,
            sessions,
            hardware_profile: {
                gpu_name: hwProfile.gpuName,
                vram_gb: hwProfile.vramGB,
                system_ram_gb: hwProfile.systemRamGB,
            },
            ...(runpodApiKey ? { runpod_api_key: runpodApiKey } : {}),
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
            tier1: tier1Config,
            live_engine: liveEngineConfig,
            worker_engine: workerEngineConfig,
            default_chat_tier,
            owner_phone_number: undefined,
            credentials,
            sessions,
            hardware_profile: {
                gpu_name: hwProfile.gpuName,
                vram_gb: hwProfile.vramGB,
                system_ram_gb: hwProfile.systemRamGB,
            },
            ...(runpodApiKey ? { runpod_api_key: runpodApiKey } : {}),
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

    const liveLabel = liveEngineConfig.provider === 'runpod'
        ? `🚀 ${liveEngineConfig.model} (RunPod Serverless)`
        : liveEngineConfig.provider && liveEngineConfig.provider !== 'ollama'
            ? `${liveEngineConfig.provider}/${liveEngineConfig.model} (Cloud)`
            : `${liveEngineConfig.model} (Local/GPU)`;
    const workerLabel = !workerEngineConfig.enabled ? 'disabled'
        : workerEngineConfig.provider === 'runpod'
            ? `🚀 ${workerEngineConfig.model} (RunPod Serverless)`
            : workerEngineConfig.provider && workerEngineConfig.provider !== 'ollama'
                ? `${workerEngineConfig.provider}/${workerEngineConfig.model} (Cloud)`
                : `${workerEngineConfig.model} (Local/CPU, ${workerEngineConfig.num_threads} threads)`;

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
        '✅ Two Brains. One Machine. Configuration Complete.',
    );

    p.outro(pc.green('Configuration complete! Run: ') + pc.bold(pc.cyan('redbus start')));

    return true;
}
