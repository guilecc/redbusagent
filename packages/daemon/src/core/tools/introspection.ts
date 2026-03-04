/**
 * @redbusagent/daemon — Self-Introspection Tools
 *
 * Before the agent writes a new tool for itself, it must understand
 * the environment it lives in. These tools provide deep self-awareness
 * of the agent's own architecture, file structure, and tool signatures.
 *
 * Tools:
 *  • read_own_architecture — Returns a structured tree of core/ and skills/
 *  • read_tool_signatures  — Extracts interfaces, exports, and payloads from a file
 */

import { tool } from 'ai';
import { z } from 'zod';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';

// ─── Types ────────────────────────────────────────────────────────

export interface TreeNode {
    name: string;
    type: 'file' | 'directory';
    size?: number;
    children?: TreeNode[];
    language?: string;
}

interface SignatureInfo {
    exports: string[];
    interfaces: string[];
    types: string[];
    functions: string[];
    classes: string[];
    toolDefinitions: string[];
    zodSchemas: string[];
    imports: string[];
}

// ─── Constants ────────────────────────────────────────────────────

// The daemon source root — the agent's own body
const DAEMON_SRC = join(import.meta.dirname, '..');  // core/ is at src/core, so .. = src/
const CORE_DIR = join(DAEMON_SRC, 'core');
const SKILLS_DIR = join(DAEMON_SRC, '..', '..', '..', '..', 'workspace', 'skills');

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.venv', '__pycache__']);
const LANG_MAP: Record<string, string> = {
    '.ts': 'typescript',
    '.js': 'javascript',
    '.py': 'python',
    '.json': 'json',
    '.md': 'markdown',
};

// ─── Helpers ──────────────────────────────────────────────────────

async function buildTree(dirPath: string, maxDepth: number = 4, currentDepth: number = 0): Promise<TreeNode[]> {
    if (currentDepth >= maxDepth) return [];

    const nodes: TreeNode[] = [];

    let entries: string[];
    try {
        entries = await readdir(dirPath);
    } catch {
        return nodes;
    }

    for (const entry of entries.sort()) {
        if (IGNORE_DIRS.has(entry) || entry.startsWith('.')) continue;

        const fullPath = join(dirPath, entry);

        try {
            const s = await stat(fullPath);

            if (s.isDirectory()) {
                const children = await buildTree(fullPath, maxDepth, currentDepth + 1);
                nodes.push({
                    name: entry,
                    type: 'directory',
                    children,
                });
            } else if (s.isFile()) {
                const ext = extname(entry);
                nodes.push({
                    name: entry,
                    type: 'file',
                    size: s.size,
                    language: LANG_MAP[ext] || ext.slice(1) || 'unknown',
                });
            }
        } catch {
            // Skip unreadable entries
        }
    }

    return nodes;
}

function extractSignatures(source: string, filePath: string): SignatureInfo {
    const info: SignatureInfo = {
        exports: [],
        interfaces: [],
        types: [],
        functions: [],
        classes: [],
        toolDefinitions: [],
        zodSchemas: [],
        imports: [],
    };

    const lines = source.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();

        // Imports
        if (trimmed.startsWith('import ')) {
            info.imports.push(trimmed);
            continue;
        }

        // Export interfaces: export interface FooBar { ... }
        const ifaceMatch = trimmed.match(/^export\s+interface\s+(\w+)/);
        if (ifaceMatch) {
            info.interfaces.push(ifaceMatch[1]!);
            info.exports.push(`interface ${ifaceMatch[1]}`);
            continue;
        }

        // Export types: export type FooBar = ...
        const typeMatch = trimmed.match(/^export\s+type\s+(\w+)/);
        if (typeMatch) {
            info.types.push(typeMatch[1]!);
            info.exports.push(`type ${typeMatch[1]}`);
            continue;
        }

        // Export classes: export class FooBar { ... }
        const classMatch = trimmed.match(/^export\s+class\s+(\w+)/);
        if (classMatch) {
            info.classes.push(classMatch[1]!);
            info.exports.push(`class ${classMatch[1]}`);
            continue;
        }

        // Export functions: export function fooBar(...) or export async function fooBar(...)
        const funcMatch = trimmed.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
        if (funcMatch) {
            info.functions.push(funcMatch[1]!);
            info.exports.push(`function ${funcMatch[1]}`);
            continue;
        }

        // Export const (tools, etc): export const fooBarTool = tool({...})
        const constMatch = trimmed.match(/^export\s+const\s+(\w+)/);
        if (constMatch) {
            const name = constMatch[1]!;
            info.exports.push(`const ${name}`);

            // Detect tool() definitions
            if (trimmed.includes('tool(')) {
                info.toolDefinitions.push(name);
            }
            continue;
        }

        // Zod schemas: z.object, z.string, etc. in inputSchema definitions
        const zodMatch = trimmed.match(/inputSchema:\s*(z\.\w+)/);
        if (zodMatch) {
            info.zodSchemas.push(zodMatch[1]!);
        }
    }

    // Extract full tool definition blocks with descriptions and inputSchemas
    const toolBlockRegex = /export\s+const\s+(\w+)\s*=\s*tool\(\{[\s\S]*?description:\s*[`'"]([\s\S]*?)[`'"][\s\S]*?inputSchema:\s*(z\.object\(\{[\s\S]*?\}\))/g;
    let match;
    while ((match = toolBlockRegex.exec(source)) !== null) {
        const toolName = match[1];
        const desc = match[2]?.slice(0, 120);
        if (toolName && !info.toolDefinitions.includes(toolName)) {
            info.toolDefinitions.push(toolName);
        }
    }

    return info;
}

function formatTreeAsString(nodes: TreeNode[], indent: string = ''): string {
    let result = '';
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!;
        const isLast = i === nodes.length - 1;
        const prefix = isLast ? '└── ' : '├── ';
        const childIndent = indent + (isLast ? '    ' : '│   ');

        if (node.type === 'directory') {
            result += `${indent}${prefix}📁 ${node.name}/\n`;
            if (node.children && node.children.length > 0) {
                result += formatTreeAsString(node.children, childIndent);
            }
        } else {
            const sizeStr = node.size ? ` (${(node.size / 1024).toFixed(1)}KB)` : '';
            const langIcon = node.language === 'typescript' ? '🔷' :
                node.language === 'javascript' ? '🟡' :
                    node.language === 'python' ? '🐍' : '📄';
            result += `${indent}${prefix}${langIcon} ${node.name}${sizeStr}\n`;
        }
    }
    return result;
}

// ─── Tool Definitions ─────────────────────────────────────────────

/**
 * read_own_architecture — Returns a structured tree map of the agent's
 * active core/ and skills/ directories, giving the LLM full structural
 * awareness before writing new code.
 */
export const readOwnArchitectureTool = tool({
    description: `[Self-Introspection] Reads the agent's own source architecture. Returns a structured tree of the core/ directory (the agent's brain), the tools/ subdirectory, and the skills/ directory. Use this BEFORE writing any new tool or skill to understand the codebase you are extending. Returns both a visual tree and structured JSON.`,

    inputSchema: z.object({
        max_depth: z.number().default(4).describe('Maximum directory depth to traverse (default: 4)'),
        include_skills: z.boolean().default(true).describe('Whether to include the skills/ directory'),
    }),

    execute: async (params: { max_depth: number; include_skills: boolean }) => {
        const { max_depth, include_skills } = params;

        console.log(`  🔍 [introspection] Reading own architecture (depth: ${max_depth})`);

        const coreTree = await buildTree(CORE_DIR, max_depth);
        let skillsTree: TreeNode[] = [];

        if (include_skills) {
            skillsTree = await buildTree(SKILLS_DIR, max_depth);
        }

        // Count files
        const countFiles = (nodes: TreeNode[]): number => {
            let count = 0;
            for (const n of nodes) {
                if (n.type === 'file') count++;
                if (n.children) count += countFiles(n.children);
            }
            return count;
        };

        const coreFileCount = countFiles(coreTree);
        const skillsFileCount = countFiles(skillsTree);

        const visualTree = [
            `🧠 AGENT ARCHITECTURE MAP`,
            `══════════════════════════════════════`,
            ``,
            `📁 core/ (${coreFileCount} files — The Agent's Brain)`,
            formatTreeAsString(coreTree),
        ];

        if (include_skills && skillsTree.length > 0) {
            visualTree.push(
                `📁 skills/ (${skillsFileCount} files — Loadable Skills)`,
                formatTreeAsString(skillsTree),
            );
        }

        return {
            visual_tree: visualTree.join('\n'),
            structured: {
                core: coreTree,
                skills: skillsTree,
                stats: {
                    core_files: coreFileCount,
                    skills_files: skillsFileCount,
                    total_files: coreFileCount + skillsFileCount,
                },
            },
        };
    },
});

/**
 * read_tool_signatures — Given a file path relative to the daemon source,
 * extracts all exported interfaces, functions, classes, tool definitions,
 * and Zod schemas. This ensures the LLM knows exactly how to format a new
 * tool so it's compatible with the CapabilityRegistry.
 */
export const readToolSignaturesTool = tool({
    description: `[Self-Introspection] Reads the exported interfaces, functions, classes, tool definitions, and Zod input schemas from a specific source file. Use this to understand the exact structure and API contracts of existing tools before building a new one. Pass either an absolute path or a path relative to the daemon src/core/ directory (e.g. "tools/create-and-run.ts" or "registry.ts").`,

    inputSchema: z.object({
        file_path: z.string().describe('Path to the file to inspect. Can be absolute or relative to src/core/ (e.g. "tools/create-and-run.ts", "forge.ts", "registry.ts")'),
        include_source: z.boolean().default(false).describe('Whether to include the full source code in the response'),
    }),

    execute: async (params: { file_path: string; include_source: boolean }) => {
        const { file_path, include_source } = params;

        // Resolve the path
        let resolvedPath: string;
        if (file_path.startsWith('/')) {
            resolvedPath = file_path;
        } else {
            resolvedPath = join(CORE_DIR, file_path);
        }

        console.log(`  🔍 [introspection] Reading signatures from: ${resolvedPath}`);

        let source: string;
        try {
            source = await readFile(resolvedPath, 'utf-8');
        } catch (err) {
            return {
                success: false,
                error: `Failed to read file: ${resolvedPath}. ${err instanceof Error ? err.message : String(err)}`,
            };
        }

        const signatures = extractSignatures(source, resolvedPath);
        const lineCount = source.split('\n').length;

        const report = [
            `📋 SIGNATURE REPORT: ${basename(resolvedPath)}`,
            `═══════════════════════════════════════`,
            `Lines: ${lineCount} | Language: ${LANG_MAP[extname(resolvedPath)] || 'unknown'}`,
            ``,
        ];

        if (signatures.imports.length > 0) {
            report.push(`📦 Imports (${signatures.imports.length}):`);
            signatures.imports.forEach(i => report.push(`   ${i}`));
            report.push('');
        }

        if (signatures.interfaces.length > 0) {
            report.push(`🔷 Interfaces: ${signatures.interfaces.join(', ')}`);
        }
        if (signatures.types.length > 0) {
            report.push(`🔶 Types: ${signatures.types.join(', ')}`);
        }
        if (signatures.classes.length > 0) {
            report.push(`🏗️ Classes: ${signatures.classes.join(', ')}`);
        }
        if (signatures.functions.length > 0) {
            report.push(`⚡ Functions: ${signatures.functions.join(', ')}`);
        }
        if (signatures.toolDefinitions.length > 0) {
            report.push(`🔧 Tool Definitions: ${signatures.toolDefinitions.join(', ')}`);
        }
        if (signatures.zodSchemas.length > 0) {
            report.push(`📐 Zod Schemas: ${signatures.zodSchemas.join(', ')}`);
        }

        report.push('');
        report.push(`📤 All Exports (${signatures.exports.length}):`);
        signatures.exports.forEach(e => report.push(`   • ${e}`));

        const result: Record<string, unknown> = {
            success: true,
            file: resolvedPath,
            line_count: lineCount,
            signatures,
            report: report.join('\n'),
        };

        if (include_source) {
            result['source'] = source;
        }

        return result;
    },
});
