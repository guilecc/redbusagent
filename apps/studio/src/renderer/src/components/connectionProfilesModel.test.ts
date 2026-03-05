import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DEFAULT_CONNECTION_DRAFT,
    buildProfileFromDraft,
    draftFromProfile,
    parseConnectionDraft,
    removeProfile,
    upsertProfile,
} from './connectionProfilesModel';

test('connection draft parsing accepts blank local forwarded ports', () => {
    const parsed = parseConnectionDraft(
        {
            ...DEFAULT_CONNECTION_DRAFT,
            host: 'prod.example.net',
            username: 'operator',
        },
        { requireLabel: false },
    );

    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.tunnel.host, 'prod.example.net');
    assert.equal(parsed.tunnel.localWsPort, undefined);
    assert.equal(parsed.tunnel.localApiPort, undefined);
});

test('saving a profile requires a name and validates numeric ports', () => {
    const parsed = parseConnectionDraft(
        {
            ...DEFAULT_CONNECTION_DRAFT,
            host: 'prod.example.net',
            username: 'operator',
            port: '70000',
        },
        { requireLabel: true },
    );

    assert.match(parsed.errors.join(' '), /Profile name is required/u);
    assert.match(parsed.errors.join(' '), /SSH port must be a whole number/u);
});

test('profile helpers round-trip drafts and replace existing profiles', () => {
    const profile = buildProfileFromDraft('profile-1', {
        ...DEFAULT_CONNECTION_DRAFT,
        label: 'Primary host',
        host: 'prod.example.net',
        username: 'operator',
        privateKeyPath: '~/.ssh/redbus',
        passphrase: 'transient-secret',
    });

    assert.equal(profile.label, 'Primary host');
    assert.equal(profile.tunnel.passphrase, undefined);

    const draft = draftFromProfile(profile);
    assert.equal(draft.label, 'Primary host');
    assert.equal(draft.passphrase, '');

    const replaced = upsertProfile([profile], { ...profile, label: 'Updated host' });
    assert.equal(replaced[0]?.label, 'Updated host');
    assert.deepEqual(removeProfile(replaced, 'profile-1'), []);
});