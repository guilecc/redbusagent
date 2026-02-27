/**
 * Tests for the Granular Reset System (config.ts)
 *
 * Covers:
 *  - Each reset category independently clears only the intended files/dirs
 *  - "everything" expands to all categories
 *  - buildResetPreview generates correct labels
 *  - Vault cache is properly cleared after configuration reset
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock Vault to use a temp directory
let tempDir: string = '';

vi.mock('@redbusagent/shared', () => {
    let _cache: any = undefined;
    return {
        Vault: {
            get dir() { return tempDir; },
            read() {
                if (_cache !== undefined) return _cache;
                const configPath = join(tempDir, 'config.json');
                if (!existsSync(configPath)) { _cache = null; return null; }
                try {
                    _cache = JSON.parse(readFileSync(configPath, 'utf-8'));
                    return _cache;
                } catch { _cache = null; return null; }
            },
            write(config: any) {
                mkdirSync(tempDir, { recursive: true });
                writeFileSync(join(tempDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
                _cache = config;
            },
            clearCache() { _cache = undefined; },
            exists() { return existsSync(join(tempDir, 'config.json')); },
        },
    };
});

// Mock the onboarding wizard to prevent daemon-side imports
vi.mock('../wizard/onboarding.js', () => ({
    runOnboardingWizard: vi.fn().mockResolvedValue(true),
}));

import { executeReset, buildResetPreview, type ResetCategory } from './config.js';

// ─── Helpers ──────────────────────────────────────────────────────

function seedFile(name: string, content = '{}'): void {
    writeFileSync(join(tempDir, name), content, 'utf-8');
}

function seedDir(name: string): void {
    const dir = join(tempDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dummy.txt'), 'test', 'utf-8');
}

function exists(name: string): boolean {
    return existsSync(join(tempDir, name));
}

// ─── Setup / Teardown ─────────────────────────────────────────────

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'redbus-reset-test-'));
    // Seed a full vault structure
    seedFile('config.json', JSON.stringify({
        version: 1,
        tier2: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', apiKey: 'sk-test' },
        tier2_enabled: true,
        tier1: { enabled: true, url: 'http://127.0.0.1:11434', model: 'llama3.2:3b', power_class: 'bronze' },
        default_chat_tier: 1,
        live_engine: { enabled: true, provider: 'ollama', url: 'http://127.0.0.1:11434', model: 'gemma3:4b' },
        worker_engine: { enabled: true, provider: 'ollama', url: 'http://127.0.0.1:11434', model: 'gemma3:27b' },
        hardware_profile: { gpu_name: 'RTX 4090', vram_gb: 24, system_ram_gb: 64 },
        mcps: { github: { command: 'npx', args: [], env: {} } },
        owner_phone_number: '5511999999999',
    }));
    seedFile('.masterkey', 'fake-key');
    seedFile('core-memory.md', '# Core Memory');
    seedFile('cognitive-map.json', '[]');
    seedFile('persona.json', '{}');
    seedFile('cron_jobs.json', '{}');
    seedFile('alerts.json', '[]');
    seedFile('daemon.pid', '12345');
    seedFile('tools-registry.json', JSON.stringify({ version: 1, tools: [{ name: 'test' }] }));
    seedDir('memory');
    seedDir('transcripts');
    seedDir('forge');
    seedDir('auth_whatsapp');
    // Clear Vault mock cache
    const { Vault } = require('@redbusagent/shared');
    Vault.clearCache();
});

afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────

describe('executeReset', () => {
    it('memory: clears core-memory, cognitive-map, memory/, transcripts/, alerts.json', () => {
        const results = executeReset(['memory']);
        expect(exists('core-memory.md')).toBe(false);
        expect(exists('cognitive-map.json')).toBe(false);
        expect(exists('memory')).toBe(false);
        expect(exists('transcripts')).toBe(false);
        expect(exists('alerts.json')).toBe(false);
        // Should NOT touch config, persona, forge, whatsapp
        expect(exists('config.json')).toBe(true);
        expect(exists('persona.json')).toBe(true);
        expect(exists('forge')).toBe(true);
        expect(exists('auth_whatsapp')).toBe(true);
        expect(results).toHaveLength(1);
        expect(results[0]!.category).toBe('memory');
    });

    it('whatsapp: clears auth_whatsapp/ only', () => {
        executeReset(['whatsapp']);
        expect(exists('auth_whatsapp')).toBe(false);
        expect(exists('config.json')).toBe(true);
        expect(exists('memory')).toBe(true);
    });

    it('mcps: clears mcps from config without deleting config.json', () => {
        executeReset(['mcps']);
        expect(exists('config.json')).toBe(true);
        const config = JSON.parse(readFileSync(join(tempDir, 'config.json'), 'utf-8'));
        expect(config.mcps).toEqual({});
    });

    it('persona: clears persona.json only', () => {
        executeReset(['persona']);
        expect(exists('persona.json')).toBe(false);
        expect(exists('config.json')).toBe(true);
        expect(exists('core-memory.md')).toBe(true);
    });

    it('engines: clears LLM config fields but keeps the rest', () => {
        executeReset(['engines']);
        expect(exists('config.json')).toBe(true);
        const config = JSON.parse(readFileSync(join(tempDir, 'config.json'), 'utf-8'));
        // Engine/tier fields must be gone
        expect(config.live_engine).toBeUndefined();
        expect(config.worker_engine).toBeUndefined();
        expect(config.tier1).toBeUndefined();
        expect(config.tier2).toBeUndefined();
        expect(config.tier2_enabled).toBeUndefined();
        expect(config.default_chat_tier).toBeUndefined();
        expect(config.hardware_profile).toBeUndefined();
        // Everything else must survive
        expect(config.mcps).toBeDefined();
        expect(config.owner_phone_number).toBe('5511999999999');
        expect(config.version).toBe(1);
    });

    it('configuration: clears config.json, .masterkey, cron_jobs, daemon.pid', () => {
        executeReset(['configuration']);
        expect(exists('config.json')).toBe(false);
        expect(exists('.masterkey')).toBe(false);
        expect(exists('cron_jobs.json')).toBe(false);
        expect(exists('daemon.pid')).toBe(false);
        // Should NOT touch memory or persona
        expect(exists('core-memory.md')).toBe(true);
        expect(exists('persona.json')).toBe(true);
    });

    it('forged_tools: clears forge/ and resets tools-registry.json', () => {
        executeReset(['forged_tools']);
        expect(exists('forge')).toBe(false);
        expect(exists('tools-registry.json')).toBe(true);
        const registry = JSON.parse(readFileSync(join(tempDir, 'tools-registry.json'), 'utf-8'));
        expect(registry.tools).toEqual([]);
    });

    it('everything: expands to all categories', () => {
        const results = executeReset(['everything']);
        expect(results).toHaveLength(7);
        expect(exists('core-memory.md')).toBe(false);
        expect(exists('auth_whatsapp')).toBe(false);
        expect(exists('persona.json')).toBe(false);
        expect(exists('config.json')).toBe(false);
        expect(exists('.masterkey')).toBe(false);
        expect(exists('forge')).toBe(false);
        expect(exists('memory')).toBe(false);
        expect(exists('transcripts')).toBe(false);
    });
});

describe('buildResetPreview', () => {
    it('returns correct labels for each category', () => {
        const preview = buildResetPreview(['memory', 'persona']);
        expect(preview).toContain('Memory');
        expect(preview).toContain('Persona');
        expect(preview).not.toContain('Configuration');
    });

    it('everything expands to all categories in preview', () => {
        const preview = buildResetPreview(['everything']);
        expect(preview).toContain('Memory');
        expect(preview).toContain('WhatsApp');
        expect(preview).toContain('MCPs');
        expect(preview).toContain('Persona');
        expect(preview).toContain('Engines');
        expect(preview).toContain('Configuration');
        expect(preview).toContain('Forged Tools');
    });
});

