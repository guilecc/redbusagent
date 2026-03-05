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

/** A single few-shot usage example for a forged tool */
export interface ToolUsageExample {
    /** Simulated user input that triggers this tool */
    user_input: string;
    /** Expected JSON tool call the model should produce */
    expected_tool_call: { name: string; args: Record<string, unknown> };
}

export interface ToolRegistryEntry {
    name: string;
    description: string;
    filename: string;
    createdAt: string;
    lastUsedAt: string;
    executionCount: number;
    /** Few-shot usage examples for Gemma 3 alignment */
    usage_examples?: ToolUsageExample[];
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
                description: `[Forged] ${entry.description}`,
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
        if (entries.length === 0) return 'No forged tools yet.';

        const lines = entries.map(e =>
            `- ${e.name}: ${e.description} (used ${e.executionCount}x, file: ${e.filename})`,
        );
        return `Available forged tools:\n${lines.join('\n')}`;
    }

    /**
     * Build a Few-Shot Examples block for injection into the Live Engine
     * (Gemma 3) system prompt. Extracts usage_examples from every registered
     * tool and formats them so the small model can reliably produce tool calls.
     */
    static getFewShotExamplesBlock(): string {
        const entries = this.getAll();
        const lines: string[] = [];

        for (const entry of entries) {
            if (!entry.usage_examples || entry.usage_examples.length === 0) continue;
            for (const ex of entry.usage_examples) {
                lines.push(
                    `Tool: ${entry.name}\n` +
                    `Example User: "${ex.user_input}"\n` +
                    `Example Action: <tool_call>${JSON.stringify({ name: ex.expected_tool_call.name, args: ex.expected_tool_call.args })}</tool_call>`,
                );
            }
        }

        if (lines.length === 0) return '';

        return `\n## FEW-SHOT TOOL USAGE EXAMPLES (Follow these patterns EXACTLY)\n\n${lines.join('\n\n')}\n`;
    }
}
