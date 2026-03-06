/**
 * @redbusagent/daemon — The Forge
 *
 * The Forge is where the agent writes, installs dependencies,
 * and executes its own Node.js and Python scripts autonomously.
 *
 * Workspace: ~/.redbusagent/forge/
 *  - Scripts are written here as .js or .py files
 *  - Has its own package.json for isolated npm installs
 *  - Has its own Python venv for isolated pip installs
 *  - Each execution is a child_process with stdout/stderr capture
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFile, type ExecFileException } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Vault } from '@redbusagent/shared';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

// ─── Types ────────────────────────────────────────────────────────

export interface ForgeExecutionResult {
    success: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    errorMessage?: string;
    errorCode?: number | string;
    signal?: NodeJS.Signals | null;
    timedOut?: boolean;
    failedCommand?: string;
    combinedOutput?: string;
}

export interface ForgeCritiqueSignal {
    verdict: 'revise' | 'blocked';
    phase: 'sandbox_test' | 'execution' | 'deployment';
    summary: string;
    instruction: string;
    evidence?: string;
}

export type ForgeLanguage = 'node' | 'python';

export type SkillPackageLanguage = 'javascript' | 'typescript' | 'python';

export interface SkillUsageExample {
    user_input: string;
    expected_tool_call: {
        name: string;
        args: Record<string, unknown>;
    };
}

export interface SkillStudentInstructions {
    tool_name: string;
    summary: string;
    usage_examples: SkillUsageExample[];
}

export interface SkillPackageArtifact {
    kind: 'script';
    filename: string;
    runtime: ForgeLanguage;
    language: SkillPackageLanguage;
    entrypoint: boolean;
}

export interface SkillPackageManifest {
    name: string;
    skillName: string;
    toolName: string;
    description: string;
    forging_reason?: string;
    source: 'forge' | 'forge-tdd';
    createdAt: string;
    language: SkillPackageLanguage;
    entrypoint: string;
    inputMode: 'json-arguments-object';
    sandboxDurationMs?: number;
    testPayloadKeys?: string[];
}

export interface SkillPackage {
    schemaVersion: 1;
    manifest: SkillPackageManifest;
    artifacts: SkillPackageArtifact[];
    student_instructions: SkillStudentInstructions;
}

export interface PersistSkillPackageParams {
    skillName: string;
    toolName: string;
    description: string;
    forgingReason: string;
    code: string;
    language: SkillPackageLanguage;
    source: 'forge' | 'forge-tdd';
    createdAt?: string;
    sandboxDurationMs?: number;
    testPayload?: Record<string, unknown>;
    studentInstructions: SkillStudentInstructions;
}

export interface PersistedSkillPackage {
    packageDir: string;
    packagePath: string;
    entrypointPath: string;
    skillPackage: SkillPackage;
}

export interface ForgedSkillSummary {
    skillName: string;
    name: string;
    toolName: string;
    description: string;
    forgingReason?: string;
    source: 'forge' | 'forge-tdd';
    createdAt: string;
    language: SkillPackageLanguage;
    entrypoint: string;
    skillPackagePath: string;
}

// ─── Constants ────────────────────────────────────────────────────

const SKILL_PACKAGE_FILENAME = 'skill-package.json';
const EXECUTION_TIMEOUT_MS = 30_000; // 30 seconds max per script
const REDBUSAGENT_VAULT_DIR_ENV = 'REDBUSAGENT_VAULT_DIR';
const REDBUSAGENT_FORGE_DIR_ENV = 'REDBUSAGENT_FORGE_DIR';
const REDBUSAGENT_SKILLS_DIR_ENV = 'REDBUSAGENT_SKILLS_DIR';
const REDBUSAGENT_DAEMON_ROOT_ENV = 'REDBUSAGENT_DAEMON_ROOT';
const DAEMON_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ─── Helpers ─────────────────────────────────────────────────────

function detectLanguage(filename: string): ForgeLanguage {
    if (filename.endsWith('.py')) return 'python';
    return 'node';
}

function getForgeDir(): string {
    return join(Vault.dir, 'forge');
}

function getForgePackageJson(): string {
    return join(getForgeDir(), 'package.json');
}

function getForgeVenvDir(): string {
    return join(getForgeDir(), '.venv');
}

function getSkillsDir(): string {
    return join(Vault.dir, 'skills');
}

export function buildForgeRuntimeEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return {
        ...baseEnv,
        [REDBUSAGENT_VAULT_DIR_ENV]: Vault.dir,
        [REDBUSAGENT_FORGE_DIR_ENV]: getForgeDir(),
        [REDBUSAGENT_SKILLS_DIR_ENV]: getSkillsDir(),
        [REDBUSAGENT_DAEMON_ROOT_ENV]: DAEMON_ROOT,
    };
}

function ensureDir(dir: string): void {
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
}

function artifactFilenameForLanguage(language: SkillPackageLanguage): string {
    if (language === 'python') return 'index.py';
    return 'index.cjs';
}

function runtimeForSkillLanguage(language: SkillPackageLanguage): ForgeLanguage {
    return language === 'python' ? 'python' : 'node';
}

export function normalizeNodeSkillSource(language: Extract<SkillPackageLanguage, 'javascript' | 'typescript'>, code: string): string {
    return transpileModule(code, {
        compilerOptions: {
            allowJs: true,
            esModuleInterop: true,
            module: ModuleKind.CommonJS,
            sourceMap: false,
            target: ScriptTarget.ES2022,
        },
        fileName: language === 'typescript' ? 'skill.ts' : 'skill.js',
        reportDiagnostics: false,
    }).outputText.trim();
}

function buildNodeExecuteResolver(): string {
    return `function __redbusResolveExecuteFn() {
    if (typeof execute === 'function') return execute;
    if (typeof run === 'function') return run;

    if (typeof module !== 'undefined' && module && typeof module.exports !== 'undefined') {
        if (typeof module.exports === 'function') return module.exports;
        if (typeof module.exports?.execute === 'function') return module.exports.execute;
        if (typeof module.exports?.run === 'function') return module.exports.run;
        if (typeof module.exports?.default === 'function') return module.exports.default;
    }

    if (typeof exports !== 'undefined' && exports) {
        if (typeof exports.execute === 'function') return exports.execute;
        if (typeof exports.run === 'function') return exports.run;
        if (typeof exports.default === 'function') return exports.default;
    }

    return undefined;
}`;
}

export function buildExecutableArtifact(language: SkillPackageLanguage, code: string): string {
    if (language === 'python') {
        return `import asyncio\nimport inspect\nimport json\nimport sys\n\n${code}\n\ndef __redbus_parse_payload():\n    raw = sys.argv[1] if len(sys.argv) > 1 else ''\n    if not raw:\n        return {}\n    try:\n        return json.loads(raw)\n    except Exception:\n        return {\"input\": raw}\n\nasync def __redbus_main():\n    payload = __redbus_parse_payload()\n    execute_fn = globals().get('execute') or globals().get('run')\n    if execute_fn is None:\n        return\n    if inspect.iscoroutinefunction(execute_fn):\n        result = await execute_fn(payload)\n    else:\n        result = execute_fn(payload)\n    if result is None:\n        return\n    if isinstance(result, str):\n        print(result)\n    else:\n        print(json.dumps(result, indent=2))\n\nif __name__ == '__main__':\n    asyncio.run(__redbus_main())\n`;
    }

    const normalizedCode = normalizeNodeSkillSource(language, code);

    return `function __redbusParsePayload() {\n    const raw = process.argv[2];\n    if (!raw) return {};\n    try {\n        return JSON.parse(raw);\n    } catch {\n        return { input: raw };\n    }\n}\n\n${normalizedCode}\n\n${buildNodeExecuteResolver()}\n\nasync function __redbusMain() {\n    const payload = __redbusParsePayload();\n    const executeFn = __redbusResolveExecuteFn();\n\n    if (!executeFn) {\n        throw new Error('Skill must define or export an execute(payload) or run(payload) function.');\n    }\n\n    const result = await executeFn(payload);\n    if (typeof result === 'undefined') return;\n    if (typeof result === 'string') {\n        console.log(result);\n        return;\n    }\n\n    console.log(JSON.stringify(result, null, 2));\n}\n\nvoid __redbusMain();\n`;
}

function normalizeSkillPackage(skillPackage: SkillPackage): SkillPackage | null {
    const manifestName = skillPackage.manifest.name || skillPackage.manifest.skillName || skillPackage.student_instructions.tool_name;
    if (!manifestName) return null;

    return {
        ...skillPackage,
        manifest: {
            ...skillPackage.manifest,
            name: manifestName,
            skillName: skillPackage.manifest.skillName || manifestName,
            description: skillPackage.manifest.description || skillPackage.student_instructions.summary,
        },
    };
}

/** Returns the path to the Python interpreter inside the venv */
function venvPython(): string {
    // Works on macOS/Linux; Windows would use Scripts/python.exe
    return join(getForgeVenvDir(), 'bin', 'python3');
}

/** Returns the path to the pip executable inside the venv */
function venvPip(): string {
    return join(getForgeVenvDir(), 'bin', 'pip');
}

function combineOutput(stdout: string, stderr: string): string {
    const sections: string[] = [];
    if (stdout.trim()) sections.push(`stdout:\n${stdout.trim()}`);
    if (stderr.trim()) sections.push(`stderr:\n${stderr.trim()}`);
    return sections.join('\n\n');
}

function truncateOutput(value: string, maxLength = 1200): string {
    if (value.length <= maxLength) return value;
    const remaining = value.length - maxLength;
    return `${value.slice(0, maxLength)}\n…[truncated ${remaining} chars]`;
}

function normalizeExecFailure(
    error: ExecFileException,
    stdout: string,
    stderr: string,
    durationMs: number,
): ForgeExecutionResult {
    const exitCode = typeof error.code === 'number' ? error.code : null;
    const errorMessage = error.message || 'Command failed';
    const normalizedStderr = stderr.trim() ? stderr : errorMessage;

    return {
        success: false,
        exitCode,
        stdout,
        stderr: normalizedStderr,
        durationMs,
        errorMessage,
        errorCode: error.code ?? undefined,
        signal: error.signal ?? null,
        timedOut: error.killed === true && errorMessage.toLowerCase().includes('timed out'),
        failedCommand: error.cmd,
        combinedOutput: combineOutput(stdout, normalizedStderr),
    };
}

export function formatForgeFailureDetails(filename: string, result: ForgeExecutionResult): string {
    const lines = [`Forge execution failed for ${filename}.`];

    if (result.exitCode != null) lines.push(`Exit code: ${result.exitCode}`);
    if (result.errorCode != null && result.errorCode !== result.exitCode) lines.push(`Error code: ${String(result.errorCode)}`);
    if (result.signal) lines.push(`Signal: ${result.signal}`);
    if (result.timedOut) lines.push(`Timed out after ${EXECUTION_TIMEOUT_MS}ms`);
    if (result.failedCommand) lines.push(`Command: ${result.failedCommand}`);
    if (result.errorMessage && result.errorMessage !== result.stderr) lines.push(`Runtime error: ${result.errorMessage}`);

    if (result.stderr.trim()) {
        lines.push('', `stderr:\n${truncateOutput(result.stderr.trim())}`);
    }

    if (result.stdout.trim()) {
        lines.push('', `stdout:\n${truncateOutput(result.stdout.trim())}`);
    }

    return lines.join('\n');
}

export function buildForgeCritiqueSignal(input: {
    phase: ForgeCritiqueSignal['phase'];
    filename?: string;
    verdict?: ForgeCritiqueSignal['verdict'];
    summary?: string;
    instruction?: string;
    evidence?: string;
}): ForgeCritiqueSignal {
    const filenamePrefix = input.filename ? `${input.filename}: ` : '';

    return {
        verdict: input.verdict ?? 'revise',
        phase: input.phase,
        summary: input.summary ?? `${filenamePrefix}${input.phase.replace(/_/g, ' ')} failed and needs repair before the workflow can complete.`,
        instruction: input.instruction ?? 'Revise the implementation, address the reported failure, and retry the same tool call.',
        ...(input.evidence?.trim() ? { evidence: truncateOutput(input.evidence.trim(), 600) } : {}),
    };
}

// ─── Forge Service ────────────────────────────────────────────────

export class Forge {
    /** Path to the forge workspace */
    static get dir(): string {
        return getForgeDir();
    }

    /** Path to the Python venv directory */
    static get venvDir(): string {
        return getForgeVenvDir();
    }

    static get skillsDir(): string {
        return getSkillsDir();
    }

    static get daemonRoot(): string {
        return DAEMON_ROOT;
    }

    static getSkillPackageDir(skillName: string): string {
        return join(this.skillsDir, skillName);
    }

    static getSkillPackagePath(skillName: string): string {
        return join(this.getSkillPackageDir(skillName), SKILL_PACKAGE_FILENAME);
    }

    /**
     * Ensures the forge workspace exists with a valid package.json.
     * Called once at daemon startup.
     */
    static ensureWorkspace(): void {
        ensureDir(this.dir);

        const forgePackageJson = getForgePackageJson();
        if (!existsSync(forgePackageJson)) {
            const packageJson = {
                name: 'redbusagent-forge',
                version: '1.0.0',
                private: true,
                description: 'Auto-generated workspace for redbusagent forged tools',
            };
            writeFileSync(forgePackageJson, JSON.stringify(packageJson, null, 2), {
                encoding: 'utf-8',
            });
        }
    }

    /**
     * Ensures the Python venv exists inside the forge workspace.
     * Creates it on first use so we don't slow down startup if Python isn't needed.
     */
    static async ensurePythonVenv(): Promise<{ success: boolean; error?: string }> {
        if (existsSync(venvPython())) return { success: true };

        console.log('  🐍 Forge: Creating Python virtual environment...');
        return new Promise((resolve) => {
            execFile(
                'python3',
                ['-m', 'venv', this.venvDir],
                {
                    cwd: this.dir,
                    timeout: 60_000,
                    env: buildForgeRuntimeEnv(process.env),
                },
                (error, _stdout, stderr) => {
                    if (error) {
                        resolve({ success: false, error: stderr || error.message });
                    } else {
                        console.log('  🐍 Forge: Python venv created');
                        resolve({ success: true });
                    }
                },
            );
        });
    }

    /**
     * Detect language from filename extension.
     */
    static detectLanguage(filename: string): ForgeLanguage {
        return detectLanguage(filename);
    }

    /**
     * Install npm dependencies in the forge workspace.
     * Runs `npm install` silently.
     */
    static async installDependencies(deps: string[]): Promise<{ success: boolean; error?: string }> {
        if (deps.length === 0) return { success: true };

        return new Promise((resolve) => {
            execFile(
                'npm',
                ['install', '--save', ...deps],
                {
                    cwd: this.dir,
                    timeout: 60_000, // 60s for installs
                    env: buildForgeRuntimeEnv({ ...process.env, NODE_ENV: 'production' }),
                },
                (error, _stdout, stderr) => {
                    if (error) {
                        resolve({ success: false, error: stderr || error.message });
                    } else {
                        resolve({ success: true });
                    }
                },
            );
        });
    }

    /**
     * Install Python (pip) dependencies into the forge venv.
     * Ensures the venv exists before installing.
     */
    static async installPythonDependencies(deps: string[]): Promise<{ success: boolean; error?: string }> {
        if (deps.length === 0) return { success: true };

        const venvResult = await this.ensurePythonVenv();
        if (!venvResult.success) {
            return { success: false, error: `Failed to create venv: ${venvResult.error}` };
        }

        return new Promise((resolve) => {
            execFile(
                venvPip(),
                ['install', ...deps],
                {
                    cwd: this.dir,
                    timeout: 120_000, // 120s for pip installs
                    maxBuffer: 2 * 1024 * 1024,
                    env: buildForgeRuntimeEnv({
                        ...process.env,
                        VIRTUAL_ENV: this.venvDir,
                        PATH: `${join(this.venvDir, 'bin')}:${process.env['PATH'] || ''}`,
                    }),
                },
                (error, _stdout, stderr) => {
                    if (error) {
                        resolve({ success: false, error: stderr || error.message });
                    } else {
                        resolve({ success: true });
                    }
                },
            );
        });
    }

    /**
     * Write a script file to the forge workspace.
     */
    static writeScript(filename: string, code: string): string {
        const filepath = join(this.dir, filename);
        writeFileSync(filepath, code, { encoding: 'utf-8', mode: 0o644 });
        return filepath;
    }

    static persistSkillPackage(params: PersistSkillPackageParams): PersistedSkillPackage {
        const createdAt = params.createdAt ?? new Date().toISOString();
        const entrypoint = artifactFilenameForLanguage(params.language);
        const packageDir = this.getSkillPackageDir(params.skillName);
        const packagePath = this.getSkillPackagePath(params.skillName);
        const entrypointPath = join(packageDir, entrypoint);

        const skillPackage: SkillPackage = {
            schemaVersion: 1,
            manifest: {
                name: params.skillName,
                skillName: params.skillName,
                toolName: params.toolName,
                description: params.description,
                forging_reason: params.forgingReason,
                source: params.source,
                createdAt,
                language: params.language,
                entrypoint,
                inputMode: 'json-arguments-object',
                ...(params.sandboxDurationMs != null ? { sandboxDurationMs: params.sandboxDurationMs } : {}),
                ...(params.testPayload ? { testPayloadKeys: Object.keys(params.testPayload) } : {}),
            },
            artifacts: [
                {
                    kind: 'script',
                    filename: entrypoint,
                    runtime: runtimeForSkillLanguage(params.language),
                    language: params.language,
                    entrypoint: true,
                },
            ],
            student_instructions: params.studentInstructions,
        };

        ensureDir(this.skillsDir);
        ensureDir(packageDir);

        writeFileSync(entrypointPath, buildExecutableArtifact(params.language, params.code), {
            encoding: 'utf-8',
            mode: 0o644,
        });
        writeFileSync(packagePath, JSON.stringify(skillPackage, null, 2), {
            encoding: 'utf-8',
            mode: 0o600,
        });

        return {
            packageDir,
            packagePath,
            entrypointPath,
            skillPackage,
        };
    }

    static readSkillPackage(packagePath: string): SkillPackage | null {
        try {
            const raw = readFileSync(packagePath, 'utf-8');
            return normalizeSkillPackage(JSON.parse(raw) as SkillPackage);
        } catch {
            return null;
        }
    }

    static listSkillPackages(): ForgedSkillSummary[] {
        const skillsDir = this.skillsDir;
        if (!existsSync(skillsDir)) return [];

        const skills: ForgedSkillSummary[] = [];

        for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;

                const packagePath = join(skillsDir, entry.name, SKILL_PACKAGE_FILENAME);
                const skillPackage = this.readSkillPackage(packagePath);
                if (!skillPackage) continue;

                skills.push({
                    skillName: skillPackage.manifest.skillName,
                    name: skillPackage.manifest.name,
                    toolName: skillPackage.manifest.toolName,
                    description: skillPackage.manifest.description,
                    forgingReason: skillPackage.manifest.forging_reason,
                    source: skillPackage.manifest.source,
                    createdAt: skillPackage.manifest.createdAt,
                    language: skillPackage.manifest.language,
                    entrypoint: skillPackage.manifest.entrypoint,
                    skillPackagePath: packagePath,
                });
        }

        return skills.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    /**
     * Read a script file from the forge workspace.
     */
    static readScript(filename: string): string | null {
        const filepath = join(this.dir, filename);
        if (!existsSync(filepath)) return null;
        return readFileSync(filepath, 'utf-8');
    }

    /**
     * Execute a script in the forge workspace via child_process.
     * Detects language from file extension (.py → python3, .js → node).
     * Captures stdout, stderr, exit code, and execution duration.
     */
    static async executeScriptAtPath(filepath: string, input?: string): Promise<ForgeExecutionResult> {
        const lang = detectLanguage(filepath);
        const startTime = Date.now();

        // For Python scripts, ensure venv exists so imports resolve
        if (lang === 'python') {
            const venvResult = await this.ensurePythonVenv();
            if (!venvResult.success) {
                return {
                    success: false,
                    exitCode: 1,
                    stdout: '',
                    stderr: `Failed to ensure Python venv: ${venvResult.error}`,
                    durationMs: Date.now() - startTime,
                };
            }
        }

        const interpreter = lang === 'python' ? venvPython() : 'node';

        return new Promise((resolve) => {
            const args = [filepath];
            if (input) args.push(input);

            const envVars = buildForgeRuntimeEnv(process.env);
            if (lang === 'python') {
                envVars['VIRTUAL_ENV'] = this.venvDir;
                envVars['PATH'] = `${join(this.venvDir, 'bin')}:${process.env['PATH'] || ''}`;
            }

            const child = execFile(
                interpreter,
                args,
                {
                    cwd: dirname(filepath),
                    timeout: EXECUTION_TIMEOUT_MS,
                    maxBuffer: 1024 * 1024, // 1MB output buffer
                    env: envVars,
                },
                (error, stdout, stderr) => {
                    const durationMs = Date.now() - startTime;

                    if (error) {
                        resolve(normalizeExecFailure(error, stdout || '', stderr || '', durationMs));
                    } else {
                        resolve({
                            success: true,
                            exitCode: 0,
                            stdout: stdout || '',
                            stderr: stderr || '',
                            durationMs,
                            combinedOutput: combineOutput(stdout || '', stderr || ''),
                        });
                    }
                },
            );

            void child; // prevent unused warning
        });
    }

    static async executeScript(filename: string, input?: string): Promise<ForgeExecutionResult> {
        return this.executeScriptAtPath(join(this.dir, filename), input);
    }
}
