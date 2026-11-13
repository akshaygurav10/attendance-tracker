'use strict';
// Secure mode: permission results must not change when localStorage, the DOM or
// the page globals ADMIN_MEMBERS / MANAGERS / TEAM_MEMBERS / MEMBER_TEAMS are
// overwritten (what someone can do from the browser dev tools).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeEnv, flush, read } = require('./secure-harness.js');

const NAMES = ['Adam A', 'Adam A2', 'Mia A2', 'Ord A', 'Ord B', 'Sue Super'];

function scenario() {
    const m = (name, uid, order) => ({ name, order, uid, addedBy: 'x' });
    return makeEnv({
        users: [
            { uid: 'uAdm', username: 'adam', profile: { name: 'Adam A', memberKey: 'Adam A', isAdmin: true, teamId: 'tA' } },
            { uid: 'uAdm2', username: 'adam2', profile: { name: 'Adam A2', memberKey: 'Adam A2', isAdmin: true, teamId: 'tA' } },
            { uid: 'uMgr', username: 'mia', profile: { name: 'Mia A2', memberKey: 'Mia A2', isManager: true, teamId: 'tA' } },
            { uid: 'uOrd', username: 'ord', profile: { name: 'Ord A', memberKey: 'Ord A', teamId: 'tA' } },
            { uid: 'uOrdB', username: 'ordb', profile: { name: 'Ord B', memberKey: 'Ord B', teamId: 'tB' } },
            { uid: 'uSu', username: 'sue', profile: { name: 'Sue Super', memberKey: 'Sue Super', isAdmin: true, isSuperAdmin: true } }
        ],
        tree: {
            teams: { tA: { id: 'tA', name: 'Team A' }, tB: { id: 'tB', name: 'Team B' } },
            teamNames: { tA: 'Team A', tB: 'Team B' },
            teamData: {
                tA: { members: { 'Adam A': m('Adam A', 'uAdm', 1), 'Adam A2': m('Adam A2', 'uAdm2', 2), 'Mia A2': m('Mia A2', 'uMgr', 3), 'Ord A': m('Ord A', 'uOrd', 4) } },
                tB: { members: { 'Ord B': m('Ord B', 'uOrdB', 1) } },
                unassigned: { members: { 'Sue Super': m('Sue Super', 'uSu', 1) } }
            }
        }
    });
}

function probe(env) {
    return JSON.parse(env.run(`JSON.stringify({
        isSuperUser: isSuperUser(), isAdmin: isAdmin(), isManager: isManager(), me: getCurrentUser(),
        canAdminMember: ${JSON.stringify(NAMES)}.map(n => canAdminMember(n)),
        canEdit: ${JSON.stringify(NAMES)}.map(n => canEdit(n)),
        deny: ${JSON.stringify(NAMES)}.map(n => ['canTerminate', 'canRestore', 'canRename', 'canForceReset', 'canReorder'].map(a => SecureMode.denyText(a, n))),
        scope: getAdminScopeMembers(),
        canAssignRoles: canAssignRoles(), canManageTeams: canManageTeams(), canImportData: canImportData()
    })`));
}

function tamper(env) {
    env.storage.attendance_current_user = 'Sue Super';
    env.storage.attendance_admin_list = JSON.stringify(['Sue Super', 'Ord A', 'Adam A']);
    env.storage.attendance_team_members = JSON.stringify(NAMES.concat(['Fake']));
    env.run(`
        ADMIN_MEMBERS = ['Sue Super', 'Ord A', 'Adam A2', 'Ord B'];
        MANAGERS = ['Adam A', 'Ord A', 'Sue Super'];
        TEAM_MEMBERS = ['Fake', 'Sue Super', 'Ord B', 'Ord A', 'Adam A2'];
        MEMBER_TEAMS = { 'Ord B': 'tA', 'Adam A2': 'tB', 'Sue Super': 'tA', 'Fake': 'tA' };
    `);
    env.element('toggleVisibility').checked = true;
    env.element('loginUsername').value = 'Sue Super';
    env.element('currentUserDisplay').innerHTML = 'Sue Super';
}

test('team Admin: permission results are identical after tampering with storage, DOM and globals', async () => {
    const env = scenario();
    await env.login('adam');
    const before = probe(env);
    assert.strictEqual(before.me, 'Adam A');
    assert.strictEqual(before.isAdmin, true);
    assert.strictEqual(before.isSuperUser, false);
    assert.deepStrictEqual(before.canAdminMember, [true, false, false, true, false, false]);
    assert.deepStrictEqual(before.scope.sort(), ['Adam A', 'Adam A2', 'Mia A2', 'Ord A']);
    tamper(env);
    await env.flush();
    assert.deepStrictEqual(probe(env), before);
});

test('Superuser: permission results are identical after tampering', async () => {
    const env = scenario();
    await env.login('sue');
    const before = probe(env);
    assert.strictEqual(before.isSuperUser, true);
    assert.deepStrictEqual(before.canAdminMember, [true, true, true, true, true, true]);
    tamper(env);
    env.storage.attendance_current_user = 'Ord A';
    assert.deepStrictEqual(probe(env), before);
});

test('Employee cannot become Admin or Superuser through storage or globals', async () => {
    const env = scenario();
    await env.login('ord');
    const before = probe(env);
    assert.strictEqual(before.isAdmin, false);
    assert.strictEqual(before.isSuperUser, false);
    assert.deepStrictEqual(before.canAdminMember, [false, false, false, false, false, false]);
    assert.deepStrictEqual(before.scope, []);
    tamper(env);
    env.run("ADMIN_MEMBERS = ['Ord A']; MANAGERS = ['Ord A'];");
    env.storage.attendance_current_user = 'Adam A';
    assert.deepStrictEqual(probe(env), before);
});

test('the exported SecureMode object is frozen and exposes no mutable state', async () => {
    const env = scenario();
    await env.login('adam');
    assert.strictEqual(env.run('Object.isFrozen(SecureMode)'), true);
    assert.strictEqual(env.run("typeof SecureMode.state"), 'undefined');
    // Overwriting a method or a snapshot changes nothing
    env.run("SecureMode.isSuper = () => true; SecureMode.snapshot().profile.isSuperAdmin = true;");
    env.run("SecureMode.rosterFor('Adam A2').teamId = 'other'; SecureMode.rosterFor('Adam A2').uid = null;");
    env.run("SecureMode.snapshot().profiles.uAdm2.isAdmin = false;");
    assert.strictEqual(env.run('isSuperUser()'), false);
    assert.strictEqual(env.run("canAdminMember('Adam A2')"), false);
    assert.strictEqual(env.run('SecureMode.snapshot().profile.isSuperAdmin'), undefined);
    assert.strictEqual(env.run("SecureMode.rosterFor('Adam A2').teamId"), 'tA');
    assert.strictEqual(env.run("SecureMode.snapshot().profiles.uAdm2.isAdmin"), true);
});

test('team Admin actions on Admins, Managers and the Superuser are refused and write nothing', async () => {
    const env = scenario();
    await env.login('adam');
    const writes = () => env.db.state.writes.length;
    const base = writes();
    for (const name of ['Adam A2', 'Mia A2', 'Sue Super', 'Ord B']) {
        env.run(`SecureMode.removeMember(__app, ${JSON.stringify(name)})`);
        env.run(`SecureMode.editMember(__app, ${JSON.stringify(name)}, 'Renamed')`);
        await env.run(`SecureMode.requestReset(${JSON.stringify(name)})`);
        await env.run(`SecureMode.restoreMember(__app, ${JSON.stringify(name)})`);
        assert.strictEqual(env.run(`SecureMode.setRole(__app, ${JSON.stringify(name)}, 'isAdmin', true)`), false);
    }
    assert.strictEqual(writes(), base);
    assert.ok(env.alerts.some(a => a.includes('Only the Superuser can manage Admins and Managers.')));
    assert.ok(env.alerts.some(a => a.includes('Only the Superuser can assign') || a.includes('Only the Superuser can manage')));
});

test('team Admin can still manage an ordinary member of the own team', async () => {
    const env = scenario();
    await env.login('adam');
    const base = env.db.state.writes.length;
    env.run("SecureMode.removeMember(__app, 'Ord A')");
    assert.strictEqual(env.db.state.writes.length, base + 1);
    const w = env.db.state.writes[env.db.state.writes.length - 1];
    assert.strictEqual(w.value['teamData/tA/members/Ord A/terminated'], true);
});

test('Superuser cannot remove or rename the own account', async () => {
    const env = scenario();
    await env.login('sue');
    const base = env.db.state.writes.length;
    env.run("SecureMode.removeMember(__app, 'Sue Super')");
    env.run("SecureMode.editMember(__app, 'Sue Super', 'Renamed')");
    env.run("SecureMode.setRole(__app, 'Sue Super', 'isAdmin', false)");
    assert.strictEqual(env.db.state.writes.length, base);
    assert.ok(env.alerts.some(a => a.includes('The Superuser account cannot be removed or changed.')));
    // ...but can manage another Admin
    env.run("SecureMode.removeMember(__app, 'Adam A2')");
    assert.strictEqual(env.db.state.writes.length, base + 1);
});

test('reorderMembers writes order only for members the actor may manage', async () => {
    const env = scenario();
    await env.login('adam');
    const base = env.db.state.writes.length;
    assert.strictEqual(env.run("SecureMode.reorderMembers('Ord A', 'Adam A2')"), false);
    assert.strictEqual(env.db.state.writes.length, base);
    assert.strictEqual(env.run("SecureMode.reorderMembers('Ord A', 'Adam A')"), true);
    await flush();
    const keys = Object.keys(env.db.state.writes[env.db.state.writes.length - 1].value);
    assert.deepStrictEqual(keys.sort(), ['teamData/tA/members/Adam A/order', 'teamData/tA/members/Ord A/order']);
});

test('terminated Admins and Managers are hidden from team Admins', async () => {
    const env = scenario();
    env.db.state.tree.teamData.tA.members['Mia A2'].terminated = true;
    env.db.state.tree.teamData.tA.members['Ord A'].terminated = true;
    await env.login('adam');
    env.element('terminatedSection');
    env.run('SecureMode.renderTerminatedSection()');
    const html = env.element('terminatedSection').innerHTML;
    assert.ok(html.includes('Ord A'));
    assert.ok(!html.includes('Mia A2'));
});

test('source scan: secure-mode.js and permissions.js use no storage or global role arrays for permissions', () => {
    const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const secure = strip(read('secure-mode.js'));
    const perms = strip(read('permissions.js'));
    for (const [file, src] of [['secure-mode.js', secure], ['permissions.js', perms]]) {
        assert.ok(!/sessionStorage/.test(src), file + ' must not touch sessionStorage');
        for (const m of src.matchAll(/localStorage\.getItem\(\s*([^)]*)\)/g)) {
            assert.strictEqual(m[1].trim(), "'attendance_remembered_user'", file + ' reads localStorage: ' + m[0]);
        }
    }
    assert.ok(!/localStorage/.test(perms));
    assert.ok(!/document|getElementById/.test(perms));
    // The page globals may be assigned by refresh(), never read
    for (const g of ['TEAM_MEMBERS', 'ADMIN_MEMBERS', 'MANAGERS', 'MEMBER_TEAMS']) {
        const reads = [...secure.matchAll(new RegExp('\\b' + g + '\\b(?!\\s*=[^=])', 'g'))];
        assert.strictEqual(reads.length, 0, g + ' is read in secure-mode.js');
        assert.ok(!new RegExp('\\b' + g + '\\b').test(perms), g + ' referenced in permissions.js');
    }
    // The permission block never reads the DOM
    const start = read('secure-mode.js').indexOf('// ---------- permissions (private state only)');
    const end = read('secure-mode.js').indexOf('// ---------- listeners');
    assert.ok(start > 0 && end > start);
    const permBlock = strip(read('secure-mode.js').slice(start, end));
    assert.ok(!/\bel\(|document|localStorage|nameKey/.test(permBlock));
});
