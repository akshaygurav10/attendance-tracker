'use strict';
// Secure-mode flows against in-memory stubs (no network, no Firebase).
const test = require('node:test');
const assert = require('node:assert');
const F = require('../../secure-flows.js');
const { makeDb, makeAuth } = require('./stubs.js');

// Quiet the code-only error logging during tests, but capture it to assert no secrets leak.
const logged = [];
const origError = console.error;
test.before(() => { console.error = (...a) => logged.push(a.join(' ')); });
test.after(() => { console.error = origError; });

const TEAMS = { tA: 'Team A', tB: 'Team B' };
const cred = (email, password) => ({ email, password });

test('signIn tries candidates in order and advances on invalid-credential', async () => {
    const auth = makeAuth({ 'agurav@attendance.local': { password: 'secret1', uid: 'u1' } });
    const r = await F.signIn(auth, 'Akshay Gurav', 'secret1', 'LOCAL');
    assert.ok(r.ok);
    assert.strictEqual(r.user.uid, 'u1');
    assert.deepStrictEqual(auth.state.calls, ['signIn:akshaygurav@attendance.local', 'signIn:agurav@attendance.local']);
    assert.strictEqual(auth.state.persistence, 'LOCAL');
});

test('signIn: wrong password on every candidate gives one generic code', async () => {
    const auth = makeAuth({ 'agurav@attendance.local': { password: 'secret1', uid: 'u1' } });
    const r = await F.signIn(auth, 'Akshay Gurav', 'nope', 'SESSION');
    assert.ok(!r.ok);
    assert.strictEqual(r.code, 'auth/invalid-credential');
    assert.strictEqual(auth.state.calls.length, 3);
});

test('signIn stops on non-credential errors (too-many-requests)', async () => {
    const auth = makeAuth({}, { signInError: 'auth/too-many-requests' });
    const r = await F.signIn(auth, 'Akshay Gurav', 'x');
    assert.strictEqual(r.code, 'auth/too-many-requests');
    assert.strictEqual(auth.state.calls.length, 1);
});

test('checkProfile: missing, terminated, mustReset', () => {
    assert.strictEqual(F.checkProfile(null).message, 'Account not set up. Contact admin.');
    assert.strictEqual(F.checkProfile({ terminated: true }).message, 'Your account has been terminated. Contact admin.');
    assert.ok(F.checkProfile({ terminated: false, mustResetPassword: true }).mustReset);
});

test('register: four steps in order, profile has no privileges and no password hash', async () => {
    const auth = makeAuth({});
    const db = makeDb({ teamNames: TEAMS });
    const r = await F.register({ auth, db, name: 'Akshay Gurav', password: 'secret1', confirm: 'secret1', teamId: 'tA', teamNames: TEAMS, nowIso: 'T', now: 7 });
    assert.ok(r.ok, r.message);
    const order = db.state.writes.map(w => w.path);
    assert.deepStrictEqual(order, ['memberOwners/Akshay Gurav', 'usersV2/uid1', 'teamData/tA/members/Akshay Gurav']);
    const prof = db.get('usersV2/uid1');
    assert.deepStrictEqual(prof, { name: 'Akshay Gurav', username: 'agurav', memberKey: 'Akshay Gurav', isAdmin: false, isManager: false, terminated: false, registeredAt: 'T', teamId: 'tA' });
    assert.ok(!('passwordHash' in prof));
    assert.deepStrictEqual(db.get('teamData/tA/members/Akshay Gurav'), { name: 'Akshay Gurav', order: 7, uid: 'uid1', addedBy: 'Akshay Gurav' });
});

test('register: username collision takes the next candidate', async () => {
    const auth = makeAuth({ 'agurav@attendance.local': { password: 'x', uid: 'other' } });
    const db = makeDb({});
    const r = await F.register({ auth, db, name: 'Akshay Gurav', password: 'secret1', confirm: 'secret1', teamNames: {} });
    assert.ok(r.ok);
    assert.strictEqual(r.username, 'akgurav');
});

test('register: a team is required once teams exist; min 6 characters', async () => {
    const auth = makeAuth({});
    const db = makeDb({});
    let r = await F.register({ auth, db, name: 'A B', password: 'secret1', confirm: 'secret1', teamNames: TEAMS });
    assert.strictEqual(r.message, 'Please select your team.');
    r = await F.register({ auth, db, name: 'A B', password: '12345', confirm: '12345', teamNames: {} });
    assert.strictEqual(r.message, 'Password must be at least 6 characters.');
    assert.strictEqual(auth.state.calls.length, 0, 'no Auth user created on validation failure');
});

test('register rollback at step 3: name already claimed by someone else deletes the Auth user', async () => {
    const auth = makeAuth({});
    const db = makeDb({ memberOwners: { 'Akshay Gurav': 'someone' } },
        (op, path) => (op === 'write' && path === 'memberOwners/Akshay Gurav') || (op === 'read' && path === 'memberOwners/Akshay Gurav'));
    const r = await F.register({ auth, db, name: 'Akshay Gurav', password: 'secret1', confirm: 'secret1', teamNames: {} });
    assert.strictEqual(r.step, 3);
    assert.strictEqual(r.message, 'This name is already registered. Please login.');
    assert.deepStrictEqual(auth.state.deleted, ['uid1']);
    assert.strictEqual(db.get('usersV2/uid1'), null);
});

test('register step 3 retry: own claim already present is accepted', async () => {
    const auth = makeAuth({});
    const db = makeDb({}, (op, path) => op === 'write' && path === 'memberOwners/Akshay Gurav');
    // claim write denied, but the existing claim is ours (seeded after Auth user creation below)
    const origCreate = auth.createUserWithEmailAndPassword;
    auth.createUserWithEmailAndPassword = async (e, p) => {
        const res = await origCreate(e, p);
        db.state.tree.memberOwners = { 'Akshay Gurav': res.user.uid };
        return res;
    };
    const r = await F.register({ auth, db, name: 'Akshay Gurav', password: 'secret1', confirm: 'secret1', teamNames: {} });
    assert.ok(r.ok, r.message);
});

test('register rollback at step 4: profile denied removes the claim and the Auth user', async () => {
    const auth = makeAuth({});
    const db = makeDb({}, (op, path) => op === 'write' && path.startsWith('usersV2/'));
    const r = await F.register({ auth, db, name: 'Akshay Gurav', password: 'secret1', confirm: 'secret1', teamNames: {} });
    assert.strictEqual(r.step, 4);
    assert.strictEqual(r.message, 'Registration failed. Try again.');
    assert.strictEqual(db.get('memberOwners/Akshay Gurav'), null);
    assert.deepStrictEqual(auth.state.deleted, ['uid1']);
});

test('register rollback at step 4 when Auth delete fails: signs out instead', async () => {
    const auth = makeAuth({}, { failDelete: true });
    const db = makeDb({}, (op, path) => op === 'write' && path.startsWith('usersV2/'));
    const r = await F.register({ auth, db, name: 'Akshay Gurav', password: 'secret1', confirm: 'secret1', teamNames: {} });
    assert.strictEqual(r.step, 4);
    assert.strictEqual(auth.state.signedOut, 1);
});

test('register step 5 failure is non-fatal (repaired at next login)', async () => {
    const auth = makeAuth({});
    const db = makeDb({}, (op, path) => op === 'write' && path.startsWith('teamData/'));
    const r = await F.register({ auth, db, name: 'Akshay Gurav', password: 'secret1', confirm: 'secret1', teamNames: {} });
    assert.ok(r.ok);
    assert.strictEqual(r.rosterOk, false);
});

test('postSignIn 6a: team pick runs read, teamId write, then one copy-and-delete update', async () => {
    const db = makeDb({
        teamNames: TEAMS,
        usersV2: { u1: { name: 'U', memberKey: 'U', isAdmin: false, isManager: false, terminated: false } },
        teamData: { unassigned: { members: { U: { name: 'U', order: 3, uid: 'u1', addedBy: 'U' } }, attendance: { U: { '2024-01-02': true } }, leaves: { U: { '2024-01-03': 'wfh' } } } }
    });
    const profile = db.get('usersV2/u1');
    const r = await F.postSignIn({ db, uid: 'u1', profile, pickedTeam: 'tA', teamNames: TEAMS, now: 1 });
    assert.ok(r.ok, r.message);
    assert.strictEqual(r.profile.teamId, 'tA');
    const w = db.state.writes;
    assert.strictEqual(w[0].path, 'usersV2/u1/teamId');
    assert.strictEqual(w[1].op, 'update');
    assert.deepStrictEqual(db.get('teamData/tA/attendance/U'), { '2024-01-02': true });
    assert.deepStrictEqual(db.get('teamData/tA/leaves/U'), { '2024-01-03': 'wfh' });
    assert.strictEqual(db.get('teamData/unassigned'), null);
    assert.strictEqual(db.get('teamData/tA/members/U').uid, 'u1');
});

test('postSignIn: a team-less Manager cannot pick a team and waits for assignment', async () => {
    const db = makeDb({ teamNames: TEAMS });
    const profile = { name: 'M', memberKey: 'M', isManager: true, isAdmin: false, terminated: false };
    const r = await F.postSignIn({ db, uid: 'm1', profile, pickedTeam: 'tA', teamNames: TEAMS, now: 1 });
    assert.ok(r.waitingForTeam);
    assert.ok(!db.state.writes.some(w => w.path === 'usersV2/m1/teamId'));
    assert.ok(db.get('teamData/unassigned/members/M'), 'roster self-heal in unassigned');
});

test('postSignIn 6b: interrupted move (teamId set, unassigned copies left) is repaired without loss', async () => {
    const db = makeDb({
        teamData: {
            unassigned: { members: { U: { name: 'U', order: 3 } }, attendance: { U: { '2024-01-02': true } } },
            tA: { attendance: { U: { '2024-01-05': true } } }
        }
    });
    const profile = { name: 'U', memberKey: 'U', teamId: 'tA', isAdmin: false, isManager: false, terminated: false };
    const r = await F.postSignIn({ db, uid: 'u1', profile, pickedTeam: '', teamNames: TEAMS, now: 1 });
    assert.ok(r.ok);
    assert.deepStrictEqual(db.get('teamData/tA/attendance/U'), { '2024-01-02': true, '2024-01-05': true });
    assert.strictEqual(db.get('teamData/unassigned'), null);
    assert.strictEqual(db.get('teamData/tA/members/U').uid, 'u1');
});

test('postSignIn 6b: roster self-heal sets uid on an Admin pre-added entry', async () => {
    const db = makeDb({ teamData: { tA: { members: { E: { name: 'E', order: 1, addedBy: 'AdminA' } } } } });
    const profile = { name: 'E', memberKey: 'E', teamId: 'tA', isAdmin: false, isManager: false, terminated: false };
    const r = await F.postSignIn({ db, uid: 'u1', profile, teamNames: TEAMS });
    assert.ok(r.ok);
    assert.deepStrictEqual(db.get('teamData/tA/members/E'), { name: 'E', order: 1, addedBy: 'AdminA', uid: 'u1' });
});

test('postSignIn failure reports the friendly message and keeps the user signed in', async () => {
    const db = makeDb({}, op => op === 'write');
    const profile = { name: 'E', memberKey: 'E', teamId: 'tA', isAdmin: false, isManager: false, terminated: false };
    const r = await F.postSignIn({ db, uid: 'u1', profile, teamNames: TEAMS });
    assert.ok(!r.ok);
    assert.strictEqual(r.message, 'Could not finish setting up your team. Try again.');
});

test('forced reset: updatePassword then removes mustResetPassword; reauth on requires-recent-login', async () => {
    const auth = makeAuth({ 'e@attendance.local': { password: 'temp-pass-123456', uid: 'u1' } }, { requireRecentLoginOnce: true });
    await auth.signInWithEmailAndPassword('e@attendance.local', 'temp-pass-123456');
    const db = makeDb({ usersV2: { u1: { mustResetPassword: true, name: 'E' } } });
    const r = await F.completeForcedReset({ auth, db, uid: 'u1', newPassword: 'newpass1', reauthPassword: 'temp-pass-123456', makeCredential: cred });
    assert.ok(r.ok);
    assert.deepStrictEqual(auth.state.calls.slice(-3), ['updatePassword', 'reauth', 'updatePassword']);
    assert.strictEqual(db.get('usersV2/u1/mustResetPassword'), null);
});

test('change own password reauthenticates first; wrong current password is refused', async () => {
    const auth = makeAuth({ 'e@attendance.local': { password: 'oldpass1', uid: 'u1' } });
    await auth.signInWithEmailAndPassword('e@attendance.local', 'oldpass1');
    let r = await F.changeOwnPassword({ auth, currentPassword: 'wrong', newPassword: 'newpass1', makeCredential: cred });
    assert.strictEqual(r.message, 'Current password is incorrect.');
    r = await F.changeOwnPassword({ auth, currentPassword: 'oldpass1', newPassword: 'newpass1', makeCredential: cred });
    assert.ok(r.ok);
    assert.strictEqual(auth.state.accounts['e@attendance.local'].password, 'newpass1');
});

test('request password reset writes requestedBy = caller', async () => {
    const db = makeDb({});
    await F.requestPasswordReset(db, 'target', 'me', 'T');
    assert.deepStrictEqual(db.get('passwordResetRequests/target'), { requestedBy: 'me', requestedAt: 'T' });
});

test('no password ever appears in logged output', () => {
    const joined = logged.join('\n');
    for (const secret of ['secret1', 'temp-pass-123456', 'newpass1', 'oldpass1']) {
        assert.ok(!joined.includes(secret), 'leaked ' + secret);
    }
});
