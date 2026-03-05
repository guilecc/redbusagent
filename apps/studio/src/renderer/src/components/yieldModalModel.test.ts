import assert from 'node:assert/strict';
import test from 'node:test';
import type { StudioYieldRequest } from '@redbusagent/shared/studio';
import {
    buildYieldDialogModel,
    formatApprovalReason,
    formatYieldExpiry,
    requiresYieldFreeformInput,
} from './yieldModalModel';

test('question yields require a freeform response before submission', () => {
    const model = buildYieldDialogModel({
        yieldId: 'yield-question',
        kind: 'question',
        title: 'Need clarification',
        body: 'What should the tool do next?',
    } satisfies StudioYieldRequest);

    assert.equal(model.responseRequired, true);
    assert.equal(model.responseLabel, 'Your response');
    assert.deepEqual(model.actions.map((action) => action.decision), ['deny', 'submit']);
    assert.equal(requiresYieldFreeformInput(model, 'deny'), false);
    assert.equal(requiresYieldFreeformInput(model, 'submit'), true);
});

test('credential yields only require input for submit, not decline', () => {
    const model = buildYieldDialogModel({
        yieldId: 'yield-credential',
        kind: 'credential',
        title: 'Need a credential',
        body: 'Provide the API token',
    } satisfies StudioYieldRequest);

    assert.equal(model.responseRequired, true);
    assert.deepEqual(model.actions.map((action) => action.decision), ['deny', 'submit']);
    assert.equal(requiresYieldFreeformInput(model, 'deny'), false);
    assert.equal(requiresYieldFreeformInput(model, 'submit'), true);
});

test('approval yields expose allow-always when approval metadata exists', () => {
    const model = buildYieldDialogModel({
        yieldId: 'yield-approval',
        kind: 'approval',
        title: 'Approve tool run',
        body: 'Approve file deletion?',
        approval: {
            approvalId: 'approval-1',
            toolName: 'remove-files',
            description: 'Delete temporary cache files',
            reason: 'destructive',
            args: { path: '/tmp/cache' },
            expiresAtMs: 2_000,
        },
    } satisfies StudioYieldRequest);

    assert.equal(model.responseRequired, false);
    assert.deepEqual(model.actions.map((action) => action.decision), ['deny', 'allow-once', 'allow-always']);
    assert.equal(formatApprovalReason('destructive'), 'Destructive action');
});

test('yield expiry text stays stable for future and expired timestamps', () => {
    assert.equal(formatYieldExpiry(65_000, 0), 'Expires in 1m 5s');
    assert.equal(formatYieldExpiry(0, 0), null);
    assert.equal(formatYieldExpiry(5_000, 5_000), 'Expires now');
});