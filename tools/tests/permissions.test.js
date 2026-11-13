'use strict';
// Pure permission matrix: actor x target x action (permissions.js).
const test = require('node:test');
const assert = require('node:assert');
const P = require('../../permissions.js');

const actors = {
    su: { name: 'Sue Super', isSuperAdmin: true, isAdmin: true },
    admA: { name: 'Adam A', isAdmin: true, teamId: 'tA' },
    mgrA: { name: 'Mia A', isManager: true, teamId: 'tA' },
    empA: { name: 'Eve A', teamId: 'tA' }
};
const targets = {
    ordA: { name: 'Ord A', teamId: 'tA' },
    admA2: { name: 'Adam A2', isAdmin: true, teamId: 'tA' },
    mgrA2: { name: 'Mia A2', isManager: true, teamId: 'tA' },
    super: { name: 'Sue Super', isSuperAdmin: true, isAdmin: true },
    ordB: { name: 'Ord B', teamId: 'tB' },
    admB: { name: 'Adam B', isAdmin: true, teamId: 'tB' },
    ordNone: { name: 'Ord None' }
};
const ACTIONS = ['canAdminMember', 'canTerminate', 'canRestore', 'canRename', 'canForceReset', 'canReorder'];
const ALL = ACTIONS.reduce((o, a) => (o[a] = true, o), {});
const NONE = ACTIONS.reduce((o, a) => (o[a] = false, o), {});
const ATTEND_ONLY = Object.assign({}, NONE, { canAdminMember: true, canReorder: true });

// expected[actor][target] -> action map. `self` targets are built per actor below.
const expected = {
    su: { ordA: ALL, admA2: ALL, mgrA2: ALL, ordB: ALL, admB: ALL, ordNone: ALL },
    admA: {
        ordA: ALL, admA2: NONE, mgrA2: NONE, super: NONE, ordB: NONE, admB: NONE, ordNone: NONE
    },
    mgrA: { ordA: NONE, admA2: NONE, mgrA2: NONE, super: NONE, ordB: NONE, admB: NONE, ordNone: NONE },
    empA: { ordA: NONE, admA2: NONE, mgrA2: NONE, super: NONE, ordB: NONE, admB: NONE, ordNone: NONE }
};

for (const actorKey of Object.keys(expected)) {
    for (const targetKey of Object.keys(expected[actorKey])) {
        test(`matrix: ${actorKey} -> ${targetKey}`, () => {
            const actor = actors[actorKey];
            const target = targets[targetKey];
            for (const action of ACTIONS) {
                assert.strictEqual(P[action](actor, target), expected[actorKey][targetKey][action],
                    `${actorKey} ${action} ${targetKey}`);
            }
        });
    }
}

test('matrix: own row (self)', () => {
    // Superuser: can edit own attendance and order, but never remove, rename, reset or restore self
    assert.deepStrictEqual(ACTIONS.map(a => P[a](actors.su, actors.su)), [true, false, false, false, false, true]);
    // Team Admin: own attendance and order only
    assert.deepStrictEqual(ACTIONS.map(a => P[a](actors.admA, actors.admA)), ACTIONS.map(a => !!ATTEND_ONLY[a]));
    // Manager and Employee: nothing through this module (own data is handled by canEdit)
    for (const k of ['mgrA', 'empA']) {
        assert.deepStrictEqual(ACTIONS.map(a => P[a](actors[k], actors[k])), ACTIONS.map(() => false));
    }
});

test('matrix: a registered ordinary member of the Admin team with no flags is manageable', () => {
    assert.strictEqual(P.canTerminate(actors.admA, { name: 'X', teamId: 'tA', isAdmin: false, isManager: false, isSuperAdmin: false }), true);
});

test('matrix: ctx.targetTeamId overrides the profile team (terminated roster entry)', () => {
    const t = { name: 'Gone', teamId: 'tB' };
    assert.strictEqual(P.canRestore(actors.admA, t, { targetTeamId: 'tA' }), true);
    assert.strictEqual(P.canRestore(actors.admA, t, { targetTeamId: 'tB' }), false);
    assert.strictEqual(P.canRestore(actors.admA, t, { targetTeamId: 'unassigned' }), false);
    assert.strictEqual(P.canRestore(actors.su, t, { targetTeamId: 'unassigned' }), true);
});

test('matrix: ctx.isSelf decides self even when names differ', () => {
    assert.strictEqual(P.canTerminate(actors.su, { name: 'Other Name', isAdmin: false }, { isSelf: true }), false);
    // A Superuser target is protected even when it is not the actor
    assert.strictEqual(P.canTerminate(actors.su, Object.assign({}, actors.su, { name: 'Other Su' }), { isSelf: false }), false);
});

test('matrix: team-less Admin manages only self', () => {
    const lone = { name: 'Lone', isAdmin: true };
    assert.strictEqual(P.canAdminMember(lone, targets.ordNone), false);
    assert.strictEqual(P.canAdminMember(lone, targets.ordA), false);
    assert.strictEqual(P.canAdminMember(lone, lone), true);
});

test('missing actor or target is refused', () => {
    for (const a of ACTIONS) {
        assert.strictEqual(P[a](null, targets.ordA), false);
        assert.strictEqual(P[a](actors.su, null), false);
    }
});

test('privileged flag detection', () => {
    assert.strictEqual(P.isPrivilegedProfile({ isAdmin: true }), true);
    assert.strictEqual(P.isPrivilegedProfile({ isManager: true }), true);
    assert.strictEqual(P.isPrivilegedProfile({ isSuperAdmin: true }), true);
    assert.strictEqual(P.isPrivilegedProfile({ isAdmin: 'true' }), false);
    assert.strictEqual(P.isPrivilegedProfile({}), false);
    assert.strictEqual(P.isPrivilegedProfile(null), false);
});

test('superBlockReason and denyReason give clear messages', () => {
    assert.strictEqual(P.superBlockReason(actors.admA, targets.admA2), 'Only the Superuser can manage Admins and Managers.');
    assert.strictEqual(P.superBlockReason(actors.admA, targets.super), 'Only the Superuser can manage Admins and Managers.');
    assert.strictEqual(P.superBlockReason(actors.su, targets.super), 'The Superuser account cannot be removed or changed.');
    assert.strictEqual(P.superBlockReason(actors.su, targets.admA2), null);
    assert.strictEqual(P.superBlockReason(actors.admA, targets.ordA), null);
    const why = (actor, target, action) => P.denyReason(actor, target, undefined, P[action](actor, target));
    assert.strictEqual(why(actors.su, actors.su, 'canTerminate'), 'The Superuser account cannot be removed or changed.');
    assert.strictEqual(why(actors.admA, actors.admA, 'canTerminate'), 'You cannot do this to your own account.');
    assert.strictEqual(why(actors.admA, targets.mgrA2, 'canRename'), 'Only the Superuser can manage Admins and Managers.');
    assert.strictEqual(why(actors.admA, targets.ordB, 'canTerminate'), 'You can only manage members of your own team.');
    assert.strictEqual(why(actors.admA, targets.ordA, 'canTerminate'), null);
});

test('module has no storage, DOM or app-global dependencies', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'permissions.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/localStorage|sessionStorage|document\.|window\./.test(src));
    assert.ok(!/\b(ADMIN_MEMBERS|MANAGERS|TEAM_MEMBERS|MEMBER_TEAMS)\b/.test(src));
});
