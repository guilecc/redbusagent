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
import { Vault, type VaultTier2Config, type VaultTier1Config, type Tier2Provider } from '@redbusagent/shared';
import { fetchTier2Models, fetchOllamaModels } from './model-fetcher.js';

// ─── Wizard ───────────────────────────────────────────────────────

export async function runOnboardingWizard(): Promise<boolean> {
    p.intro(pc.bgRed(pc.white(' 🔴 redbusagent — Assistente de Configuração ')));

    const existingConfig = Vault.read();
    if (existingConfig) {
        p.note(
            `Provedor atual: ${pc.bold(existingConfig.tier2.provider)}/${pc.bold(existingConfig.tier2.model)}\n` +
            `Vault: ${pc.dim(Vault.configPath)}`,
            '⚙️  Configuração existente detectada',
        );
    }

    // ── Step 1: Tier 2 Provider ───────────────────────────────

    const provider = await p.select({
        message: 'Qual LLM de nuvem (Tier 2) deseja usar?',
        options: [
            { value: 'anthropic' as const, label: '🟣 Anthropic (Claude)', hint: 'recomendado' },
            { value: 'google' as const, label: '🔵 Google (Gemini)' },
            { value: 'openai' as const, label: '🟢 OpenAI (GPT)' },
        ],
        initialValue: existingConfig?.tier2.provider ?? ('anthropic' as Tier2Provider),
    });
    if (p.isCancel(provider)) return false;

    // ── Step 2: Authentication (BEFORE model selection) ────────

    let authToken: string | undefined;
    let apiKey: string | undefined;

    if (provider === 'anthropic') {
        const key = await p.password({
            message: 'Cole sua API key do Anthropic (sk-ant-...):',
            validate: (v) => {
                if (!v || !v.startsWith('sk-ant-')) return 'API key deve começar com sk-ant-';
            },
        });
        if (p.isCancel(key)) return false;
        apiKey = key.trim();
    } else {
        const keyLabel = provider === 'google'
            ? 'Cole sua Google AI API key:'
            : 'Cole sua OpenAI API key (sk-...):';

        const key = await p.password({
            message: keyLabel,
            validate: (v) => {
                if (!v || v.trim().length < 10) return 'Chave inválida.';
            },
        });
        if (p.isCancel(key)) return false;
        apiKey = key.trim();
    }

    // ── Step 3: Fetch Models (dynamic!) ────────────────────────

    const s = p.spinner();
    s.start(`Buscando modelos disponíveis no ${provider}...`);

    const fetchResult = await fetchTier2Models(provider, { apiKey, authToken });

    if (fetchResult.usingFallback) {
        s.stop(pc.yellow(`⚠️  Não foi possível listar modelos (${fetchResult.error ?? 'erro'}) — usando lista padrão`));
    } else {
        s.stop(pc.green(`${fetchResult.models.length} modelos encontrados!`));
    }

    if (fetchResult.models.length === 0) {
        p.log.error('Nenhum modelo disponível. Verifique sua credencial.');
        return false;
    }

    // ── Step 4: Model Selection ────────────────────────────────

    const model = await p.select({
        message: `Qual modelo do ${provider} deseja usar?`,
        options: fetchResult.models.map(m => ({
            value: m.id,
            label: m.label,
            hint: m.hint,
        })),
    });
    if (p.isCancel(model)) return false;

    const tier2Config: VaultTier2Config = {
        provider,
        model,
        ...(authToken ? { authToken } : {}),
        ...(apiKey ? { apiKey } : {}),
    };

    // ── Step 5: Tier 1 (Ollama Local) ─────────────────────────

    const configureTier1 = await p.confirm({
        message: 'Deseja configurar um modelo local via Ollama (Tier 1)?',
        initialValue: true,
    });
    if (p.isCancel(configureTier1)) return false;

    let tier1Config: VaultTier1Config;

    if (configureTier1) {
        const ollamaUrl = await p.text({
            message: 'URL do Ollama:',
            placeholder: 'http://127.0.0.1:11434',
            defaultValue: 'http://127.0.0.1:11434',
            initialValue: existingConfig?.tier1?.url ?? 'http://127.0.0.1:11434',
        });
        if (p.isCancel(ollamaUrl)) return false;

        // Try to fetch Ollama models dynamically too
        const ollamaSpinner = p.spinner();
        ollamaSpinner.start('Buscando modelos locais no Ollama...');

        const ollamaResult = await fetchOllamaModels(ollamaUrl);

        if (ollamaResult.success && ollamaResult.models.length > 0) {
            ollamaSpinner.stop(pc.green(`${ollamaResult.models.length} modelos locais encontrados!`));

            const ollamaModel = await p.select({
                message: 'Qual modelo local usar?',
                options: ollamaResult.models.map(m => ({
                    value: m.id,
                    label: m.label,
                    hint: m.hint,
                })),
            });
            if (p.isCancel(ollamaModel)) return false;

            tier1Config = { enabled: true, url: ollamaUrl, model: ollamaModel };
        } else {
            ollamaSpinner.stop(pc.yellow('Ollama não encontrado — digite o nome do modelo manualmente'));

            const manualModel = await p.text({
                message: 'Nome do modelo Ollama:',
                placeholder: 'llama3',
                defaultValue: 'llama3',
                initialValue: existingConfig?.tier1?.model ?? 'llama3',
            });
            if (p.isCancel(manualModel)) return false;

            tier1Config = { enabled: true, url: ollamaUrl, model: manualModel };
        }
    } else {
        tier1Config = { enabled: false, url: 'http://127.0.0.1:11434', model: 'llama3' };
    }

    // ── Step 6: Save to Vault ─────────────────────────────────

    const saveSpinner = p.spinner();
    saveSpinner.start('Salvando configuração no Cofre...');

    Vault.write({
        version: Vault.schemaVersion,
        tier2: tier2Config,
        tier1: tier1Config,
    });

    await new Promise(r => setTimeout(r, 500));
    saveSpinner.stop('Configuração salva!');

    p.note(
        `Provedor: ${pc.bold(tier2Config.provider)}/${pc.bold(tier2Config.model)}\n` +
        `Auth: ${pc.bold(tier2Config.authToken ? 'OAuth token' : 'API key')}\n` +
        `Ollama: ${pc.bold(tier1Config.enabled ? `${tier1Config.model} @ ${tier1Config.url}` : 'desativado')}\n` +
        `Vault: ${pc.dim(Vault.configPath)}`,
        '✅ Resumo da configuração',
    );

    p.outro(pc.green('Configuração concluída! Rode: ') + pc.bold(pc.cyan('redbus start')));

    return true;
}
