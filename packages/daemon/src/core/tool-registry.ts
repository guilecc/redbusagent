/**
 * @redbusagent/daemon — Tool Registry
 *
 * Manages ~/.redbusagent/tools-registry.json — the catalog of all
 * tools the agent has successfully forged. Each entry describes a
 * tool that can be re-invoked by the LLM via Function Calling.
 *
 * On startup, registered tools are loaded and injected into the
 * Cloud/Worker Engine tools array so the LLM "remembers" what it can do.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { Vault } from '@redbusagent/shared';
import { Forge } from './forge.js';

// ─── Types ────────────────────────────────────────────────────────

export interface ToolRegistryEntry {
    name: string;
    description: string;
    filename: string;
    createdAt: string;
    lastUsedAt: string;
    executionCount: number;
}

interface RegistryFile {
    version: number;
    tools: ToolRegistryEntry[];
}

// ─── Constants ────────────────────────────────────────────────────

const REGISTRY_PATH = join(Vault.dir, 'tools-registry.json');

// ─── Registry Service ─────────────────────────────────────────────

export class ToolRegistry {
    static get path(): string {
        return REGISTRY_PATH;
    }

    static ensureFile(): void {
        if (!existsSync(REGISTRY_PATH)) {
            this.save({ version: 1, tools: [] });
        }
    }

    static load(): RegistryFile {
        if (!existsSync(REGISTRY_PATH)) {
            return { version: 1, tools: [] };
        }
        try {
            const raw = readFileSync(REGISTRY_PATH, 'utf-8');
            return JSON.parse(raw) as RegistryFile;
        } catch {
            return { version: 1, tools: [] };
        }
    }

    private static save(registry: RegistryFile): void {
        writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), {
            encoding: 'utf-8',
            mode: 0o600,
        });
    }

    static register(entry: Omit<ToolRegistryEntry, 'lastUsedAt' | 'executionCount'>): void {
        const registry = this.load();
        const existing = registry.tools.findIndex(t => t.name === entry.name);
        const fullEntry: ToolRegistryEntry = {
            ...entry,
            lastUsedAt: entry.createdAt,
            executionCount: 1,
        };
        if (existing >= 0) {
            registry.tools[existing] = fullEntry;
        } else {
            registry.tools.push(fullEntry);
        }
        this.save(registry);
        console.log(`  🔧 Forge: Tool "${entry.name}" registered in registry`);
    }

    static recordExecution(name: string): void {
        const registry = this.load();
        const entry = registry.tools.find(t => t.name === name);
        if (entry) {
            entry.lastUsedAt = new Date().toISOString();
            entry.executionCount++;
            this.save(registry);
        }
    }

    static getAll(): ToolRegistryEntry[] {
        return this.load().tools;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static getDynamicTools(): Record<string, any> {
        const entries = this.getAll();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tools: Record<string, any> = {};

        for (const entry of entries) {
            const entryName = entry.name;
            const entryFilename = entry.filename;

            tools[entryName] = tool({
                description: `[Forjada] ${entry.description}`,
                inputSchema: z.object({
                    input: z.string().optional().describe('Optional input to pass to the tool'),
                }),
                execute: async (params: { input?: string }) => {
                    console.log(`  🔧 Forge: Re-executing "${entryName}" (${entryFilename})`);
                    ToolRegistry.recordExecution(entryName);
                    const result = await Forge.executeScript(entryFilename, params.input);
                    if (result.success) {
                        return { success: true, output: result.stdout, durationMs: result.durationMs };
                    } else {
                        return { success: false, error: result.stderr, durationMs: result.durationMs };
                    }
                },
            } as const);
        }

        return tools;
    }

    /** Get a summary of registered tools for system prompt context */
    static getToolsSummary(): string {
        const entries = this.getAll();
        if (entries.length === 0) return 'Nenhuma ferramenta forjada ainda.';

        const lines = entries.map(e =>
            `- ${e.name}: ${e.description} (usada ${e.executionCount}x, arquivo: ${e.filename})`,
        );
        return `Ferramentas forjadas disponíveis:\n${lines.join('\n')}`;
    }
}
