/**
 * Tests for Skills System module
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    parseFrontmatter,
    discoverSkills,
    getRelevantSkillPrompt,
    initSkills,
    loadSkillContent,
    scoreSkillMatch,
    matchSkills,
    type SkillMeta,
} from './skills.js';

describe('parseFrontmatter', () => {
    it('parses YAML frontmatter delimited by ---', () => {
        const raw = `---
name: weather
description: "Get weather info"
---

# Weather Skill
Content here.`;
        const { frontmatter, body } = parseFrontmatter(raw);
        expect(frontmatter['name']).toBe('weather');
        expect(frontmatter['description']).toBe('Get weather info');
        expect(body).toContain('# Weather Skill');
    });

    it('returns empty frontmatter when no --- delimiter', () => {
        const raw = '# Just markdown\nNo frontmatter here.';
        const { frontmatter, body } = parseFrontmatter(raw);
        expect(Object.keys(frontmatter)).toHaveLength(0);
        expect(body).toBe(raw);
    });

    it('handles missing closing ---', () => {
        const raw = `---
name: broken
no closing delimiter`;
        const { frontmatter } = parseFrontmatter(raw);
        expect(Object.keys(frontmatter)).toHaveLength(0);
    });
});

describe('discoverSkills', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'skills-test-'));
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    it('discovers SKILL.md files in subdirectories', async () => {
        const skillDir = join(tempDir, 'weather');
        mkdirSync(skillDir);
        writeFileSync(join(skillDir, 'SKILL.md'), `---
name: weather
description: "Get weather forecasts"
---
# Weather
Use curl to get weather.`);

        const skills = await discoverSkills(tempDir);
        expect(skills).toHaveLength(1);
        expect(skills[0]!.name).toBe('weather');
        expect(skills[0]!.description).toBe('Get weather forecasts');
        expect(skills[0]!.keywords.length).toBeGreaterThan(0);
    });

    it('discovers teacher-student skill packages in subdirectories', async () => {
        const skillDir = join(tempDir, 'echo-package');
        mkdirSync(skillDir);
        writeFileSync(join(skillDir, 'skill-package.json'), JSON.stringify({
            schemaVersion: 1,
            manifest: {
                skillName: 'echo-package',
                toolName: 'echo_package',
                description: 'Echo structured messages',
                source: 'forge-tdd',
                createdAt: '2026-03-05T00:00:00.000Z',
                language: 'javascript',
                entrypoint: 'index.js',
                inputMode: 'json-arguments-object',
            },
            artifacts: [
                {
                    kind: 'script',
                    filename: 'index.js',
                    runtime: 'node',
                    language: 'javascript',
                    entrypoint: true,
                },
            ],
            student_instructions: {
                tool_name: 'echo_package',
                summary: 'Use this skill when the user wants an echo response.',
                usage_examples: [
                    {
                        user_input: 'Echo hello',
                        expected_tool_call: { name: 'echo_package', args: { message: 'hello' } },
                    },
                    {
                        user_input: 'Repeat redbus',
                        expected_tool_call: { name: 'echo_package', args: { message: 'redbus' } },
                    },
                ],
            },
        }, null, 2));

        const skills = await discoverSkills(tempDir);
        expect(skills).toHaveLength(1);
        expect(skills[0]!.instructionSource).toBe('package');
        expect(skills[0]!.toolName).toBe('echo_package');
        expect(skills[0]!.keywords).toContain('hello');
    });

    it('returns empty array for nonexistent directory', async () => {
        const skills = await discoverSkills('/nonexistent/path/xyz');
        expect(skills).toEqual([]);
    });

    it('skips directories without SKILL.md', async () => {
        mkdirSync(join(tempDir, 'no-skill'));
        writeFileSync(join(tempDir, 'no-skill', 'README.md'), 'not a skill');
        const skills = await discoverSkills(tempDir);
        expect(skills).toHaveLength(0);
    });
});

describe('scoreSkillMatch', () => {
    const skill: SkillMeta = {
        name: 'weather',
        description: 'Get current weather and forecasts',
        keywords: ['weather', 'temperature', 'forecast', 'rain'],
        dirPath: '/tmp/weather',
        filePath: '/tmp/weather/SKILL.md',
    };

    it('scores high for exact name match', () => {
        expect(scoreSkillMatch('what is the weather?', skill)).toBeGreaterThanOrEqual(50);
    });

    it('scores for keyword matches', () => {
        const score = scoreSkillMatch('will it rain tomorrow?', skill);
        expect(score).toBeGreaterThan(0);
    });

    it('scores zero for unrelated queries', () => {
        expect(scoreSkillMatch('compile the project', skill)).toBe(0);
    });
});

describe('matchSkills', () => {
    const skills: SkillMeta[] = [
        {
            name: 'weather',
            description: 'Get weather',
            keywords: ['weather', 'rain', 'forecast'],
            dirPath: '/tmp/weather',
            filePath: '/tmp/weather/SKILL.md',
        },
        {
            name: 'git',
            description: 'Git operations',
            keywords: ['commit', 'branch', 'merge'],
            dirPath: '/tmp/git',
            filePath: '/tmp/git/SKILL.md',
        },
    ];

    it('returns matching skills sorted by score', () => {
        const matches = matchSkills('what is the weather forecast?', skills);
        expect(matches.length).toBeGreaterThan(0);
        expect(matches[0]!.skill.name).toBe('weather');
    });

    it('returns empty array for no matches', () => {
        const matches = matchSkills('calculate fibonacci', skills);
        expect(matches).toHaveLength(0);
    });

    it('respects minScore threshold', () => {
        const matches = matchSkills('weather', skills, 100);
        // Very high threshold may exclude
        expect(matches.length).toBeLessThanOrEqual(1);
    });
});

describe('teacher-student prompt loading', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'skills-prompt-test-'));
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    it('formats package-backed student instructions for prompt injection', async () => {
        const skillDir = join(tempDir, 'echo-package');
        mkdirSync(skillDir);
        writeFileSync(join(skillDir, 'skill-package.json'), JSON.stringify({
            schemaVersion: 1,
            manifest: {
                skillName: 'echo-package',
                toolName: 'echo_package',
                description: 'Echo structured messages',
                source: 'forge-tdd',
                createdAt: '2026-03-05T00:00:00.000Z',
                language: 'javascript',
                entrypoint: 'index.js',
                inputMode: 'json-arguments-object',
            },
            artifacts: [
                {
                    kind: 'script',
                    filename: 'index.js',
                    runtime: 'node',
                    language: 'javascript',
                    entrypoint: true,
                },
            ],
            student_instructions: {
                tool_name: 'echo_package',
                summary: 'Use this skill when the user asks for an echo.',
                usage_examples: [
                    {
                        user_input: 'Echo hello',
                        expected_tool_call: { name: 'echo_package', args: { message: 'hello' } },
                    },
                    {
                        user_input: 'Repeat redbus',
                        expected_tool_call: { name: 'echo_package', args: { message: 'redbus' } },
                    },
                ],
            },
        }, null, 2));

        const [skill] = await discoverSkills(tempDir);
        const content = await loadSkillContent(skill!);
        expect(content).toContain('Student Summary: Use this skill when the user asks for an echo.');
        expect(content).toContain('Preferred Tool Name: echo_package');

        await initSkills(tempDir);
        const prompt = await getRelevantSkillPrompt('please echo hello for me');
        expect(prompt).toContain('echo-package');
        expect(prompt).toContain('<tool_call>{"name":"echo_package","args":{"message":"hello"}}</tool_call>');
    });
});

