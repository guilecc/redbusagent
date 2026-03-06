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
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { Vault } from '@redbusagent/shared';
import { Forge, buildExecutableArtifact, buildForgeCritiqueSignal } from '../forge.js';
import { ToolRegistry } from '../tool-registry.js';

// ─── Types ────────────────────────────────────────────────────────

interface SandboxResult {
    success: boolean;
    output?: string;
    error?: string;
    stackTrace?: string;
    durationMs: number;
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
    language: 'javascript' | 'typescript',
): Promise<SandboxResult> {
    ensureDir(SANDBOX_DIR);

    const sandboxFilename = `_sandbox_${skillName}_${Date.now()}.cjs`;
    const sandboxPath = join(SANDBOX_DIR, sandboxFilename);

    writeFileSync(sandboxPath, buildExecutableArtifact(language, code), { encoding: 'utf-8', mode: 0o600 });
    const startTime = Date.now();

    return new Promise<SandboxResult>((resolve) => {
        execFile(
            'node',
            [sandboxPath, JSON.stringify(testPayload)],
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
                    const normalizedStderr = stderr.trim();
                    const normalizedStdout = stdout.trim();
                    const errorMessage = normalizedStderr || normalizedStdout || error.message;
                    const stackTrace = normalizedStderr || normalizedStdout;

                    resolve({
                        success: false,
                        error: errorMessage,
                        stackTrace,
                        durationMs,
                    });
                } else {
                    let output = stdout.trim();
                    try {
                        const parsed = JSON.parse(output) as unknown;
                        output = typeof parsed === 'string'
                            ? parsed
                            : JSON.stringify(parsed, null, 2);
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

TypeScript and ESM-style exports are accepted, but they are normalized to executable JavaScript before sandboxing and persistence. The callable contract still must resolve to \`execute(payload)\`, \`run(payload)\`, or a default-exported function.

CRITICAL — FEW-SHOT EXAMPLES ARE MANDATORY:
You are an elite Cloud Engineer forging a tool for a smaller, highly-aligned local model (Gemma 3). Small models fail to use tools without concrete Few-Shot examples. When generating the tool schema, you MUST include a \`usage_examples\` array containing at least two pairs of [Simulated User Input] and [Expected JSON Tool Call]. Do not skip this, or the executing model will fail.

You MUST call read_tool_signatures on existing tools first to ensure compatibility.
You MUST output a <thinking> block before calling this tool.`,

    inputSchema: z.object({
        skill_name: z.string()
            .regex(/^[a-z][a-z0-9_-]*$/, 'Skill name must be lowercase alphanumeric with hyphens/underscores')
            .describe('Name of the skill (e.g. "csv-parser", "api-health-checker"). Must be lowercase alphanumeric.'),
        description: z.string()
            .describe('Brief description of what this skill does'),
        forging_reason: z.string()
            .describe('Why this skill is being forged right now. Persisted as manifest metadata for the Studio skill library.'),
        code: z.string()
            .describe('The complete JavaScript/TypeScript source code. Must define or export an execute(payload) or run(payload) function.'),
        test_payload: z.record(z.string(), z.unknown())
            .describe('A test payload object to pass to the skill during sandbox testing. Must exercise the skill\'s primary functionality.'),
        language: z.enum(['javascript', 'typescript']).default('javascript')
            .describe('Language of the skill code (default: javascript)'),
        usage_examples: z.array(z.object({
            user_input: z.string().describe('Simulated user input that would trigger this tool'),
            expected_tool_call: z.object({
                name: z.string().describe('The tool name'),
                args: z.record(z.string(), z.unknown()).describe('The expected arguments'),
            }).describe('The JSON tool call the model should produce'),
        })).min(2).describe('MANDATORY: At least 2 few-shot usage examples showing [User Input] → [Expected Tool Call]. These are critical for the local Gemma 3 model to reliably invoke this tool.'),
    }),

    execute: async (params: {
        skill_name: string;
        description: string;
        forging_reason: string;
        code: string;
        test_payload: Record<string, unknown>;
        language: 'javascript' | 'typescript';
        usage_examples: Array<{ user_input: string; expected_tool_call: { name: string; args: Record<string, unknown> } }>;
    }) => {
        const { skill_name, description, forging_reason, code, test_payload, language, usage_examples } = params;
        const startTime = Date.now();

        console.log(`  🔨 [tdd-forge] Testing skill "${skill_name}" in sandbox...`);
        console.log(`  🔨 [tdd-forge] Language: ${language}, Payload keys: ${Object.keys(test_payload).join(', ')}`);

        // ── Phase 1: Sandbox Execution ────────────────────────
        const sandboxResult = await executeSandbox(skill_name, code, test_payload, language);

        if (!sandboxResult.success) {
            console.log(`  ❌ [tdd-forge] Sandbox FAILED for "${skill_name}" (${sandboxResult.durationMs}ms)`);

            return {
                phase: 'sandbox_test' as const,
                success: false,
                error: `[Sandbox Error: ${sandboxResult.error}]`,
                stackTrace: sandboxResult.stackTrace || '',
                durationMs: sandboxResult.durationMs,
                instruction: 'Fix the code and call forge_and_test_skill again. DO NOT attempt to save broken code manually.',
                critique: buildForgeCritiqueSignal({
                    phase: 'sandbox_test',
                    filename: skill_name,
                    summary: `Sandbox validation failed for ${skill_name}. Repair the skill and rerun forge_and_test_skill before deployment.`,
                    instruction: 'Fix the failing skill implementation, ensure the test payload passes in sandbox, and retry forge_and_test_skill.',
                    evidence: [sandboxResult.error, sandboxResult.stackTrace].filter(Boolean).join('\n\n'),
                }),
            };
        }

        console.log(`  ✅ [tdd-forge] Sandbox PASSED for "${skill_name}" (${sandboxResult.durationMs}ms)`);

        // ── Phase 2: Deploy to Skills Directory ───────────────
        try {
            const toolName = skill_name.replace(/[^a-zA-Z0-9]/g, '_');
            const createdAt = new Date().toISOString();
            const persisted = Forge.persistSkillPackage({
                skillName: skill_name,
                toolName,
                description,
                forgingReason: forging_reason,
                code,
                language,
                source: 'forge-tdd',
                createdAt,
                sandboxDurationMs: sandboxResult.durationMs,
                testPayload: test_payload,
                studentInstructions: {
                    tool_name: toolName,
                    summary: description,
                    usage_examples,
                },
            });

            console.log(`  💾 [tdd-forge] Skill package saved to: ${persisted.packagePath}`);

            // ── Phase 3: Register in ToolRegistry ─────────────
            ToolRegistry.register({
                name: toolName,
                description: `[TDD-Forged] ${description}`,
                filename: persisted.skillPackage.manifest.entrypoint,
                createdAt,
                usage_examples,
                student_instructions: persisted.skillPackage.student_instructions,
                skillPackagePath: persisted.packagePath,
            });

            console.log(`  🔧 [tdd-forge] Skill "${skill_name}" registered as tool "${toolName}"`);

            return {
                phase: 'registry' as const,
                success: true,
                output: sandboxResult.output,
                durationMs: Date.now() - startTime,
                skillPath: persisted.entrypointPath,
                skillPackagePath: persisted.packagePath,
                registeredAs: toolName,
                forgingReason: forging_reason,
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
                critique: buildForgeCritiqueSignal({
                    phase: 'deployment',
                    filename: skill_name,
                    summary: `Deployment failed for ${skill_name} after sandbox success. Repair the persistence or registration issue before retrying.`,
                    instruction: 'Fix the deployment failure and call forge_and_test_skill again so the validated skill can be persisted and registered.',
                    evidence: error.message,
                }),
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
            path: e.skillPackagePath ? join(dirname(e.skillPackagePath), e.filename) : join(SKILLS_DIR, e.filename),
            skillPackagePath: e.skillPackagePath,
        }));

        return {
            count: skills.length,
            skills,
            skills_directory: SKILLS_DIR,
        };
    },
});
