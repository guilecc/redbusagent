import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { askLive, askTier2 } from '../cognitive-router.js';
import { WhatsAppChannel } from '../../channels/whatsapp.js';
import type { DaemonWsServer } from '../../infra/ws-server.js';
import { classifyTaskIntent } from '../heuristic-router.js';

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
        if (req.method === 'POST' && req.url === '/api/infer') {
            await this.handleInfer(req, res);
        } else if (req.method === 'POST' && req.url === '/api/notify') {
            await this.handleNotify(req, res);
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
        }
    }

    private async handleInfer(req: IncomingMessage, res: ServerResponse) {
        try {
            const body = await this.readBody(req);
            const data = JSON.parse(body);
            const prompt = data.prompt;
            let engine = data.engine;

            if (!prompt) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Missing prompt' }));
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

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ response: fullOutput }));

        } catch (error: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message || String(error) }));
        }
    }

    private async handleNotify(req: IncomingMessage, res: ServerResponse) {
        try {
            const body = await this.readBody(req);
            const data = JSON.parse(body);
            const message = data.message;
            const channel = data.channel || 'tui';

            if (!message) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Missing message' }));
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

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (error: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message || String(error) }));
        }
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
