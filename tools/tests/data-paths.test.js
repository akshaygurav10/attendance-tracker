'use strict';
const test = require('node:test');
const assert = require('node:assert');
const D = require('../../data-paths.js');

const base = { name: 'X', username: 'x', memberKey: 'X', isAdmin: false, isManager: false, terminated: false, registeredAt: 't' };
const P = extra => Object.assign({}, base, extra);

test('path builders', () => {
    assert.strictEqual(D.paths.attendanceDay('tA', 'K', '2024-01-02'), 'teamData/tA/attendance/K/2024-01-02');
    assert.strictEqual(D.paths.leaveDay('unassigned', 'K', '2024-01-02'), 'teamData/unassigned/leaves/K/2024-01-02');
    assert.strictEqual(D.paths.member('tA', 'K'), 'teamData/tA/members/K');
    assert.strictEqual(D.paths.attendance('tA'), 'teamData/tA/attendance');
    assert.strictEqual(D.paths.profile('u1'), 'usersV2/u1');
});

test('bucketOf and roleOf, including team-less Admin/Manager treated as unassigned', () => {
    assert.strictEqual(D.bucketOf(P({})), 'unassigned');
    assert.strictEqual(D.bucketOf(P({ teamId: 'tA' })), 'tA');
    assert.strictEqual(D.roleOf(P({ isSuperAdmin: true })), 'superuser');
    assert.strictEqual(D.roleOf(P({ isAdmin: true, teamId: 'tA' })), 'admin');
    assert.strictEqual(D.roleOf(P({ isAdmin: true })), 'unassigned');
    assert.strictEqual(D.roleOf(P({ isManager: true, teamId: 'tA' })), 'manager');
    assert.strictEqual(D.roleOf(P({ isManager: true })), 'unassigned');
    assert.strictEqual(D.roleOf(P({ teamId: 'tA' })), 'employee');
    assert.strictEqual(D.roleOf(null), 'none');
});

test('canSelfAssignTeam: only non-privileged team-less users (Managers excluded, Q13)', () => {
    assert.ok(D.canSelfAssignTeam(P({})));
    assert.ok(!D.canSelfAssignTeam(P({ teamId: 'tA' })));
    assert.ok(!D.canSelfAssignTeam(P({ isManager: true })));
    assert.ok(!D.canSelfAssignTeam(P({ isAdmin: true })));
    assert.ok(!D.canSelfAssignTeam(P({ isSuperAdmin: true })));
    assert.ok(!D.canSelfAssignTeam(null));
});

test('listener plan per role (design 5.2)', () => {
    const su = D.listenerPlan(P({ isSuperAdmin: true }), {});
    assert.deepStrictEqual(su.paths, ['teamData', 'teams', 'holidays', 'settings', 'usersV2']);
    const adm = D.listenerPlan(P({ isAdmin: true, teamId: 'tA' }), {});
    assert.deepStrictEqual(adm.paths.slice(0, 3), ['teamData/tA/members', 'teamData/tA/attendance', 'teamData/tA/leaves']);
    assert.ok(adm.perUidProfiles);
    const mgr = D.listenerPlan(P({ isManager: true, teamId: 'tA' }), {});
    assert.ok(mgr.teamWide && !mgr.perUidProfiles);
    const empOff = D.listenerPlan(P({ teamId: 'tA', memberKey: 'E' }), { everyoneSeesAll: false });
    assert.deepStrictEqual(empOff.paths.slice(0, 3), ['teamData/tA/members/E', 'teamData/tA/attendance/E', 'teamData/tA/leaves/E']);
    const empOn = D.listenerPlan(P({ teamId: 'tA', memberKey: 'E' }), { everyoneSeesAll: true });
    assert.ok(empOn.teamWide);
    assert.strictEqual(empOn.paths[0], 'teamData/tA/members');
    const empFallback = D.listenerPlan(P({ teamId: 'tA', memberKey: 'E' }), { everyoneSeesAll: true }, { fallback: true });
    assert.ok(!empFallback.teamWide);
});

test('unassigned user never gets a team-wide listener, even with the toggle on', () => {
    for (const prof of [P({ memberKey: 'U' }), P({ memberKey: 'U', isManager: true }), P({ memberKey: 'U', isAdmin: true })]) {
        const plan = D.listenerPlan(prof, { everyoneSeesAll: true });
        assert.ok(!plan.teamWide);
        assert.ok(plan.paths.every(p => !/^teamData\/unassigned\/(members|attendance|leaves)$/.test(p)), plan.paths.join(','));
        assert.ok(plan.paths.includes('teamData/unassigned/attendance/U'));
    }
});

test('assemble builds the legacy in-memory shape from per-team paths', () => {
    const profile = P({ name: 'Emp A', memberKey: 'Emp A', teamId: 'tA', isAdmin: true });
    const store = {
        'teamData/tA/members': {
            'Emp A': { name: 'Emp A', order: 2, uid: 'u1' },
            'J___DOT___Smith': { name: 'J.Smith', order: 1 },
            'Gone': { name: 'Gone', order: 3, terminated: true, uid: 'u3' }
        },
        'teamData/tA/attendance': { 'Emp A': { '2024-01-02': true }, 'J___DOT___Smith': { '2024-01-03': true } },
        'teamData/tA/leaves': { 'J___DOT___Smith': { '2024-01-04': 'wfh' } },
        holidays: { '2024-12-25': { name: 'Christmas' }, '2024-01-26': { name: 'Republic Day' } },
        teams: { tA: { id: 'tA', name: 'Team A' } },
        settings: { everyoneSeesAll: true },
        'usersV2/u2': P({ name: 'Mgr', isManager: true, teamId: 'tA' })
    };
    const a = D.assemble(store, profile, 'u1');
    assert.deepStrictEqual(a.teamMembers, ['J.Smith', 'Emp A']);
    assert.deepStrictEqual(a.attendance['J.Smith'], { '2024-01-03': true });
    assert.deepStrictEqual(a.leaves['J.Smith'], { '2024-01-04': 'wfh' });
    assert.deepStrictEqual(a.holidays.map(h => h.date), ['2024-01-26', '2024-12-25']);
    assert.strictEqual(a.memberTeams['J___DOT___Smith'], 'tA');
    assert.deepStrictEqual(a.terminated.map(t => t.name), ['Gone']);
    assert.strictEqual(a.roster['Emp A'].uid, 'u1');
    assert.ok(a.admins.includes('Emp A'));
    assert.ok(a.managers.includes('Mgr'));
    assert.strictEqual(a.settings.everyoneSeesAll, true);
});

test('assemble role derivation: Employee knows nothing about others', () => {
    const profile = P({ name: 'E', memberKey: 'E', teamId: 'tA' });
    const a = D.assemble({ 'teamData/tA/members/E': { name: 'E', order: 1, uid: 'u1' } }, profile, 'u1');
    assert.deepStrictEqual(a.admins, []);
    assert.deepStrictEqual(a.managers, []);
    assert.deepStrictEqual(a.teamMembers, ['E']);
});

test('assemble role derivation: Superuser from the whole usersV2 node', () => {
    const profile = P({ name: 'Super', memberKey: 'Super', isSuperAdmin: true, isAdmin: true });
    const a = D.assemble({ usersV2: { su: profile, a1: P({ name: 'A1', isAdmin: true }), m1: P({ name: 'M1', isManager: true }), t1: P({ name: 'T1', isAdmin: true, terminated: true }) } }, profile, 'su');
    assert.deepStrictEqual(a.admins.sort(), ['A1', 'Super']);
    assert.deepStrictEqual(a.managers, ['M1']);
});

test('assemble: signed-in user without a roster entry still sees themselves', () => {
    const profile = P({ name: 'New', memberKey: 'New' });
    const a = D.assemble({}, profile, 'u9');
    assert.deepStrictEqual(a.teamMembers, ['New']);
    assert.strictEqual(a.roster.New.teamId, 'unassigned');
});

test('self move step 3 payload copies where absent, then deletes the unassigned copies', () => {
    const profile = P({ name: 'U', memberKey: 'U', teamId: 'tA' });
    const src = {
        member: { name: 'U', order: 5, uid: 'u1', addedBy: 'U' },
        attendance: { '2024-01-02': true, '2024-01-03': true },
        leaves: { '2024-01-04': 'planned' }
    };
    const existing = { member: null, attendance: { '2024-01-03': true }, leaves: null };
    const p = D.selfMoveStep3Payload(profile, 'u1', 'tA', src, existing);
    assert.deepStrictEqual(p['teamData/tA/members/U'], { name: 'U', order: 5, uid: 'u1', addedBy: 'U' });
    assert.strictEqual(p['teamData/tA/attendance/U/2024-01-02'], true);
    assert.ok(!('teamData/tA/attendance/U/2024-01-03' in p));
    assert.strictEqual(p['teamData/tA/leaves/U/2024-01-04'], 'planned');
    assert.strictEqual(p['teamData/unassigned/members/U'], null);
    assert.strictEqual(p['teamData/unassigned/attendance/U'], null);
    assert.strictEqual(p['teamData/unassigned/leaves/U'], null);
    assert.ok(!Object.keys(p).some(k => k.startsWith('usersV2/')), 'no profile write in step 3');
});

test('self move step 3 attaches uid to an existing entry instead of overwriting it', () => {
    const profile = P({ name: 'U', memberKey: 'U', teamId: 'tA' });
    const p = D.selfMoveStep3Payload(profile, 'u1', 'tA', { member: null, attendance: null, leaves: null }, { member: { name: 'U', order: 1 } });
    assert.deepStrictEqual(p, { 'teamData/tA/members/U/uid': 'u1' });
});

test('member move payload (Superuser) copies leaves, removes old and sets/clears teamId', () => {
    const data = { member: { name: 'E', order: 1, uid: 'u1' }, attendance: { '2024-01-02': true }, leaves: { '2024-01-03': 'wfh' } };
    const p = D.memberMovePayload('E', 'tA', 'tB', data, 'u1');
    assert.strictEqual(p['teamData/tB/attendance/E/2024-01-02'], true);
    assert.strictEqual(p['teamData/tA/attendance/E'], null);
    assert.strictEqual(p['usersV2/u1/teamId'], 'tB');
    const back = D.memberMovePayload('E', 'tB', 'unassigned', data, 'u1');
    assert.strictEqual(back['usersV2/u1/teamId'], null);
});

test('terminate and restore payloads (design 5.3)', () => {
    const entry = { teamId: 'tA', key: 'E', uid: 'u1' };
    const t = D.terminatePayload(entry, { isAdmin: true }, 'now');
    assert.deepStrictEqual(t, {
        'teamData/tA/members/E/terminated': true,
        'usersV2/u1/terminated': true,
        'usersV2/u1/terminatedAt': 'now',
        'usersV2/u1/isAdmin': false
    });
    assert.ok(!('usersV2/u1/isManager' in t));
    const rosterOnly = D.terminatePayload({ teamId: 'tA', key: 'R', uid: null }, null, 'now');
    assert.deepStrictEqual(rosterOnly, { 'teamData/tA/members/R/terminated': true });
    const r = D.restorePayload(entry);
    assert.strictEqual(r['usersV2/u1/mustResetPassword'], true);
    assert.strictEqual(r['usersV2/u1/terminatedAt'], null);
    assert.ok(!('usersV2/u1/isAdmin' in r), 'restore does not bring back Admin');
});

test('team payloads write teams and teamNames together; delete moves members to unassigned', () => {
    assert.deepStrictEqual(Object.keys(D.teamCreatePayload('t1', 'T', 'Super', 'now')).sort(), ['teamNames/t1', 'teams/t1']);
    assert.deepStrictEqual(D.teamRenamePayload('t1', 'N'), { 'teams/t1/name': 'N', 'teamNames/t1': 'N' });
    const node = {
        members: { E: { name: 'E', order: 1, uid: 'u1' }, R: { name: 'R', order: 2 } },
        attendance: { E: { '2024-01-02': true } },
        leaves: { R: { '2024-01-03': 'leave' } }
    };
    const p = D.teamDeletePayload('t1', node);
    assert.strictEqual(p['teamData/unassigned/members/E'].uid, 'u1');
    assert.strictEqual(p['teamData/unassigned/attendance/E/2024-01-02'], true);
    assert.strictEqual(p['teamData/unassigned/leaves/R/2024-01-03'], 'leave');
    assert.strictEqual(p['usersV2/u1/teamId'], null);
    assert.ok(!('teamData/t1' in p), 'no whole-team write (rules grant per member key)');
    assert.strictEqual(p['teamData/t1/members/E'], null);
    assert.strictEqual(p['teamData/t1/members/R'], null);
    assert.strictEqual(p['teamData/t1/attendance/E'], null);
    assert.strictEqual(p['teamData/t1/leaves/R'], null);
    assert.strictEqual(p['teams/t1'], null);
    assert.strictEqual(p['teamNames/t1'], null);
    const keys = Object.keys(p);
    for (const a of keys) for (const b of keys) if (a !== b) assert.ok(!b.startsWith(a + '/'), 'overlapping paths ' + a + ' / ' + b);
});

test('holidayListToNode drops malformed entries', () => {
    assert.deepStrictEqual(D.holidayListToNode([{ date: '2024-12-25', name: 'X' }, { date: 'bad', name: 'Y' }, { date: '2024-01-01' }]),
        { '2024-12-25': { name: 'X' } });
});
