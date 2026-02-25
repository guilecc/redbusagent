/**
 * @redbusagent/daemon — WhatsApp Channel
 *
 * Provides bridging to WhatsApp via whatsapp-web.js.
 *
 * 🛡️ OWNER FIREWALL (Security Critical):
 * This module implements a strict owner-only firewall. The agent can ONLY
 * read from and write to the owner's phone number, which is stored in the
 * Vault as `owner_phone_number`. No parameter, no LLM hallucination, and
 * no code path can override the destination. All messages from groups or
 * other contacts are silently dropped at the OS level before reaching
 * the Cognitive Router.
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
    private static instance: WhatsAppChannel;
    private client: pkg.Client | null = null;
    private isThinking: boolean = false;

    constructor() {
        WhatsAppChannel.instance = this;
    }

    public static getInstance(): WhatsAppChannel {
        if (!WhatsAppChannel.instance) {
            WhatsAppChannel.instance = new WhatsAppChannel();
        }
        return WhatsAppChannel.instance;
    }

    /**
     * 🛡️ FIREWALL: The ONLY allowed WhatsApp JID, loaded from Vault at startup.
     * Format: "5511999999999@c.us". Immutable after initialization.
     */
    private ownerJid: string | null = null;

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
     * 🛡️ FIREWALL: Refuses to start if owner_phone_number is not configured.
     */
    async startSilent(): Promise<void> {
        if (!WhatsAppChannel.hasSession()) {
            return; // Not configured
        }

        // 🛡️ FIREWALL: Load owner JID from Vault — refuse to start without it
        this.ownerJid = Vault.getOwnerWhatsAppJid();
        if (!this.ownerJid) {
            // Silently return if owner is not configured, instead of throwing a scary error for users who bypassed WhatsApp
            return;
        }

        console.log('  📱 WhatsAppChannel: Inicializando silenciosamente...');
        console.log(`  🛡️ WhatsAppChannel: Firewall ATIVO — apenas ${this.ownerJid} será processado.`);

        this.client = new Client({
            authStrategy: new LocalAuth({ dataPath: WhatsAppChannel.authPath }),
            puppeteer: {
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            }
        });

        this.client.on('ready', async () => {
            console.log('  ✅ WhatsAppChannel: Prontidão alcançada!');
            console.log(`  🛡️ WhatsAppChannel: Firewall ATIVO — ouvindo APENAS: ${this.ownerJid}`);
        });

        // 🛡️ INBOUND FIREWALL on 'message' (incoming messages only)
        // First line: if not from owner → silent drop. No log, no processing.
        this.client.on('message', async (msg: pkg.Message) => {
            if (msg.from !== this.ownerJid) return; // 🛡️ FIREWALL: silent drop
            // Messages from owner are also caught by message_create below.
            // This listener exists purely as an extra guard layer.
        });

        // 🛡️ INBOUND FIREWALL on 'message_create' (all messages: sent + received)
        this.client.on('message_create', async (message: pkg.Message) => {
            // 🛡️ FIREWALL: Only accept "Note to Self" — from owner TO owner
            if (message.from !== this.ownerJid || message.to !== this.ownerJid) {
                return; // 🛡️ FIREWALL: silently blocked
            }

            // Skip bot replies (our own messages start with 🔴)
            if (message.body.startsWith('🔴')) {
                return;
            }

            const body = message.body.trim();
            if (!body) return;

            console.log(`  🧠 WhatsAppChannel: Recebeu [${body.slice(0, 30)}...] -> Roteando p/ Tier 2...`);

            if (this.isThinking) {
                await this.sendToOwner('🔴 *redbusagent:* Já estou processando uma requisição. Aguarde um momento...');
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
                    await this.sendToOwner(`🔴 *redbusagent:*\n\n${fullResponse}`);
                }
            } catch (err: any) {
                console.error('  ❌ WhatsAppChannel: Error:', err);
                await this.sendToOwner(`🔴 *redbusagent:* Ocorreu um erro ao processar sua requisição: ${err.message}`);
            } finally {
                this.isThinking = false;
            }
        });

        // Suppress auth and other warnings locally in daemon loop
        this.client.on('auth_failure', (msg: string) => {
            console.error('  ❌ WhatsAppChannel Auth Falhou no Background:', msg);
        });

        this.client.initialize().catch((err: any) => {
            if (err.message && err.message.includes('already running')) {
                console.error('  ⚠️  WhatsAppChannel: O navegador do WhatsApp já está rodando em outro processo (ou travou). Ignorando inicialização silenciosa.');
            } else {
                console.error('  ❌ Erro silencioso no WhatsApp:', err);
            }
        });
    }

    // ─── 🛡️ OUTBOUND FIREWALL ────────────────────────────────────────

    /**
     * 🛡️ OUTBOUND FIREWALL: Send a message ONLY to the owner.
     * This method has NO destination parameter — the recipient is ALWAYS
     * hardcoded from the Vault-loaded ownerJid. No code path can override this.
     */
    private async sendToOwner(text: string): Promise<void> {
        if (!this.client || !this.ownerJid) {
            console.error('  🛡️❌ WhatsAppChannel.sendToOwner: client ou ownerJid não disponível.');
            return;
        }
        await this.client.sendMessage(this.ownerJid, text);
    }

    /**
     * 🛡️ Public API for external modules (HeartbeatManager, ProactiveEngine, etc.)
     * to send notifications to the owner. Destination is ALWAYS the owner — no parameter.
     */
    public async sendNotificationToOwner(text: string): Promise<void> {
        await this.sendToOwner(text);
    }

    // ─── Lifecycle ────────────────────────────────────────────────────

    async stop(): Promise<void> {
        if (this.client) {
            await this.client.destroy();
            this.client = null;
        }
    }
}
