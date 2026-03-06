import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { askLive, askTier2 } from '../cognitive-router.js';
import { WhatsAppChannel } from '../../channels/whatsapp.js';
import type { DaemonWsServer } from '../../infra/ws-server.js';
import { classifyTaskIntent } from '../heuristic-router.js';
import { Forge } from '../forge.js';

export class LocalApiServer {
    private server: Server;

    constructor(private readonly wsServer: DaemonWsServer, private readonly port: number = 8765) {
        this.server = createServer(this.handleRequest.bind(this));
    }

    start() {
        this.server.listen(this.port, '127.0.0.1', () => {
            console.log(`  🔌 Local API Server listening on http://127.0.0.1:${this.port}`);
        });
    }

    stop() {
        this.server.close();
    }

    private async handleRequest(req: IncomingMessage, res: ServerResponse) {
        if (req.method === 'GET' && req.url === '/api/skills') {
            this.handleSkills(res);
        } else if (req.method === 'POST' && req.url === '/api/infer') {
            await this.handleInfer(req, res);
        } else if (req.method === 'POST' && req.url === '/api/notify') {
            await this.handleNotify(req, res);
        } else {
            this.writeJson(res, 404, { error: 'Not found' });
        }
    }

    private handleSkills(res: ServerResponse) {
        const skills = Forge.listSkillPackages();
        const payload = {
            count: skills.length,
            skills,
        };

        this.writeJson(res, 200, payload);
    }

    private async handleInfer(req: IncomingMessage, res: ServerResponse) {
        try {
            const body = await this.readBody(req);
            const data = JSON.parse(body);
            const prompt = data.prompt;
            let engine = data.engine;

            if (!prompt) {
                return this.writeJson(res, 400, { error: 'Missing prompt' });
            }

            // If no engine specified, classify intent
            if (!engine) {
                const intent = await classifyTaskIntent(prompt);
                engine = intent === 'INTENT_FORGE' ? 'worker' : 'live';
            }

            let fullOutput = '';
            const callbacks = {
                onChunk: () => { }, // Silenced for API
                onDone: (text: string) => { fullOutput = text; },
                onError: (err: Error) => { throw err; }
            };

            if (engine === 'worker') {
                await askTier2(prompt, callbacks, undefined, [], 'owner');
            } else {
                await askLive(prompt, callbacks, [], 'owner');
            }

            this.writeJson(res, 200, { response: fullOutput });

        } catch (error: any) {
            this.writeJson(res, 500, { error: error.message || String(error) });
        }
    }

    private async handleNotify(req: IncomingMessage, res: ServerResponse) {
        try {
            const body = await this.readBody(req);
            const data = JSON.parse(body);
            const message = data.message;
            const channel = data.channel || 'tui';

            if (!message) {
                return this.writeJson(res, 400, { error: 'Missing message' });
            }

            if (channel === 'whatsapp') {
                const wa = WhatsAppChannel.getInstance();
                await wa.sendNotificationToOwner(message);
            } else {
                // TUI fallback
                this.wsServer.broadcast({
                    type: 'log',
                    timestamp: new Date().toISOString(),
                    payload: { level: 'info', source: 'Routine Output', message }
                });
            }

            this.writeJson(res, 200, { success: true });
        } catch (error: any) {
            this.writeJson(res, 500, { error: error.message || String(error) });
        }
    }

    private writeJson(res: ServerResponse, statusCode: number, payload: unknown) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
    }

    private readBody(req: IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let data = '';
            req.on('data', chunk => { data += chunk; });
            req.on('end', () => resolve(data));
            req.on('error', err => reject(err));
        });
    }
}
