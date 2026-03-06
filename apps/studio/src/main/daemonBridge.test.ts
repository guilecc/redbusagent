import assert from 'node:assert/strict';
import test from 'node:test';
import {
    applyForgeLifecycleSnapshot,
    buildSkillsApiUrl,
    buildCompatibilityYieldRequest,
    classifyYieldKind,
    extractActiveFile,
} from './daemonBridge';

test('compatibility question chunks become Studio question yields', () => {
    const request = buildCompatibilityYieldRequest(
        'ask-1',
        '❓ **Agent needs your input:**\nWhat API token should I use?',
    );

    assert.deepEqual(request, {
        yieldId: 'ask-1',
        kind: 'credential',
        title: 'Agent input required',
        body: 'What API token should I use?',
    });
});

test('compatibility approval chunks become Studio approval yields', () => {
    const request = buildCompatibilityYieldRequest(
        'approval-1',
        '⚠️ SECURITY ALERT: The agent wants to execute a system command.\n\nApprove? (Y/N)',
    );

    assert.equal(request?.kind, 'approval');
    assert.equal(request?.yieldId, 'approval-1');
    assert.match(request?.body ?? '', /SECURITY ALERT/u);
});

test('yield kind classifier distinguishes secrets from generic questions', () => {
    assert.equal(classifyYieldKind('Please provide the OpenAI API key.'), 'credential');
    assert.equal(classifyYieldKind('Which branch should I deploy?'), 'question');
});

test('extractActiveFile inspects common tool argument keys', () => {
    assert.equal(extractActiveFile({ filePath: 'src/main.ts' }), 'src/main.ts');
    assert.equal(extractActiveFile({ path: 'src/other.ts' }), 'src/other.ts');
    assert.equal(extractActiveFile({ nope: true }), undefined);
});

test('forge lifecycle snapshot accumulates stream content and success metadata', () => {
    const started = applyForgeLifecycleSnapshot(
        { status: 'idle' },
        {
            requestId: 'req-1',
            event: 'FORGE_START',
            skillName: 'csv-helper',
            toolName: 'forge_and_test_skill',
            description: 'Parse CSV rows',
            forgingReason: 'User asked for a CSV helper.',
            language: 'typescript',
        },
    );

    const streamed = applyForgeLifecycleSnapshot(started, {
        requestId: 'req-1',
        event: 'FORGE_STREAM',
        delta: 'export async function execute() {}\n',
    });
    const completed = applyForgeLifecycleSnapshot(streamed, {
        requestId: 'req-1',
        event: 'FORGE_SUCCESS',
        result: 'Skill deployed successfully',
    });

    assert.equal(started.status, 'executing');
    assert.equal(started.forgingReason, 'User asked for a CSV helper.');
    assert.equal(started.activeFile, 'csv-helper.ts');
    assert.equal(streamed.status, 'streaming');
    assert.match(streamed.content ?? '', /export async function execute/u);
    assert.equal(completed.status, 'success');
    assert.equal(completed.result, 'Skill deployed successfully');
});

test('buildSkillsApiUrl targets the local forwarded daemon API route', () => {
    assert.equal(buildSkillsApiUrl(8765), 'http://127.0.0.1:8765/api/skills');
});