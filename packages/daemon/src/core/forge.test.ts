import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Forge, buildForgeCritiqueSignal, formatForgeFailureDetails } from './forge.js';
import { executeCreateAndRun } from './tools/create-and-run.js';

const createdFiles = new Set<string>();
const createdDirs = new Set<string>();

function trackForgeFile(filename: string): string {
    const path = join(Forge.dir, filename);
    createdFiles.add(path);
    return filename;
}

afterEach(() => {
    for (const path of createdFiles) {
        if (existsSync(path)) unlinkSync(path);
    }
    for (const dir of createdDirs) {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    createdFiles.clear();
    createdDirs.clear();
});

describe('Forge execution diagnostics', () => {
    it('captures stderr and exec metadata when a forged node script throws', async () => {
        Forge.ensureWorkspace();
        const filename = trackForgeFile(`forge-error-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);

        Forge.writeScript(filename, `
const fs = require('node:fs');
fs.writeFileSync('bad-output.txt', { broken: true });
`);

        const result = await Forge.executeScript(filename);

        expect(result.success).toBe(false);
        expect(result.stderr).toMatch(/ERR_INVALID_ARG_TYPE|The "data" argument/);
        expect(result.errorMessage).toContain('Command failed');
        expect(result.failedCommand).toContain(filename);
        expect(result.combinedOutput).toContain('stderr:');
        expect(result.combinedOutput).toMatch(/ERR_INVALID_ARG_TYPE|The "data" argument/);
    });

    it('formats forge failures into actionable diagnostics', () => {
        const diagnostics = formatForgeFailureDetails('outlook-summary.js', {
            success: false,
            exitCode: 1,
            stdout: 'partial stdout',
            stderr: 'TypeError [ERR_INVALID_ARG_TYPE]: The "data" argument must be of type string',
            durationMs: 42,
            errorMessage: 'Command failed: node /tmp/outlook-summary.js',
            failedCommand: 'node /tmp/outlook-summary.js',
        });

        expect(diagnostics).toContain('Forge execution failed for outlook-summary.js.');
        expect(diagnostics).toContain('Command: node /tmp/outlook-summary.js');
        expect(diagnostics).toContain('Runtime error: Command failed: node /tmp/outlook-summary.js');
        expect(diagnostics).toContain('stderr:\nTypeError [ERR_INVALID_ARG_TYPE]');
        expect(diagnostics).toContain('stdout:\npartial stdout');
    });

    it('builds structured critique signals for repair loops', () => {
        const critique = buildForgeCritiqueSignal({
            phase: 'execution',
            filename: 'outlook-summary.js',
            evidence: 'TypeError [ERR_INVALID_ARG_TYPE]: bad write',
        });

        expect(critique).toMatchObject({
            verdict: 'revise',
            phase: 'execution',
        });
        expect(critique.summary).toContain('outlook-summary.js');
        expect(critique.instruction).toContain('retry the same tool call');
        expect(critique.evidence).toContain('ERR_INVALID_ARG_TYPE');
    });
});

describe('executeCreateAndRun', () => {
    it('returns structured diagnostics when forged execution fails', async () => {
        const filename = trackForgeFile(`create-run-error-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
        const result = await executeCreateAndRun({
            filename,
            description: 'Reproduce invalid data write failure',
            code: `
const fs = require('node:fs');
fs.writeFileSync('should-not-exist.txt', { nope: true });
`,
            dependencies: [],
        });

        expect(result.success).toBe(false);
        if (result.success) return;

        expect(result.phase).toBe('execution');
        expect(result.error).toContain(`Forge execution failed for ${filename}.`);
        expect(result.error).toMatch(/ERR_INVALID_ARG_TYPE|The "data" argument/);
        expect(result.stderr).toMatch(/ERR_INVALID_ARG_TYPE|The "data" argument/);
        expect(result.failedCommand).toContain(filename);
        expect(result.diagnostics).toContain(`Command: node ${join(Forge.dir, filename)}`);
        expect(result.diagnostics).toContain('stderr:');
        if (result.success) {
            throw new Error('Expected executeCreateAndRun to fail for the forged runtime error case.');
        }
        expect(result.critique).toMatchObject({
            verdict: 'revise',
            phase: 'execution',
        });
        expect(result.critique.summary).toContain(filename);
        expect(result.critique.instruction).toContain('create_and_run_tool again');
    });
});

describe('Forge skill packages', () => {
    it('persists structured skill packages with executable artifacts and student instructions', async () => {
        const skillName = `skill-package-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const packageDir = Forge.getSkillPackageDir(skillName);
        createdDirs.add(packageDir);

        const persisted = Forge.persistSkillPackage({
            skillName,
            toolName: 'package_echo',
            description: 'Echo back a structured payload',
            code: `async function execute(payload) { return { echoed: payload.message ?? null }; }`,
            language: 'javascript',
            source: 'forge-tdd',
            studentInstructions: {
                tool_name: 'package_echo',
                summary: 'Use package_echo when the user wants a structured echo response.',
                usage_examples: [
                    {
                        user_input: 'Echo hello back to me',
                        expected_tool_call: { name: 'package_echo', args: { message: 'hello' } },
                    },
                    {
                        user_input: 'Repeat the word redbus',
                        expected_tool_call: { name: 'package_echo', args: { message: 'redbus' } },
                    },
                ],
            },
            testPayload: { message: 'from-test' },
            sandboxDurationMs: 12,
        });

        expect(existsSync(persisted.packagePath)).toBe(true);
        expect(existsSync(persisted.entrypointPath)).toBe(true);

        const onDisk = JSON.parse(readFileSync(persisted.packagePath, 'utf-8'));
        expect(onDisk.schemaVersion).toBe(1);
        expect(onDisk.manifest.skillName).toBe(skillName);
        expect(onDisk.manifest.entrypoint).toBe('index.js');
        expect(onDisk.student_instructions.tool_name).toBe('package_echo');
        expect(onDisk.student_instructions.usage_examples).toHaveLength(2);

        const result = await Forge.executeScriptAtPath(persisted.entrypointPath, JSON.stringify({ message: 'from-runtime' }));
        expect(result.success).toBe(true);
        expect(result.stdout).toContain('from-runtime');
    });
});