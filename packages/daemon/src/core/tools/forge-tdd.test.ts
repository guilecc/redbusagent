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
    it('deploys tested skills as structured skill packages and registers student instructions', async () => {
        const skillName = `echo-pkg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const executeTool = (forgeAndTestSkillTool as any).execute;

        const result = await executeTool({
            skill_name: skillName,
            description: 'Echo a structured message payload',
            code: `async function execute(payload) { return { echoed: payload.message ?? 'missing' }; }`,
            test_payload: { message: 'sandbox-pass' },
            language: 'javascript',
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
});