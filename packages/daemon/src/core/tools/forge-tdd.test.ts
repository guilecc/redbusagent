import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Forge } from '../forge.js';
import { ToolRegistry } from '../tool-registry.js';
import { forgeAndTestSkillTool } from './forge-tdd.js';

const createdDirs = new Set<string>();
let registryBackup: string | null = null;

beforeEach(() => {
    registryBackup = existsSync(ToolRegistry.path) ? readFileSync(ToolRegistry.path, 'utf-8') : null;
    ToolRegistry.ensureFile();
});

afterEach(() => {
    for (const dir of createdDirs) {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    createdDirs.clear();

    if (registryBackup == null) {
        rmSync(ToolRegistry.path, { force: true });
    } else {
        writeFileSync(ToolRegistry.path, registryBackup, 'utf-8');
    }
});

describe('forgeAndTestSkillTool', () => {
    it('deploys tested TypeScript skills as structured skill packages and registers student instructions', async () => {
        const skillName = `echo-pkg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const executeTool = (forgeAndTestSkillTool as any).execute;

        const result = await executeTool({
            skill_name: skillName,
            description: 'Echo a structured message payload',
            forging_reason: 'The user asked for a reusable echo helper.',
            code: `export async function execute(payload: { message?: string }) { return { echoed: payload.message ?? 'missing' }; }`,
            test_payload: { message: 'sandbox-pass' },
            language: 'typescript',
            usage_examples: [
                {
                    user_input: 'Echo hello back to me',
                    expected_tool_call: { name: skillName.replace(/[^a-zA-Z0-9]/g, '_'), args: { message: 'hello' } },
                },
                {
                    user_input: 'Repeat redbus exactly',
                    expected_tool_call: { name: skillName.replace(/[^a-zA-Z0-9]/g, '_'), args: { message: 'redbus' } },
                },
            ],
        }, { toolCallId: 'forge-test', messages: [] });

        expect(result.success).toBe(true);
        if (!result.success) return;

        createdDirs.add(dirname(result.skillPackagePath));

        expect(result.skillPackagePath).toContain('skill-package.json');
        const skillPackage = Forge.readSkillPackage(result.skillPackagePath);
        expect(skillPackage?.manifest.source).toBe('forge-tdd');
        expect(skillPackage?.manifest.name).toBe(skillName);
        expect(skillPackage?.manifest.forging_reason).toBe('The user asked for a reusable echo helper.');
        expect(skillPackage?.manifest.entrypoint).toBe('index.cjs');
        expect(skillPackage?.manifest.language).toBe('typescript');
        expect(skillPackage?.student_instructions.tool_name).toBe(skillName.replace(/[^a-zA-Z0-9]/g, '_'));

        const registryEntry = ToolRegistry.getAll().find(entry => entry.name === skillName.replace(/[^a-zA-Z0-9]/g, '_'));
        expect(registryEntry?.skillPackagePath).toBe(result.skillPackagePath);
        expect(registryEntry?.student_instructions?.usage_examples).toHaveLength(2);

        const dynamicTools = ToolRegistry.getDynamicTools();
        const dynamicResult = await dynamicTools[skillName.replace(/[^a-zA-Z0-9]/g, '_')].execute(
            { message: 'runtime-pass' },
            { toolCallId: 'runtime-test', messages: [] },
        );

        expect(dynamicResult.success).toBe(true);
        expect(dynamicResult.output).toContain('runtime-pass');
        expect(ToolRegistry.getStudentInstructionsBlock()).toContain('Student Summary: Echo a structured message payload');
    });

    it('validates and deploys TypeScript skills with imports through the same normalized runtime path', async () => {
        const skillName = `ts-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const toolName = skillName.replace(/[^a-zA-Z0-9]/g, '_');
        const executeTool = (forgeAndTestSkillTool as any).execute;

        const result = await executeTool({
            skill_name: skillName,
            description: 'Return the basename of a provided path',
            forging_reason: 'Regression coverage for TypeScript import normalization parity.',
            code: `import { basename } from 'node:path'; export async function execute(payload: { value: string }) { return { base: basename(payload.value) }; }`,
            test_payload: { value: '/tmp/report.csv' },
            language: 'typescript',
            usage_examples: [
                {
                    user_input: 'Get the basename from this path',
                    expected_tool_call: { name: toolName, args: { value: '/tmp/report.csv' } },
                },
                {
                    user_input: 'Extract the filename from another path',
                    expected_tool_call: { name: toolName, args: { value: '/var/log/app.log' } },
                },
            ],
        }, { toolCallId: 'forge-import', messages: [] });

        expect(result.success).toBe(true);
        if (!result.success) return;

        createdDirs.add(dirname(result.skillPackagePath));

        const dynamicResult = await ToolRegistry.getDynamicTools()[toolName].execute(
            { value: '/var/log/app.log' },
            { toolCallId: 'runtime-import', messages: [] },
        );

        expect(dynamicResult.success).toBe(true);
        expect(dynamicResult.output).toContain('app.log');
    });

    it('passes resolved daemon and vault runtime paths into the forge sandbox and deployed skill runtime', async () => {
        const skillName = `runtime-paths-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const toolName = skillName.replace(/[^a-zA-Z0-9]/g, '_');
        const executeTool = (forgeAndTestSkillTool as any).execute;

        const result = await executeTool({
            skill_name: skillName,
            description: 'Echo the resolved daemon runtime paths',
            forging_reason: 'Regression coverage for Forge/Vault runtime path propagation.',
            code: `export async function execute() { return { vaultDir: process.env.REDBUSAGENT_VAULT_DIR, forgeDir: process.env.REDBUSAGENT_FORGE_DIR, daemonRoot: process.env.REDBUSAGENT_DAEMON_ROOT }; }`,
            test_payload: {},
            language: 'typescript',
            usage_examples: [
                {
                    user_input: 'Show me the current forge runtime paths',
                    expected_tool_call: { name: toolName, args: {} },
                },
                {
                    user_input: 'Print the daemon runtime path information again',
                    expected_tool_call: { name: toolName, args: {} },
                },
            ],
        }, { toolCallId: 'forge-runtime-paths', messages: [] });

        expect(result.success).toBe(true);
        if (!result.success) return;

        createdDirs.add(dirname(result.skillPackagePath));

        const sandboxOutput = JSON.parse(result.output.trim()) as Record<string, string>;
        expect(sandboxOutput.vaultDir).toBeTruthy();
        expect(sandboxOutput.forgeDir).toBe(Forge.dir);
        expect(sandboxOutput.daemonRoot).toBe(Forge.daemonRoot);

        const dynamicResult = await ToolRegistry.getDynamicTools()[toolName].execute(
            {},
            { toolCallId: 'runtime-paths-dynamic', messages: [] },
        );

        expect(dynamicResult.success).toBe(true);
        if (!dynamicResult.success) return;

        const runtimeOutput = JSON.parse(dynamicResult.output.trim()) as Record<string, string>;
        expect(runtimeOutput.vaultDir).toBeTruthy();
        expect(runtimeOutput.forgeDir).toBe(Forge.dir);
        expect(runtimeOutput.daemonRoot).toBe(Forge.daemonRoot);
    });

    it('rejects forged skills that do not expose an execute or run callable', async () => {
        const skillName = `invalid-pkg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const executeTool = (forgeAndTestSkillTool as any).execute;

        const result = await executeTool({
            skill_name: skillName,
            description: 'Invalid skill without a callable entrypoint',
            forging_reason: 'Regression coverage for sandbox/runtime validation parity.',
            code: `export const meaning = 42;`,
            test_payload: { probe: true },
            language: 'typescript',
            usage_examples: [
                {
                    user_input: 'Probe the invalid skill',
                    expected_tool_call: { name: skillName.replace(/[^a-zA-Z0-9]/g, '_'), args: { probe: true } },
                },
                {
                    user_input: 'Run the probe again',
                    expected_tool_call: { name: skillName.replace(/[^a-zA-Z0-9]/g, '_'), args: { probe: false } },
                },
            ],
        }, { toolCallId: 'forge-invalid', messages: [] });

        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error).toContain('Skill must define or export an execute(payload) or run(payload) function.');
    });
});