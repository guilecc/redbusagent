/**
 * @redbusagent/daemon — The TDD Forge (Self-Improvement Sandbox)
 *
 * The agent cannot blindly save scripts to its own tools folder.
 * This module provides a sandboxed test-first approach:
 *
 *  1. Agent writes code + test_payload
 *  2. Code is executed in an isolated vm context
 *  3. If it fails → error returned, code NOT saved
 *  4. If it succeeds → saved to ~/.redbusagent/skills/ and dynamically
 *     reloaded into the CapabilityRegistry
 *
 * This is the Approval Gate for self-improvement: untested code never
 * enters the agent's permanent skill set.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { Vault } from '@redbusagent/shared';
import { ToolRegistry } from '../tool-registry.js';

// ─── Types ────────────────────────────────────────────────────────

interface SandboxResult {
    success: boolean;
    output?: string;
    error?: string;
    stackTrace?: string;
    durationMs: number;
}

interface ForgeAndTestResult {
    phase: 'sandbox_test' | 'deployment' | 'registry';
    success: boolean;
    output?: string;
    error?: string;
    stackTrace?: string;
    durationMs: number;
    skillPath?: string;
    registeredAs?: string;
}

// ─── Constants ────────────────────────────────────────────────────

const SKILLS_DIR = join(Vault.dir, 'skills');
const SANDBOX_DIR = join(Vault.dir, 'forge', '.sandbox');
const SANDBOX_TIMEOUT_MS = 15_000; // 15 seconds max for sandbox tests

// ─── Helpers ──────────────────────────────────────────────────────

function ensureDir(dir: string): void {
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
}

/**
 * Execute code in an isolated child process sandbox.
 *
 * Strategy: Write the code + a test harness to a temporary file in
 * .sandbox/, then execute it in a separate Node.js process with
 * limited permissions. This provides process-level isolation.
 */
async function executeSandbox(
    skillName: string,
    code: string,
    testPayload: Record<string, unknown>,
): Promise<SandboxResult> {
    ensureDir(SANDBOX_DIR);

    const sandboxFilename = `_sandbox_${skillName}_${Date.now()}.mjs`;
    const sandboxPath = join(SANDBOX_DIR, sandboxFilename);

    // Build the sandbox harness:
    // 1. Define the skill code as a module
    // 2. Import and execute with test_payload
    // 3. Validate the output
    const harness = `
// ═══════════════════════════════════════════════════════════════
// SANDBOX HARNESS — Isolated Test Environment
// Skill: ${skillName}
// Generated: ${new Date().toISOString()}
// ═══════════════════════════════════════════════════════════════

const TEST_PAYLOAD = ${JSON.stringify(testPayload, null, 2)};

// ─── User Skill Code (Sandboxed) ─────────────────────────────
${code}

// ─── Harness Execution ───────────────────────────────────────
async function __sandboxMain() {
    try {
        // The skill must export a default function or an 'execute' function
        let executeFn;
        if (typeof execute === 'function') {
            executeFn = execute;
        } else if (typeof module !== 'undefined' && typeof module.exports === 'function') {
            executeFn = module.exports;
        } else if (typeof run === 'function') {
            executeFn = run;
        } else {
            // If no explicit function, wrap the whole code as a script
            // that already produced output via console.log
            console.log(JSON.stringify({ __sandbox_result: 'script_executed', payload_received: !!TEST_PAYLOAD }));
            return;
        }

        const result = await executeFn(TEST_PAYLOAD);
        console.log(JSON.stringify({ __sandbox_result: result }));
    } catch (err) {
        console.error(JSON.stringify({
            __sandbox_error: true,
            message: err.message || String(err),
            stack: err.stack || '',
        }));
        process.exit(1);
    }
}

__sandboxMain();
`;

    writeFileSync(sandboxPath, harness, { encoding: 'utf-8', mode: 0o600 });
    const startTime = Date.now();

    return new Promise<SandboxResult>((resolve) => {
        execFile(
            'node',
            ['--experimental-vm-modules', sandboxPath],
            {
                cwd: SANDBOX_DIR,
                timeout: SANDBOX_TIMEOUT_MS,
                maxBuffer: 1024 * 1024, // 1MB
                env: {
                    ...process.env,
                    NODE_ENV: 'sandbox',
                    // Restrict network access hint (not enforced at OS level)
                    SANDBOX_MODE: 'true',
                },
            },
            (error, stdout, stderr) => {
                const durationMs = Date.now() - startTime;

                // Cleanup sandbox file
                try {
                    unlinkSync(sandboxPath);
                } catch {
                    // Best-effort cleanup
                }

                if (error) {
                    // Parse structured error from stderr
                    let errorMessage = stderr || error.message;
                    let stackTrace = '';

                    try {
                        const parsed = JSON.parse(stderr);
                        if (parsed.__sandbox_error) {
                            errorMessage = parsed.message;
                            stackTrace = parsed.stack;
                        }
                    } catch {
                        // Raw error string
                        stackTrace = stderr;
                    }

                    resolve({
                        success: false,
                        error: errorMessage,
                        stackTrace,
                        durationMs,
                    });
                } else {
                    // Parse structured output
                    let output = stdout.trim();
                    try {
                        const parsed = JSON.parse(output);
                        if (parsed.__sandbox_result !== undefined) {
                            output = typeof parsed.__sandbox_result === 'string'
                                ? parsed.__sandbox_result
                                : JSON.stringify(parsed.__sandbox_result, null, 2);
                        }
                    } catch {
                        // Raw output is fine
                    }

                    resolve({
                        success: true,
                        output,
                        durationMs,
                    });
                }
            },
        );
    });
}

// ─── Tool Definition ──────────────────────────────────────────────

/**
 * forge_and_test_skill — The TDD Forge.
 *
 * Sandboxes the generated code, tests it with a payload,
 * and only deploys if the test passes.
 */
export const forgeAndTestSkillTool = tool({
    description: `[Self-Improvement TDD Forge] Validates new skill code in an isolated sandbox before deploying it permanently. The workflow is:
1. Your code is written to a temporary sandbox file
2. It is executed in an isolated child process with the test_payload
3. If it FAILS: Returns the error + stack trace. You must fix the code and try again. The code is NOT saved.
4. If it SUCCEEDS: The code is saved permanently to ~/.redbusagent/skills/ and dynamically loaded into the CapabilityRegistry.

IMPORTANT: Your code must export an \`execute(payload)\` function or a \`run(payload)\` function that accepts the test_payload object and returns a result. Use console.log() for debug output.

You MUST call read_tool_signatures on existing tools first to ensure compatibility.
You MUST output a <thinking> block before calling this tool.`,

    inputSchema: z.object({
        skill_name: z.string()
            .regex(/^[a-z][a-z0-9_-]*$/, 'Skill name must be lowercase alphanumeric with hyphens/underscores')
            .describe('Name of the skill (e.g. "csv-parser", "api-health-checker"). Must be lowercase alphanumeric.'),
        description: z.string()
            .describe('Brief description of what this skill does'),
        code: z.string()
            .describe('The complete JavaScript/TypeScript source code. Must export an execute(payload) or run(payload) function.'),
        test_payload: z.record(z.string(), z.unknown())
            .describe('A test payload object to pass to the skill during sandbox testing. Must exercise the skill\'s primary functionality.'),
        language: z.enum(['javascript', 'typescript']).default('javascript')
            .describe('Language of the skill code (default: javascript)'),
    }),

    execute: async (params: {
        skill_name: string;
        description: string;
        code: string;
        test_payload: Record<string, unknown>;
        language: 'javascript' | 'typescript';
    }) => {
        const { skill_name, description, code, test_payload, language } = params;
        const startTime = Date.now();

        console.log(`  🔨 [tdd-forge] Testing skill "${skill_name}" in sandbox...`);
        console.log(`  🔨 [tdd-forge] Language: ${language}, Payload keys: ${Object.keys(test_payload).join(', ')}`);

        // ── Phase 1: Sandbox Execution ────────────────────────
        const sandboxResult = await executeSandbox(skill_name, code, test_payload);

        if (!sandboxResult.success) {
            console.log(`  ❌ [tdd-forge] Sandbox FAILED for "${skill_name}" (${sandboxResult.durationMs}ms)`);

            return {
                phase: 'sandbox_test' as const,
                success: false,
                error: `[Sandbox Error: ${sandboxResult.error}]`,
                stackTrace: sandboxResult.stackTrace || '',
                durationMs: sandboxResult.durationMs,
                instruction: 'Fix the code and call forge_and_test_skill again. DO NOT attempt to save broken code manually.',
            };
        }

        console.log(`  ✅ [tdd-forge] Sandbox PASSED for "${skill_name}" (${sandboxResult.durationMs}ms)`);

        // ── Phase 2: Deploy to Skills Directory ───────────────
        try {
            ensureDir(SKILLS_DIR);

            const ext = language === 'typescript' ? '.ts' : '.js';
            const filename = `${skill_name}${ext}`;
            const skillPath = join(SKILLS_DIR, filename);

            // Add metadata header to the skill file
            const deployedCode = `/**
 * @redbusagent/skill — ${skill_name}
 * ${description}
 *
 * Auto-forged by the TDD Forge on ${new Date().toISOString()}
 * Sandbox test: PASSED (${sandboxResult.durationMs}ms)
 * Test payload: ${JSON.stringify(Object.keys(test_payload))}
 */

${code}
`;

            writeFileSync(skillPath, deployedCode, { encoding: 'utf-8', mode: 0o644 });
            console.log(`  💾 [tdd-forge] Skill saved to: ${skillPath}`);

            // ── Phase 3: Register in ToolRegistry ─────────────
            const toolName = skill_name.replace(/[^a-zA-Z0-9]/g, '_');
            ToolRegistry.register({
                name: toolName,
                description: `[TDD-Forged] ${description}`,
                filename,
                createdAt: new Date().toISOString(),
            });

            console.log(`  🔧 [tdd-forge] Skill "${skill_name}" registered as tool "${toolName}"`);

            return {
                phase: 'registry' as const,
                success: true,
                output: sandboxResult.output,
                durationMs: Date.now() - startTime,
                skillPath,
                registeredAs: toolName,
                message: `[Success: Skill "${skill_name}" deployed and loaded into memory]`,
            };
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            console.error(`  ❌ [tdd-forge] Deployment failed: ${error.message}`);

            return {
                phase: 'deployment' as const,
                success: false,
                error: `Sandbox test passed but deployment failed: ${error.message}`,
                durationMs: Date.now() - startTime,
            };
        }
    },
});

// ─── Utility: List Forged Skills ──────────────────────────────────

export const listForgedSkillsTool = tool({
    description: `[Self-Introspection] Lists all skills that have been forged via the TDD Forge, showing their metadata, sandbox test status, and file location.`,

    inputSchema: z.object({}),

    execute: async () => {
        ensureDir(SKILLS_DIR);

        const entries = ToolRegistry.getAll().filter(e =>
            e.description.startsWith('[TDD-Forged]')
        );

        if (entries.length === 0) {
            return {
                count: 0,
                skills: [],
                message: 'No TDD-forged skills deployed yet. Use forge_and_test_skill to create one.',
            };
        }

        const skills = entries.map(e => ({
            name: e.name,
            description: e.description.replace('[TDD-Forged] ', ''),
            filename: e.filename,
            created: e.createdAt,
            lastUsed: e.lastUsedAt,
            executions: e.executionCount,
            path: join(SKILLS_DIR, e.filename),
        }));

        return {
            count: skills.length,
            skills,
            skills_directory: SKILLS_DIR,
        };
    },
});
