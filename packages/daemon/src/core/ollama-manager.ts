/**
 * @redbusagent/daemon — Ollama Manager
 *
 * One-Line Install philosophy: Auto-downloads and manages the local Ollama
 * engine silently in the background, isolating it in ~/.redbusagent/bin/.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { Vault } from '@redbusagent/shared';

export class OllamaManager {
    private static process: ChildProcess | null = null;
    private static port = 11434;

    static get binDir(): string {
        return join(Vault.dir, 'bin');
    }

    static get binaryPath(): string {
        const ext = process.platform === 'win32' ? '.exe' : '';
        return join(this.binDir, `ollama${ext}`);
    }

    public static setCallbacks(onProgress: (status: string) => void) {
        this.onProgress = onProgress;
    }

    private static onProgress: (status: string) => void = () => { };

    /**
     * Installs Ollama if missing, starts the daemon, and pulls required models.
     */
    static async startup(): Promise<void> {
        if (!existsSync(this.binDir)) {
            mkdirSync(this.binDir, { recursive: true, mode: 0o700 });
        }

        await this.ensureBinary();
        await this.startDaemon();
        await this.ensureModels();
    }

    /**
     * Kills the managed Ollama subprocess (called on shutdown).
     */
    static shutdown(): void {
        if (this.process) {
            console.log('  🛑 OllamaManager: Killing local Ollama process...');
            this.process.kill('SIGTERM');
            this.process = null;
        }
    }

    private static async ensureBinary(): Promise<void> {
        if (existsSync(this.binaryPath)) {
            return;
        }

        console.log('  📦 OllamaManager: Downloading local engine...');
        this.onProgress('Baixando motor local de IA...');

        if (process.platform === 'darwin') {
            await this.downloadWithCurl('https://ollama.com/download/Ollama-darwin.zip', '/tmp/ollama.zip');
            this.onProgress('Extraindo binário (Mac)...');
            await this.runCommand('unzip', ['-o', '-j', '/tmp/ollama.zip', 'Ollama.app/Contents/Resources/ollama', '-d', this.binDir]);
            await this.runCommand('rm', ['/tmp/ollama.zip']);
        } else if (process.platform === 'linux') {
            const url = process.arch === 'arm64'
                ? 'https://ollama.com/download/ollama-linux-arm64'
                : 'https://ollama.com/download/ollama-linux-amd64';
            await this.downloadWithCurl(url, this.binaryPath);
        } else if (process.platform === 'win32') {
            await this.downloadWithCurl('https://ollama.com/download/ollama-windows-amd64.exe', this.binaryPath);
        } else {
            throw new Error(`Plataforma não suportada: ${process.platform}`);
        }

        if (process.platform !== 'win32') {
            chmodSync(this.binaryPath, 0o700);
        }

        console.log('  📦 OllamaManager: Download complete.');
        this.onProgress('Motor local atualizado e pronto.');
    }

    private static downloadWithCurl(url: string, dest: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const cmd = process.platform === 'win32' ? 'curl.exe' : 'curl';
            const child = spawn(cmd, ['-L', '-#', '-o', dest, url]);

            child.stderr.on('data', (data: Buffer) => {
                const text = data.toString();
                // curl -# outputs like: ###################                       30.1%
                const match = text.match(/([0-9.]+)%/);
                if (match) {
                    this.onProgress(`Baixando motor de IA... ${match[1]}%`);
                }
            });

            child.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`Download curl failed with code ${code}`));
            });
            child.on('error', reject);
        });
    }

    private static runCommand(cmd: string, args: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const child = spawn(cmd, args);
            child.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`Command ${cmd} failed with code ${code}`));
            });
            child.on('error', reject);
        });
    }

    private static async startDaemon(): Promise<void> {
        console.log('  ⚙️  OllamaManager: Starting server...');
        this.onProgress('Iniciando servidor local...');

        this.process = spawn(this.binaryPath, ['serve'], {
            env: {
                ...process.env,
                OLLAMA_HOST: `127.0.0.1:${this.port}`,
            },
            stdio: ['ignore', 'ignore', 'ignore'], // Silence output
            detached: false, // Die when we die, but we explicitly kill it too
        });

        this.process.on('error', (err) => {
            console.error('  ❌ OllamaManager: Process error:', err);
        });

        // Wait for it to become healthy
        this.onProgress('Aguardando servidor local responder...');
        const isHealthy = await this.waitForHealth(30000); // 30s timeout
        if (!isHealthy) {
            throw new Error('Ollama server did not become healthy in time.');
        }

        console.log('  ✅ OllamaManager: Server is running');
    }

    private static async waitForHealth(timeoutMs: number): Promise<boolean> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const res = await fetch(`http://127.0.0.1:${this.port}/api/tags`);
                if (res.ok) return true;
            } catch {
                // Ignore connection errors while starting
            }
            await new Promise(r => setTimeout(r, 500));
        }
        return false;
    }

    private static async ensureModels(): Promise<void> {
        const REQUIRED_MODELS = ['llama3.2:1b', 'nomic-embed-text'];

        try {
            const res = await fetch(`http://127.0.0.1:${this.port}/api/tags`);
            if (!res.ok) return;

            const data = await res.json() as { models: Array<{ name: string }> };
            const existingModels = data.models.map(m => m.name);

            for (const model of REQUIRED_MODELS) {
                // If model exists (or a variant of it), skip.
                // Ollama tags append :latest if none specified, so simplistic matching:
                if (!existingModels.some(m => m === model || m === `${model}:latest` || m.startsWith(`${model}:`))) {
                    await this.pullModel(model);
                }
            }
        } catch (err) {
            console.error('  ❌ OllamaManager: Error checking models:', err);
        }
    }

    private static async pullModel(model: string): Promise<void> {
        console.log(`  📦 OllamaManager: Pulling model ${model}...`);
        this.onProgress(`Baixando modelo ${model}...`);

        const res = await fetch(`http://127.0.0.1:${this.port}/api/pull`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: model, stream: true }),
        });

        if (!res.ok || !res.body) {
            throw new Error(`Failed to pull ${model}: ${res.statusText}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastLogged = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // keep incomplete line

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.total && parsed.completed) {
                        const percent = Math.round((parsed.completed / parsed.total) * 100);
                        if (percent >= lastLogged + 5) {
                            this.onProgress(`Baixando ${model}... ${percent}%`);
                            lastLogged = percent;
                        }
                    } else if (parsed.status) {
                        this.onProgress(`Modelo ${model}: ${parsed.status}`);
                    }
                } catch {
                    // ignore JSON parse errors on partial chunks if any
                }
            }
        }

        console.log(`  ✅ OllamaManager: Model ${model} pulled successfully.`);
        this.onProgress(`Modelo ${model} pronto.`);
    }

    static get baseUrl(): string {
        return `http://127.0.0.1:${this.port}`;
    }
}
