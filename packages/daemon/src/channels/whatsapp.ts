/**
 * @redbusagent/daemon — WhatsApp Channel
 *
 * Provides bridging to WhatsApp via whatsapp-web.js.
 * Implements "Note to Self" authentication filter for high security.
 */

import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
// @ts-ignore
import qrcode from 'qrcode-terminal';
import { Vault } from '@redbusagent/shared';
import { askTier2 } from '../core/cognitive-router.js';

export class WhatsAppChannel {
    private client: pkg.Client | null = null;
    private myNumberId: string | null = null;
    private isThinking: boolean = false;

    static get authPath(): string {
        const dir = join(Vault.dir, 'auth_whatsapp');
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        return dir;
    }

    /**
     * Called by the CLI command `redbus channel login whatsapp`.
     * Interactively displays QR code and waits for authentication.
     */
    static async loginInteractively(): Promise<void> {
        return new Promise((resolve, reject) => {
            console.log('  📱 Inicializando cliente WhatsApp para login...');

            const client = new Client({
                authStrategy: new LocalAuth({ dataPath: this.authPath }),
                puppeteer: {
                    args: ['--no-sandbox', '--disable-setuid-sandbox'],
                }
            });

            client.on('qr', (qr: string) => {
                console.log('\n  🟩 Escaneie o QR Code abaixo no seu WhatsApp (Aparelhos Conectados):\n');
                qrcode.generate(qr, { small: true });
            });

            client.on('authenticated', () => {
                console.log('\n  ✅ Autenticado com sucesso no WhatsApp!');
            });

            client.on('ready', async () => {
                console.log('  ✅ Sessão salva no Vault do redbusagent.\n');
                await client.destroy();
                resolve();
            });

            client.on('auth_failure', (msg: string) => {
                console.error('  ❌ Falha de autenticação:', msg);
                reject(new Error(msg));
            });

            client.initialize().catch((err: any) => {
                console.error('  ❌ Erro ao inicializar o WhatsApp:', err);
                reject(err);
            });
        });
    }

    /**
     * Returns true if a WhatsApp authentication state exists.
     */
    static hasSession(): boolean {
        // LocalAuth defaults to creating a 'session' folder or a '.wwebjs_auth' folder depending on context.
        // We check for the 'session' folder which contains the Puppeteer profile data.
        const sessionDir = join(this.authPath, 'session');
        const legacyDir = join(this.authPath, '.wwebjs_auth');
        return existsSync(sessionDir) || existsSync(legacyDir);
    }

    /**
     * Initializes the client silently in the background connected to the Daemon.
     */
    async startSilent(): Promise<void> {
        if (!WhatsAppChannel.hasSession()) {
            return; // Not configured
        }

        console.log('  📱 WhatsAppChannel: Inicializando silenciosamente...');

        this.client = new Client({
            authStrategy: new LocalAuth({ dataPath: WhatsAppChannel.authPath }),
            puppeteer: {
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            }
        });

        this.client.on('ready', async () => {
            this.myNumberId = this.client?.info?.wid?._serialized || null;
            console.log(`  ✅ WhatsAppChannel: Prontidão alcançada! Ouvindo canal "Você" no número: ${this.client?.info?.wid?.user}`);
        });

        this.client.on('message_create', async (message: pkg.Message) => {
            if (!this.myNumberId) return;

            // Security Filter: Only process messages coming from the user's own number to themselves (Note to Self).
            // message_create captures messages YOU send.
            if (message.from !== this.myNumberId || message.to !== this.myNumberId) {
                return;
            }

            // Ignore messages sent by ourselves (the bot), assume the bot replies do not start with a special un-bot-like string,
            // Actually, if we reply, we send via client.sendMessage. It triggers message_create too.
            // We should filter out our own bot messages if we can, but since it's "note to self", 
            // the user writing on phone will also be from Me to Me.
            // We can prefix bot messages with 🤖 to easily ignore them.
            if (message.body.startsWith('🔴')) {
                return;
            }

            const body = message.body.trim();
            if (!body) return;

            console.log(`  🧠 WhatsAppChannel: Recebeu [${body.slice(0, 30)}...] -> Roteando p/ Tier 2...`);

            if (this.isThinking) {
                await this.client?.sendMessage(this.myNumberId, '🔴 *redbusagent:* Já estou processando uma requisição. Aguarde um momento...');
                return;
            }

            this.isThinking = true;

            try {
                let fullResponse = '';
                await askTier2(body, {
                    onChunk: (chunk) => { },
                    onDone: (text) => { fullResponse = text; },
                    onError: (err) => {
                        console.error('  ❌ WhatsAppChannel: Falha no Tier 2:', err);
                    },
                    onToolCall: async (name) => {
                        console.log(`  🔧 WhatsAppChannel Forjando: ${name}...`);
                    },
                    onToolResult: (name, success) => {
                        console.log(`  ✅ WhatsAppChannel Forja finalizada: ${name} [${success}]`);
                    }
                });

                if (fullResponse) {
                    await this.client?.sendMessage(this.myNumberId, `🔴 *redbusagent:*\n\n${fullResponse}`);
                }
            } catch (err: any) {
                console.error('  ❌ WhatsAppChannel: Error:', err);
                await this.client?.sendMessage(this.myNumberId, `🔴 *redbusagent:* Ocorreu um erro ao processar sua requisição: ${err.message}`);
            } finally {
                this.isThinking = false;
            }
        });

        // Suppress auth and other warnings locally in daemon loop
        this.client.on('auth_failure', (msg: string) => {
            console.error('  ❌ WhatsAppChannel Auth Falhou no Background:', msg);
        });

        this.client.initialize().catch((err: any) => {
            console.error('  ❌ Erro silencioso no WhatsApp:', err);
        });
    }

    async stop(): Promise<void> {
        if (this.client) {
            await this.client.destroy();
            this.client = null;
        }
    }
}
