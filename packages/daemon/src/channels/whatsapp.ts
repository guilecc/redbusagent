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
import type { DaemonWsServer } from '../infra/ws-server.js';

export class WhatsAppChannel {
    private static instance: WhatsAppChannel;
    private client: pkg.Client | null = null;
    private isThinking: boolean = false;
    private wsServer: DaemonWsServer | null = null;

    constructor() {
        WhatsAppChannel.instance = this;
    }

    /**
     * Inject the WebSocket server for omnichannel broadcasting.
     * Called from daemon main.ts after wsServer is created.
     */
    public setWsServer(server: DaemonWsServer): void {
        this.wsServer = server;
    }

    /** Broadcast a log message to all connected TUI clients */
    private broadcastToTui(message: string, level: 'info' | 'warn' = 'info'): void {
        if (!this.wsServer) return;
        this.wsServer.broadcast({
            type: 'log',
            timestamp: new Date().toISOString(),
            payload: { level, source: 'whatsapp', message },
        });
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
                console.log('\n  🟩 Scan the QR Code below in your WhatsApp (Linked Devices):\n');
                qrcode.generate(qr, { small: true });
            });

            client.on('authenticated', () => {
                console.log('\n  ✅ Successfully authenticated with WhatsApp!');
            });

            client.on('ready', async () => {
                console.log('  ✅ Session saved to redbusagent Vault.\n');
                await client.destroy();
                resolve();
            });

            client.on('auth_failure', (msg: string) => {
                console.error('  ❌ Authentication failed:', msg);
                reject(new Error(msg));
            });

            client.initialize().catch((err: any) => {
                console.error('  ❌ Error initializing WhatsApp:', err);
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

        console.log('  📱 WhatsAppChannel: Initializing silently...');
        console.log(`  🛡️ WhatsAppChannel: Firewall ACTIVE — only ${this.ownerJid} will be processed.`);

        this.client = new Client({
            authStrategy: new LocalAuth({ dataPath: WhatsAppChannel.authPath }),
            puppeteer: {
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            }
        });

        this.client.on('ready', async () => {
            console.log('  ✅ WhatsAppChannel: Ready!');
            console.log(`  🛡️ WhatsAppChannel: Firewall ACTIVE — listening ONLY to "Note to Self" from: ${this.ownerJid}`);
            console.log(`  🛡️ WhatsAppChannel: Messages from groups, other contacts, and strangers will be silently dropped.`);
        });

        // 🛡️ INBOUND FIREWALL on 'message_create' (all messages: sent + received)
        // This single listener handles BOTH incoming messages AND self-messages (fromMe).
        // The 'message' event is NOT needed — message_create covers everything.
        this.client.on('message_create', async (message: pkg.Message) => {
            // 🛡️ FIREWALL LAYER 0: ownerJid must be loaded — hard block if not.
            if (!this.ownerJid) {
                console.error('  🛡️❌ [Firewall] CRITICAL: ownerJid is null — dropping ALL messages.');
                return;
            }

            // 🛡️ FIREWALL LAYER 1: Reject group messages immediately (defense-in-depth).
            // Group JIDs always end with @g.us — never process them.
            if (message.from?.endsWith('@g.us') || message.to?.endsWith('@g.us')) {
                return; // 🛡️ FIREWALL: group message — silently blocked
            }

            // 🛡️ FIREWALL LAYER 2: "Note to Self" pattern — accept ONLY messages
            // where BOTH sender AND recipient are the owner's own JID.
            // This is critical because message_create fires for ALL messages,
            // including messages the owner sends to OTHER contacts (where
            // message.from === ownerJid but message.to !== ownerJid).
            const isFromOwner = message.from === this.ownerJid;
            const isToOwner = message.to === this.ownerJid;

            if (!isFromOwner || !isToOwner) {
                // Debug: log rejected messages so we can verify the firewall works
                if (isFromOwner && !isToOwner) {
                    console.log(`  🛡️ [Firewall] BLOCKED: owner sent message to ${message.to?.slice(0, 8)}... (not self-chat)`);
                }
                return; // 🛡️ FIREWALL: not a Note-to-Self message — silently blocked
            }

            // Skip bot replies (our own responses start with 🔴)
            if (message.body.startsWith('🔴')) {
                return;
            }

            const body = message.body.trim();
            if (!body) return;

            console.log(`  🛡️✅ [Firewall] ACCEPTED: Note-to-Self message from owner (${body.length} chars)`);
            console.log(`  📱 WhatsAppChannel: Received [${body.slice(0, 40)}...] -> Routing to Worker Engine...`);

            // ── Omnichannel: Mirror input to TUI ──────────────────
            this.broadcastToTui(`📱 [WhatsApp Input]: ${body}`);

            if (this.isThinking) {
                await this.sendToOwner('🔴 *redbusagent:* I am already processing a request. Please wait a moment...');
                return;
            }

            this.isThinking = true;

            try {
                let fullResponse = '';
                await askTier2(body, {
                    onChunk: (chunk) => {
                        // ── Omnichannel: Stream chunks to TUI (ghost typing) ──
                        this.broadcastToTui(chunk);
                    },
                    onDone: (text) => { fullResponse = text; },
                    onError: (err) => {
                        console.error('  ❌ WhatsAppChannel: Worker Engine error:', err);
                        this.broadcastToTui(`❌ [WhatsApp Error]: ${err.message}`, 'warn');
                    },
                    onToolCall: async (name) => {
                        console.log(`  🔧 WhatsAppChannel Forging: ${name}...`);
                        this.broadcastToTui(`🔧 [WhatsApp Tool]: ${name}`);
                    },
                    onToolResult: (name, success) => {
                        console.log(`  ✅ WhatsAppChannel Forge complete: ${name} [${success}]`);
                    }
                });

                if (fullResponse) {
                    // ── Send via WhatsApp AND mirror to TUI ──────────
                    await this.sendToOwner(`🔴 *redbusagent:*\n\n${fullResponse}`);
                    this.broadcastToTui(`🤖 [Agent via WhatsApp]: ${fullResponse}`);
                }
            } catch (err: any) {
                console.error('  ❌ WhatsAppChannel: Error:', err);
                await this.sendToOwner(`🔴 *redbusagent:* An error occurred while processing your request: ${err.message}`);
                this.broadcastToTui(`❌ [WhatsApp Error]: ${err.message}`, 'warn');
            } finally {
                this.isThinking = false;
            }
        });

        // Suppress auth and other warnings locally in daemon loop
        this.client.on('auth_failure', (msg: string) => {
            console.error('  ❌ WhatsAppChannel Auth Failed in Background:', msg);
        });

        this.client.initialize().catch((err: any) => {
            if (err.message && err.message.includes('already running')) {
                console.error('  ⚠️  WhatsAppChannel: The WhatsApp browser is already running in another process (or crashed). Skipping silent initialization.');
            } else {
                console.error('  ❌ Silent WhatsApp error:', err);
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
            console.error('  🛡️❌ WhatsAppChannel.sendToOwner: client or ownerJid not available.');
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
