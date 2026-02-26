/**
 * End-to-end test for the Dual-Language Forge (Node.js + Python).
 *
 * Run with:  npx tsx test-forge-python.ts
 *
 * Tests:
 *  1. Language detection (.js → node, .py → python)
 *  2. Workspace setup (ensureWorkspace)
 *  3. Node.js script execution (baseline sanity check)
 *  4. Python venv creation (ensurePythonVenv)
 *  5. Python script execution (simple print)
 *  6. Python with pip dependency (installs + imports a real package)
 *  7. Python parameter passing (sys.argv)
 *  8. Tool registration for .py files (toolName extraction)
 *  9. Re-execution of a registered Python tool via Forge.executeScript
 */

import { Forge } from './src/core/forge.js';
import { ToolRegistry } from './src/core/tool-registry.js';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// ── Helpers ───────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
    if (condition) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.error(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
        failed++;
    }
}

// ── Cleanup helper ────────────────────────────────────────────────

function cleanupTestFiles() {
    const files = ['_test_hello.js', '_test_hello.py', '_test_deps.py', '_test_args.py'];
    for (const f of files) {
        const fp = join(Forge.dir, f);
        if (existsSync(fp)) rmSync(fp);
    }
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
    console.log('\n🔬 Forge Dual-Language E2E Test\n');

    // ── 1. Language detection ──────────────────────────────────────
    console.log('── 1. Language Detection ──');
    assert(Forge.detectLanguage('foo.js') === 'node', 'foo.js → node');
    assert(Forge.detectLanguage('bar.py') === 'python', 'bar.py → python');
    assert(Forge.detectLanguage('script.mjs') === 'node', 'script.mjs → node (fallback)');

    // ── 2. Workspace setup ─────────────────────────────────────────
    console.log('\n── 2. Workspace Setup ──');
    Forge.ensureWorkspace();
    assert(existsSync(Forge.dir), `Forge dir exists: ${Forge.dir}`);
    assert(existsSync(join(Forge.dir, 'package.json')), 'package.json exists');

    // ── 3. Node.js execution (baseline) ────────────────────────────
    console.log('\n── 3. Node.js Execution (baseline) ──');
    Forge.writeScript('_test_hello.js', 'console.log("HELLO_NODE");');
    const nodeResult = await Forge.executeScript('_test_hello.js');
    assert(nodeResult.success, 'Node.js script succeeded');
    assert(nodeResult.stdout.trim() === 'HELLO_NODE', `stdout = "${nodeResult.stdout.trim()}"`);

    // ── 4. Python venv creation ────────────────────────────────────
    console.log('\n── 4. Python Venv ──');
    const venvResult = await Forge.ensurePythonVenv();
    assert(venvResult.success, `Venv created/exists`, venvResult.error);
    assert(existsSync(Forge.venvDir), `Venv dir exists: ${Forge.venvDir}`);

    // ── 5. Simple Python execution ─────────────────────────────────
    console.log('\n── 5. Python Execution (simple) ──');
    Forge.writeScript('_test_hello.py', 'print("HELLO_PYTHON")');
    const pyResult = await Forge.executeScript('_test_hello.py');
    assert(pyResult.success, 'Python script succeeded', pyResult.stderr);
    assert(pyResult.stdout.trim() === 'HELLO_PYTHON', `stdout = "${pyResult.stdout.trim()}"`);

    // ── 6. Python with pip dependency ──────────────────────────────
    console.log('\n── 6. Python pip Install + Import ──');
    const pipResult = await Forge.installPythonDependencies(['requests']);
    assert(pipResult.success, 'pip install requests succeeded', pipResult.error);

    Forge.writeScript('_test_deps.py', `
import requests
print(f"requests version: {requests.__version__}")
print("PIP_OK")
`.trim());
    const depResult = await Forge.executeScript('_test_deps.py');
    assert(depResult.success, 'Python with requests succeeded', depResult.stderr);
    assert(depResult.stdout.includes('PIP_OK'), `stdout contains PIP_OK`);
    assert(depResult.stdout.includes('requests version:'), `stdout shows requests version`);

    // ── 7. Parameter passing ───────────────────────────────────────
    console.log('\n── 7. Python Parameter Passing ──');
    Forge.writeScript('_test_args.py', `
import sys
import json
if len(sys.argv) > 1:
    data = json.loads(sys.argv[1])
    print(json.dumps({"received": data, "ok": True}))
else:
    print(json.dumps({"received": None, "ok": False}))
`.trim());
    const argResult = await Forge.executeScript('_test_args.py', JSON.stringify({ name: 'test', value: 42 }));
    assert(argResult.success, 'Python args script succeeded', argResult.stderr);
    const parsed = JSON.parse(argResult.stdout.trim());
    assert(parsed.ok === true, 'Received ok=true');
    assert(parsed.received?.name === 'test', 'Received name=test');
    assert(parsed.received?.value === 42, 'Received value=42');

    // ── 8. Tool registration for .py ───────────────────────────────
    console.log('\n── 8. Tool Registration (.py) ──');
    const toolName = '_test_hello'.replace(/\.(js|py)$/, '').replace(/[^a-zA-Z0-9]/g, '_');
    ToolRegistry.ensureFile();
    ToolRegistry.register({
        name: toolName,
        description: 'E2E test Python tool',
        filename: '_test_hello.py',
        createdAt: new Date().toISOString(),
    });
    const all = ToolRegistry.getAll();
    const found = all.find(t => t.name === toolName);
    assert(!!found, `Tool "${toolName}" registered in registry`);
    assert(found?.filename === '_test_hello.py', `Filename is .py`);

    // ── 9. Re-execute registered Python tool ───────────────────────
    console.log('\n── 9. Re-execute Registered Python Tool ──');
    const reExec = await Forge.executeScript('_test_hello.py');
    assert(reExec.success, 'Re-execution succeeded');
    assert(reExec.stdout.trim() === 'HELLO_PYTHON', 'Re-execution output correct');

    // ── Cleanup ────────────────────────────────────────────────────
    cleanupTestFiles();

    // ── Summary ────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log(`${'─'.repeat(50)}\n`);

    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error('💥 Test crashed:', err);
    process.exit(1);
});

