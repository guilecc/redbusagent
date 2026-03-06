import assert from 'node:assert/strict';
import test from 'node:test';
import { STUDIO_IPC_VERSION, type StudioForgedSkill, type StudioMainEvent } from '@redbusagent/shared/studio';
import { eventToActions } from './useStudioBridge';
import { INITIAL_STATE, studioReducer } from './useStudioStore';

test('daemon forge events become forge activity entries in the renderer', () => {
    const event: StudioMainEvent = {
        version: STUDIO_IPC_VERSION,
        type: 'daemon/forge',
        payload: {
            requestId: 'req-1',
            event: 'FORGE_START',
            skillName: 'csv-helper',
            forgingReason: 'User asked for a CSV helper.',
            description: 'Parse CSV rows',
        },
    };

    const actions = eventToActions(event);
    assert.equal(actions.length, 1);

    const activity = actions[0];
    assert.ok(activity);
    assert.equal(activity.type, 'ADD_ACTIVITY');
    if (activity.type !== 'ADD_ACTIVITY') {
        return;
    }

    assert.equal(activity.payload.source, 'Forge');
    assert.match(activity.payload.message, /FORGE_START/u);
    assert.match(activity.payload.detail ?? '', /CSV helper/u);
});

test('studio reducer stores fetched forged skills in the library slice', () => {
    const skill: StudioForgedSkill = {
        skillName: 'csv-helper',
        name: 'CSV Helper',
        toolName: 'csv_helper',
        description: 'Parse CSV rows into objects.',
        forgingReason: 'User asked for CSV parsing.',
        source: 'forge-tdd',
        createdAt: '2026-03-06T12:00:00.000Z',
        language: 'typescript',
        entrypoint: 'index.cjs',
        skillPackagePath: '/tmp/csv-helper/skill.json',
    };

    const next = studioReducer(INITIAL_STATE, {
        type: 'SET_LIBRARY',
        payload: {
            skills: [skill],
            loadedAt: 123,
        },
    });

    assert.equal(next.library.status, 'ready');
    assert.equal(next.library.skills.length, 1);
    assert.equal(next.library.skills[0]?.forgingReason, 'User asked for CSV parsing.');
    assert.equal(next.library.lastLoadedAt, 123);
});