'use strict';
// Integration: the real secure-mode client flows and payload builders
// (secure-flows.js, data-paths.js) run against the Database emulator with
// database.rules.json loaded. Auth is a local stub that only hands out uids;
// every database call runs as that uid through @firebase/rules-unit-testing.
// Emulator only (demo project id). No live Firebase project is contacted.

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const F = require('../secure-flows.js');
const D = require('../data-paths.js');

const RULES = fs.readFileSync(path.join(__dirname, '..', 'database.rules.json'), 'utf8');
const ISO = '2024-01-01T00:00:00.000Z';
let env;

function profile(name, extra) {
    return Object.assign({
        name, username: name.toLowerCase().replace(/[^a-z0-9._-]/g, ''), memberKey: name.replace(/\./g, '___DOT___'),
        isAdmin: false, isManager: false, terminated: false, registeredAt: ISO
    }, extra || {});
}

const USERS = {
    su: profile('Super', { isSuperAdmin: true, isAdmin: true }),
    admA: profile('AdminA', { isAdmin: true, teamId: 'tA' }),
    empA: profile('EmpA', { teamId: 'tA' }),
    mgrA: profile('MgrA', { isManager: true, teamId: 'tA' }),
    una1: profile('Una1'),
    mgrNT: profile('MgrNT', { isManager: true })
};

async function seed() {
    const owners = {};
    Object.keys(USERS).forEach(uid => { owners[USERS[uid].memberKey] = uid; });
    await env.withSecurityRulesDisabled(ctx => ctx.database().ref().set({
        teams: { tA: { id: 'tA', name: 'Team A', createdBy: 'Super', createdAt: ISO }, tB: { id: 'tB', name: 'Team B', createdBy: 'Super', createdAt: ISO } },
        teamNames: { tA: 'Team A', tB: 'Team B' },
        settings: { everyoneSeesAll: false },
        usersV2: USERS,
        memberOwners: owners,
        teamData: {
            tA: {
                members: { AdminA: { name: 'AdminA', order: 1, uid: 'admA' }, EmpA: { name: 'EmpA', order: 2, uid: 'empA' }, PreAdded: { name: 'PreAdded', order: 3, addedBy: 'AdminA' } },
                attendance: { EmpA: { '2024-01-02': true } },
                leaves: { EmpA: { '2024-01-03': 'wfh' } }
            },
            unassigned: {
                members: { Una1: { name: 'Una1', order: 0, uid: 'una1' } },
                attendance: { Una1: { '2024-01-02': true } },
                leaves: { Una1: { '2024-01-04': 'planned' } }
            }
        }
    }));
}

// db facade bound to a uid (or to whoever the stub auth says is signed in).
function dbAs(uidOrFn) {
    const uid = () => (typeof uidOrFn === 'function' ? uidOrFn() : uidOrFn);
    const real = () => env.authenticatedContext(uid()).database();
    return { ref: p => (p === undefined ? real().ref() : real().ref(p)) };
}

async function adminRead(p) {
    let v;
    await env.withSecurityRulesDisabled(async ctx => { v = (await ctx.database().ref(p).once('value')).val(); });
    return v;
}

// Minimal Auth stub: creates uids; the database calls use the real rules.
function stubAuth() {
    const accounts = {};
    let n = 0;
    const auth = {
        currentUser: null,
        async createUserWithEmailAndPassword(email, password) {
            if (accounts[email]) { const e = new Error('dup'); e.code = 'auth/email-already-in-use'; throw e; }
            const uid = 'reg' + (++n);
            accounts[email] = { password, uid };
            auth.currentUser = { uid, email, delete: async () => { delete accounts[email]; auth.currentUser = null; auth.deleted = uid; } };
            return { user: auth.currentUser };
        },
        async signOut() { auth.currentUser = null; }
    };
    return auth;
}

before(async () => {
    env = await initializeTestEnvironment({ projectId: 'demo-attendance-client', database: { rules: RULES } });
});
after(async () => { if (env) await env.cleanup(); });
beforeEach(async () => { await env.clearDatabase(); await seed(); });

describe('registration flow against the rules', () => {
    test('new user registers into a team (claim, profile, roster) and gets no privileges', async () => {
        const auth = stubAuth();
        const db = dbAs(() => auth.currentUser.uid);
        const r = await F.register({ auth, db, name: 'New Person', password: 'secret1', confirm: 'secret1', teamId: 'tB', teamNames: { tA: 'Team A', tB: 'Team B' } });
        assert.ok(r.ok, r.message);
        assert.strictEqual(r.rosterOk, true);
        const prof = await adminRead('usersV2/' + r.uid);
        assert.strictEqual(prof.isAdmin, false);
        assert.strictEqual(prof.teamId, 'tB');
        assert.strictEqual((await adminRead('teamData/tB/members/New Person')).uid, r.uid);
    });

    test('registering a pre-added roster name attaches the uid to the existing entry', async () => {
        const auth = stubAuth();
        const db = dbAs(() => auth.currentUser.uid);
        const r = await F.register({ auth, db, name: 'PreAdded', password: 'secret1', confirm: 'secret1', teamId: 'tA', teamNames: { tA: 'Team A' } });
        assert.ok(r.ok, r.message);
        assert.deepStrictEqual(await adminRead('teamData/tA/members/PreAdded'), { name: 'PreAdded', order: 3, addedBy: 'AdminA', uid: r.uid });
    });

    test('an already registered name is refused at step 3 and the Auth user is deleted', async () => {
        const auth = stubAuth();
        const db = dbAs(() => auth.currentUser.uid);
        const r = await F.register({ auth, db, name: 'EmpA', password: 'secret1', confirm: 'secret1', teamId: 'tA', teamNames: { tA: 'Team A' } });
        assert.strictEqual(r.step, 3);
        assert.strictEqual(auth.deleted, 'reg1');
        assert.strictEqual(await adminRead('usersV2/reg1'), null);
    });

    test('a name with dots registers with the encoded key', async () => {
        const auth = stubAuth();
        const db = dbAs(() => auth.currentUser.uid);
        const r = await F.register({ auth, db, name: 'J.R. Smith', password: 'secret1', confirm: 'secret1', teamNames: {} });
        assert.ok(r.ok, r.message);
        assert.ok(await adminRead('teamData/unassigned/members/J___DOT___R___DOT___ Smith'));
    });
});

describe('post sign-in flow against the rules', () => {
    test('6a: team-less user picks a team; history moves; unassigned copies removed', async () => {
        const r = await F.postSignIn({ db: dbAs('una1'), uid: 'una1', profile: USERS.una1, pickedTeam: 'tA', teamNames: { tA: 'Team A' }, now: 5 });
        assert.ok(r.ok, r.message);
        assert.deepStrictEqual(await adminRead('teamData/tA/attendance/Una1'), { '2024-01-02': true });
        assert.deepStrictEqual(await adminRead('teamData/tA/leaves/Una1'), { '2024-01-04': 'planned' });
        assert.strictEqual(await adminRead('teamData/unassigned/members/Una1'), null);
        assert.strictEqual(await adminRead('usersV2/una1/teamId'), 'tA');
    });

    test('6b: interrupted move after step 2 is repaired at the next login', async () => {
        await assertSucceeds(dbAs('una1').ref('usersV2/una1/teamId').set('tA'));
        const p = Object.assign({}, USERS.una1, { teamId: 'tA' });
        const r = await F.postSignIn({ db: dbAs('una1'), uid: 'una1', profile: p, teamNames: { tA: 'Team A' }, now: 5 });
        assert.ok(r.ok, r.message);
        assert.deepStrictEqual(await adminRead('teamData/tA/attendance/Una1'), { '2024-01-02': true });
        assert.strictEqual(await adminRead('teamData/unassigned/attendance/Una1'), null);
    });

    test('team-less Manager: no team pick, roster self-heal in unassigned, waiting message', async () => {
        const r = await F.postSignIn({ db: dbAs('mgrNT'), uid: 'mgrNT', profile: USERS.mgrNT, pickedTeam: 'tA', teamNames: { tA: 'Team A' }, now: 5 });
        assert.ok(r.ok, r.message);
        assert.ok(r.waitingForTeam);
        assert.strictEqual(await adminRead('usersV2/mgrNT/teamId'), null);
        assert.ok(await adminRead('teamData/unassigned/members/MgrNT'));
    });

    test('6b: Admin-deleted roster entry is recreated by the member', async () => {
        await env.withSecurityRulesDisabled(ctx => ctx.database().ref('teamData/tA/members/EmpA').remove());
        const r = await F.postSignIn({ db: dbAs('empA'), uid: 'empA', profile: USERS.empA, teamNames: {}, now: 9 });
        assert.ok(r.ok, r.message);
        assert.strictEqual((await adminRead('teamData/tA/members/EmpA')).uid, 'empA');
    });
});

describe('client payloads against the rules', () => {
    test('Employee marks attendance and every leave type on own path (granular writes)', async () => {
        const db = dbAs('empA');
        await assertSucceeds(db.ref().update({ [D.paths.attendanceDay('tA', 'EmpA', '2024-02-01')]: true }));
        for (const t of D.LEAVE_TYPES) {
            await assertSucceeds(db.ref().update({ [D.paths.leaveDay('tA', 'EmpA', '2024-02-02')]: t, [D.paths.attendanceDay('tA', 'EmpA', '2024-02-02')]: null }));
        }
        await assertFails(db.ref().update({ [D.paths.attendanceDay('tA', 'AdminA', '2024-02-01')]: true }));
    });

    test('Admin terminate then restore (design 5.3 payloads)', async () => {
        const db = dbAs('admA');
        const entry = { teamId: 'tA', key: 'EmpA', uid: 'empA' };
        await assertSucceeds(db.ref().update(D.terminatePayload(entry, USERS.empA, ISO)));
        assert.strictEqual(await adminRead('usersV2/empA/terminated'), true);
        await assertSucceeds(db.ref().update(D.restorePayload(entry)));
        assert.strictEqual(await adminRead('usersV2/empA/terminated'), false);
        assert.strictEqual(await adminRead('usersV2/empA/mustResetPassword'), true);
        assert.strictEqual(await adminRead('teamData/tA/members/EmpA/terminated'), false);
    });

    test('Admin terminating another Admin also clears isAdmin', async () => {
        await env.withSecurityRulesDisabled(ctx => ctx.database().ref('usersV2/empA/isAdmin').set(true));
        await assertSucceeds(dbAs('admA').ref().update(D.terminatePayload({ teamId: 'tA', key: 'EmpA', uid: 'empA' }, { isAdmin: true }, ISO)));
        assert.strictEqual(await adminRead('usersV2/empA/isAdmin'), false);
    });

    test('Admin adds a roster-only member and requests a password reset for a teammate', async () => {
        const db = dbAs('admA');
        await assertSucceeds(db.ref(D.paths.member('tA', 'Newbie')).set({ name: 'Newbie', order: 10, addedBy: 'AdminA' }));
        await assertSucceeds(F.requestPasswordReset(db, 'empA', 'admA', ISO));
        await assertFails(F.requestPasswordReset(dbAs('mgrA'), 'empA', 'mgrA', ISO));
    });

    test('Manager cannot use Admin payloads', async () => {
        await assertFails(dbAs('mgrA').ref().update(D.terminatePayload({ teamId: 'tA', key: 'EmpA', uid: 'empA' }, null, ISO)));
    });

    test('Superuser: create, rename, move a member, delete a team', async () => {
        const db = dbAs('su');
        await assertSucceeds(db.ref().update(D.teamCreatePayload('tC', 'Team C', 'Super', ISO)));
        await assertSucceeds(db.ref().update(D.teamRenamePayload('tC', 'Team C2')));
        assert.strictEqual(await adminRead('teamNames/tC'), 'Team C2');
        const node = await adminRead('teamData/tA');
        const data = { member: node.members.EmpA, attendance: node.attendance.EmpA, leaves: node.leaves.EmpA };
        await assertSucceeds(db.ref().update(D.memberMovePayload('EmpA', 'tA', 'tC', data, 'empA')));
        assert.strictEqual(await adminRead('usersV2/empA/teamId'), 'tC');
        assert.deepStrictEqual(await adminRead('teamData/tC/attendance/EmpA'), { '2024-01-02': true });
        await assertSucceeds(db.ref().update(D.teamDeletePayload('tC', await adminRead('teamData/tC'))));
        assert.strictEqual(await adminRead('teams/tC'), null);
        assert.strictEqual(await adminRead('teamNames/tC'), null);
        assert.strictEqual(await adminRead('usersV2/empA/teamId'), null);
        assert.deepStrictEqual(await adminRead('teamData/unassigned/attendance/EmpA'), { '2024-01-02': true });
    });

    test('Admin cannot create teams or move members', async () => {
        await assertFails(dbAs('admA').ref().update(D.teamCreatePayload('tX', 'X', 'AdminA', ISO)));
        await assertFails(dbAs('admA').ref().update(D.memberMovePayload('EmpA', 'tA', 'tB', { member: { name: 'EmpA', order: 1 } }, 'empA')));
    });

    test('listener plan paths are readable for each role, and the team-wide set is denied to an Employee with the toggle off', async () => {
        const cases = [['su', USERS.su], ['admA', USERS.admA], ['mgrA', USERS.mgrA], ['empA', USERS.empA], ['una1', USERS.una1]];
        for (const [uid, prof] of cases) {
            const plan = D.listenerPlan(prof, { everyoneSeesAll: false });
            for (const p of plan.paths) await assertSucceeds(dbAs(uid).ref(p).once('value'));
            await assertSucceeds(dbAs(uid).ref(D.paths.profile(uid)).once('value'));
        }
        const on = D.listenerPlan(USERS.empA, { everyoneSeesAll: true });
        await assertFails(dbAs('empA').ref(on.paths[0]).once('value'));
    });
});
