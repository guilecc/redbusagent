import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { Forge } from '../forge.js';

const mocks = vi.hoisted(() => ({
    askLive: vi.fn(),
    askTier2: vi.fn(),
    classifyTaskIntent: vi.fn(),
    sendNotificationToOwner: vi.fn(),
}));

vi.mock('../cognitive-router.js', () => ({
    askLive: mocks.askLive,
    askTier2: mocks.askTier2,
}));

vi.mock('../heuristic-router.js', () => ({
    classifyTaskIntent: mocks.classifyTaskIntent,
}));

vi.mock('../../channels/whatsapp.js', () => ({
    WhatsAppChannel: {
        getInstance: () => ({ sendNotificationToOwner: mocks.sendNotificationToOwner }),
    },
}));

const { LocalApiServer } = await import('./server.js');

const createdDirs = new Set<string>();

afterEach(() => {
    for (const dir of createdDirs) {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    createdDirs.clear();
    vi.clearAllMocks();
});

function getPort(server: any): number {
    const address = server.server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Expected LocalApiServer to expose a numeric port');
    }
    return address.port;
}

describe('LocalApiServer', () => {
    it('serves forged skill metadata from GET /api/skills', async () => {
        const skillName = `api-skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        createdDirs.add(Forge.getSkillPackageDir(skillName));
        Forge.persistSkillPackage({
            skillName,
            toolName: 'api_skill_echo',
            description: 'Echo payloads for the skill library API',
            forgingReason: 'Expose a concrete forged skill entry for the Studio library.',
            code: `async function execute(payload) { return payload; }`,
            language: 'javascript',
            source: 'forge-tdd',
            studentInstructions: {
                tool_name: 'api_skill_echo',
                summary: 'Use api_skill_echo to echo structured payloads.',
                usage_examples: [
                    {
                        user_input: 'Echo this object back to me',
                        expected_tool_call: { name: 'api_skill_echo', args: { value: 'hello' } },
                    },
                    {
                        user_input: 'Repeat the API payload',
                        expected_tool_call: { name: 'api_skill_echo', args: { value: 'world' } },
                    },
                ],
            },
        });

        const server = new LocalApiServer({ broadcast: vi.fn() } as any, 0);
        server.start();
        await new Promise((resolve) => setTimeout(resolve, 0));

        try {
            const response = await fetch(`http://127.0.0.1:${getPort(server)}/api/skills`);
            const body = await response.json();

            expect(response.status).toBe(200);
            expect(body.count).toBe(body.skills.length);
            expect(body.skills).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    skillName,
                    name: skillName,
                    toolName: 'api_skill_echo',
                    description: 'Echo payloads for the skill library API',
                    forgingReason: 'Expose a concrete forged skill entry for the Studio library.',
                    language: 'javascript',
                    entrypoint: 'index.cjs',
                }),
            ]));
        } finally {
            server.stop();
        }
    });
});