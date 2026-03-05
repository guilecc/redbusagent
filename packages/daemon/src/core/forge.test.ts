import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Forge, formatForgeFailureDetails } from './forge.js';
import { executeCreateAndRun } from './tools/create-and-run.js';

const createdFiles = new Set<string>();

function trackForgeFile(filename: string): string {
    const path = join(Forge.dir, filename);
    createdFiles.add(path);
    return filename;
}

afterEach(() => {
    for (const path of createdFiles) {
        if (existsSync(path)) unlinkSync(path);
    }
    createdFiles.clear();
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
    });
});