import assert from 'node:assert/strict';
import test from 'node:test';
import {
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