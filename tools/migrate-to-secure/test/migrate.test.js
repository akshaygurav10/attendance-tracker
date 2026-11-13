'use strict';
// Unit tests for migrate-to-secure with a mocked Admin SDK. No network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/guard');
const T = require('../lib/transform');
const W = require('../lib/writeplan');
const S = require('../lib/secrets');
const { hexToHashBuffer } = require('../lib/hashes');
const C = require('../lib/commands');
const { parseArgs, HELP } = require('../migrate');
const { fakeDb, fakeAuth, legacyFixture, tmpDir, makeCtx, HASH_A, HASH_B, HASH_C } = require('./fakes');

const SUPER = 'Akshay Gurav';
const RUN = { yes: true, 'rotate-all': true, prefer: 'arrays' };
const LEGACY = ['appData', 'teamMembers', 'admins', 'managers', 'memberTeams', 'users', 'teams', 'settings'];

function setup(extra) {
    const db = fakeDb(Object.assign(legacyFixture(), extra || {}));
    const auth = fakeAuth();
    const dir = tmpDir();
    const ctx = makeCtx(db, auth, dir);
    return { db, auth, dir, ctx };
}
const allOutput = [];
function remember(ctx) { allOutput.push(...ctx.lines); }
const legacySnapshot = db => JSON.stringify(LEGACY.map(n => db.get(n)));

// ---------- guard ----------
test('write guard rejects legacy nodes, teams, settings and anything outside the new prefixes', () => {
    for (const p of ['appData', 'appData/x', 'users/a', 'teamMembers', 'admins/0', 'managers', 'memberTeams/a', 'teams/t1', 'teams/t1/name', 'settings/everyoneSeesAll', '', '/', 'usersV2', 'teamData', 'teamData/../users', 'connectionTest']) {
        assert.ok(!G.isAllowed(p), p);
        assert.throws(() => G.assertAllowed(p), /Write guard/, p);
    }
    for (const p of ['usersV2/u1/name', 'memberOwners/K', 'teamNames/t1', 'teamData/tA/attendance/K/2026-01-01', 'holidays/2026-01-01', 'migration/cutoverAt']) assert.ok(G.isAllowed(p), p);
});

test('guarded update refuses the whole batch when one path is outside the guard', async () => {
    const db = fakeDb({});
    await assert.rejects(G.guardedDb(db).update({ 'teamData/tA/members/K/name': 'K', 'teams/tA/name': 'x' }), /Write guard/);
    assert.strictEqual(db.state.writes.length, 0);
});

// ---------- hashes / secrets ----------
test('hex to 32-byte Buffer; malformed hashes rejected', () => {
    assert.strictEqual(hexToHashBuffer(HASH_A).length, 32);
    for (const bad of ['', 'abc', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(66), null, 123]) assert.strictEqual(hexToHashBuffer(bad), null);
});

test('temporary passwords are at least 16 characters and random', () => {
    const a = S.tempPassword(16);
    const b = S.tempPassword(16);
    assert.ok(a.length >= 16 && b.length >= 16);
    assert.notStrictEqual(a, b);
    assert.ok(S.tempPassword(4).length >= 16);
});

test('encrypted CSV round trips; wrong passphrase fails', () => {
    const blob = S.encrypt('username,temporaryPassword\nx,y\n', 'pw');
    assert.ok(!blob.includes('temporaryPassword'));
    assert.strictEqual(S.decrypt(blob, 'pw'), 'username,temporaryPassword\nx,y\n');
    assert.throws(() => S.decrypt(blob, 'nope'));
});

test('fingerprints are HMACs, never the raw hash', () => {
    const fp = S.fingerprint('secret', HASH_A);
    assert.notStrictEqual(fp, HASH_A);
    assert.strictEqual(fp, S.fingerprint('secret', HASH_A));
    assert.notStrictEqual(fp, S.fingerprint('other', HASH_A));
});

// ---------- transform ----------
test('reconciliation: arrays and memberTeams decide roles; disagreements are reported', () => {
    const st = T.transform(legacyFixture(), { superuser: SUPER, now: 'N' });
    const gone = st.users.find(u => u.key === 'Gone Person');
    assert.strictEqual(gone.profile.isAdmin, false, 'terminated user removed from admins migrates as non-admin');
    assert.ok(st.report.conflicts.some(c => c.key === 'Gone Person' && c.field === 'isAdmin' && c.used === false));
    assert.strictEqual(st.users.find(u => u.key === 'Mgr One').profile.isManager, true);
    assert.strictEqual(st.users.find(u => u.key === SUPER).profile.isSuperAdmin, true);
    assert.strictEqual(st.users.filter(u => u.profile.isSuperAdmin).length, 1);
});

test('roster groups: every member, terminated user and data key gets an entry; unmatched = 0', () => {
    const st = T.transform(legacyFixture(), { superuser: SUPER, now: 'N' });
    assert.strictEqual(st.roster.tA['Gone Person'].terminated, true, 'group 2 terminated user under their team');
    assert.ok(st.roster.unassigned['Old Name'], 'group 3 roster-less data key');
    assert.ok(st.roster.tB['Roster Only'], 'roster-only member keeps team');
    const all = new Set();
    Object.values(st.roster).forEach(r => Object.keys(r).forEach(k => all.add(k)));
    ['Emp One', 'Gone Person', 'Old Name', 'J___DOT___R___DOT___ Smith'].forEach(k => assert.ok(all.has(k), k));
    assert.ok(st.roster.tA['Gone Person'].order > st.roster.tA['Emp One'].order, 'group 2/3 order after group 1');
    assert.deepStrictEqual(st.attendance.tA['Gone Person'], { '2026-01-10': true });
    assert.deepStrictEqual(st.report.duplicateHolidays, ['2026-12-25']);
    assert.strictEqual(st.holidays['2026-12-25'].name, 'Christmas');
});

test('profile defaults fill the seven mandatory fields for sparse legacy records', () => {
    const st = T.transform(legacyFixture(), { superuser: SUPER, now: '2026-06-01T00:00:00Z' });
    st.users.forEach(u => assert.deepStrictEqual(T.profileProblems(u.profile), [], u.key));
    const emp = st.users.find(u => u.key === 'Emp One');
    assert.strictEqual(emp.profile.terminated, false);
    assert.strictEqual(emp.profile.isManager, false);
    assert.strictEqual(emp.profile.username, 'eone');
    assert.strictEqual(emp.profile.registeredAt, '2026-06-01T00:00:00Z');
});

test('usernames: empty base becomes member; collisions get deterministic suffixes', () => {
    const L = legacyFixture();
    L.users['Üß'] = { name: 'Üß', passwordHash: HASH_A };
    L.users['Emp Two'] = { name: 'Emp Two', passwordHash: HASH_A, username: 'eone' };
    const a = T.transform(L, { superuser: SUPER, now: 'N' });
    const b = T.transform(L, { superuser: SUPER, now: 'N' });
    assert.strictEqual(a.users.find(u => u.key === 'Üß').username, 'member');
    const names = a.users.map(u => u.username);
    assert.strictEqual(new Set(names).size, names.length);
    assert.ok(a.report.usernameCollisions.length >= 1);
    assert.deepStrictEqual(a.users.map(u => u.username), b.users.map(u => u.username));
});

test('data-domain violations are reported', () => {
    const L = legacyFixture();
    L.appData.attendance['Emp One']['2026-3-1'] = true;
    L.appData.attendance['Emp One']['2026-03-09'] = 'yes';
    L.appData.leaves['Emp One']['2026-03-10'] = 'sick';
    L.appData.holidays.push({ date: '2026-05-01', name: 'x'.repeat(101) });
    L.teams.bad = { id: 'other', name: 'Bad' };
    const st = T.transform(L, { superuser: SUPER, now: 'N' });
    const v = st.report.violations.join('\n');
    assert.match(v, /attendance: "Emp One" date "2026-3-1"/);
    assert.match(v, /value is not true/);
    assert.match(v, /type "sick"/);
    assert.match(v, /holidays: 2026-05-01 name/);
    assert.match(v, /teams: team "bad"/);
});

test('password policy: privileged users never get a hash, with or without rotate-all', () => {
    const optOut = T.transform(legacyFixture(), { superuser: SUPER, now: 'N', rotateAll: false, importHashes: true });
    optOut.users.filter(u => u.privileged).forEach(u => { assert.strictEqual(u.hash, null, u.key); assert.ok(!u.hashImport); assert.strictEqual(u.profile.mustResetPassword, true); });
    assert.ok(optOut.users.find(u => u.key === 'Emp One').hashImport, 'non-privileged with usable hash imports when opted out');
    assert.ok(!optOut.users.find(u => u.key === 'J___DOT___R___DOT___ Smith').hashImport, 'malformed hash falls back to rotation');
    assert.strictEqual(optOut.report.countsLine, '2 users hash-imported, 4 users rotated (Superuser 1, Admins 1, Managers 1, others 1)');
    const rot = T.transform(legacyFixture(), { superuser: SUPER, now: 'N' });
    assert.ok(rot.users.every(u => !u.hashImport && u.hash === null));
    assert.strictEqual(rot.report.countsLine, '0 users hash-imported, 6 users rotated (Superuser 1, Admins 1, Managers 1, others 3)');
});

// ---------- writeplan ----------
test('add-only: a different existing value is a conflict and is not overwritten', () => {
    const r = W.addOnly({ 'a/x': 1, 'a/y': 2, 'a/z': 3 }, { 'a/x': 1, 'a/y': 9 });
    assert.deepStrictEqual(r.writes, { 'a/z': 3 });
    assert.deepStrictEqual(r.conflicts, ['a/y']);
    assert.strictEqual(r.equal, 1);
});

test('normalizeUpdates drops covered deletions and refuses writes under a deletion', () => {
    assert.deepStrictEqual(W.normalizeUpdates({ 'a/b': null, 'a/b/c': null, 'a/d': 1 }), { 'a/b': null, 'a/d': 1 });
    assert.throws(() => W.normalizeUpdates({ 'a/b': null, 'a/b/c': 1 }), /Write plan error/);
});

// ---------- run / plan / verify ----------
test('plan and run --dry-run write nothing anywhere', async () => {
    const { db, auth, ctx } = setup();
    assert.strictEqual(await C.plan(ctx, {}), 0);
    assert.strictEqual(await C.run(ctx, { 'dry-run': true, prefer: 'arrays' }), 0);
    assert.strictEqual(db.state.writes.length, 0);
    assert.strictEqual(auth.state.created.length, 0);
    assert.ok(ctx.lines.some(l => l.includes('users rotated')));
    assert.ok(!fs.readdirSync(ctx.cwd).some(f => f.startsWith('migration-')), 'no files on dry run');
    remember(ctx);
});

test('run preconditions: --yes, a password policy flag, hash gate, gitignore, superuser name', async () => {
    const { ctx } = setup();
    await assert.rejects(C.run(ctx, { 'rotate-all': true }), /--yes/);
    await assert.rejects(C.run(ctx, { yes: true }), /one of --rotate-all/);
    await assert.rejects(C.run(ctx, { yes: true, 'no-rotate-all': true }), /requires --hash-test-passed/);
    await assert.rejects(C.run(ctx, { yes: true, 'rotate-all': true, refresh: true, resume: true }), /confirm-no-secure-usage/);
    await assert.rejects(C.run(ctx, Object.assign({ superuser: 'Someone Else' }, RUN)), /does not match the legacy Superuser record/);
    const bad = makeCtx(fakeDb(legacyFixture()), fakeAuth(), tmpDir('partial'));
    await assert.rejects(C.run(bad, RUN), /\.gitignore must contain/);
});

test('run aborts on role disagreements unless --prefer arrays, and on domain violations unless --allow-invalid', async () => {
    const { ctx, db } = setup();
    await assert.rejects(C.run(ctx, { yes: true, 'rotate-all': true }), /--prefer arrays/);
    const L = legacyFixture();
    L.appData.leaves['Emp One']['2026-03-10'] = 'sick';
    const c2 = makeCtx(fakeDb(L), fakeAuth(), tmpDir());
    await assert.rejects(C.run(c2, RUN), /Data-domain violations/);
    assert.strictEqual(db.state.writes.length, 0);
});

test('run (rotate-all): accounts created, profiles/roster/data written, legacy untouched, CSVs in out-dir, verify passes', async () => {
    const { db, auth, ctx, dir } = setup();
    const before = legacySnapshot(db);
    const out = path.join(dir, 'secret-out');
    assert.strictEqual(await C.run(ctx, Object.assign({ 'out-dir': out }, RUN)), 0);
    assert.strictEqual(legacySnapshot(db), before, 'legacy nodes, teams and settings unchanged');
    db.state.writes.forEach(w => assert.ok(G.isAllowed(w[1]), 'write outside guard: ' + w[1]));
    assert.strictEqual(auth.state.created.length, 6);
    assert.strictEqual(auth.state.imported.length, 0, 'rotate-all imports no hash');
    auth.state.created.forEach(c => { assert.ok(c.password.length >= 16); assert.ok(!c.disabled, 'terminated users imported enabled'); });
    const profiles = db.get('usersV2');
    assert.strictEqual(Object.values(profiles).filter(p => p.isSuperAdmin).length, 1);
    Object.values(profiles).forEach(p => { assert.ok(!('passwordHash' in p)); assert.strictEqual(p.mustResetPassword, true); });
    assert.strictEqual(Object.values(profiles).find(p => p.name === 'Gone Person').terminated, true);
    assert.deepStrictEqual(db.get('teamNames'), { tA: 'Team A', tB: 'Team B' });
    const files = fs.readdirSync(out);
    assert.ok(files.some(f => /^migration-temp-passwords-.*\.csv$/.test(f)));
    assert.ok(files.some(f => /^migration-usernames-.*\.csv$/.test(f)));
    const st = JSON.parse(fs.readFileSync(path.join(out, 'migration-state.json'), 'utf8'));
    const raw = JSON.stringify(st);
    [HASH_A, HASH_B, HASH_C].forEach(h => assert.ok(!raw.includes(h), 'raw hash in migration-state.json'));
    const v = makeCtx(db, auth, dir);
    assert.strictEqual(await C.verify(v, {}), 0, v.lines.filter(l => l.startsWith('FAIL')).join('\n'));
    assert.ok(v.lines.some(l => l.includes('Roster entries unmatched: 0')));
    remember(ctx); remember(v);
});

test('--encrypt-csv writes an encrypted file that show-passwords can read', async () => {
    const { ctx, dir } = setup();
    await C.run(ctx, Object.assign({ 'encrypt-csv': true }, RUN));
    const f = fs.readdirSync(dir).find(x => x.endsWith('.csv.enc'));
    assert.ok(f);
    const show = makeCtx(null, null, dir);
    await C.showPasswords(show, {}, path.join(dir, f));
    assert.ok(show.lines[0].startsWith('username,temporaryPassword'));
    assert.ok(!fs.readdirSync(dir).some(x => /^migration-temp-passwords-.*\.csv$/.test(x)), 'no plaintext CSV with --encrypt-csv');
});

test('opt-out of rotation: only non-privileged users with valid hashes are imported (SHA256, rounds 1)', async () => {
    const { auth, ctx } = setup();
    await C.run(ctx, { yes: true, 'no-rotate-all': true, 'hash-test-passed': true, prefer: 'arrays' });
    assert.strictEqual(auth.state.imported.length, 1);
    const { records, opts } = auth.state.imported[0];
    assert.deepStrictEqual(opts, { hash: { algorithm: 'SHA256', rounds: 1 } });
    const emails = records.map(r => r.email).sort();
    assert.deepStrictEqual(emails, ['eone@attendance.local', 'gperson@attendance.local']);
    records.forEach(r => assert.ok(Buffer.isBuffer(r.passwordHash) && r.passwordHash.length === 32));
    const createdEmails = auth.state.created.map(c => c.email);
    ['agurav@attendance.local', 'aone@attendance.local', 'mone@attendance.local'].forEach(e => assert.ok(createdEmails.includes(e), 'privileged rotated: ' + e));
    remember(ctx);
});

test('resume is add-only: newer different values are kept and reported; rerun creates no duplicate accounts', async () => {
    const { db, auth, ctx } = setup();
    await C.run(ctx, RUN);
    const uid = Object.keys(db.get('usersV2')).find(u => db.get('usersV2/' + u).name === 'Emp One');
    await db.ref('teamData/tA/members/Emp One/order').set(999);
    const c2 = makeCtx(db, auth, ctx.cwd);
    await C.run(c2, Object.assign({ resume: true }, RUN));
    assert.strictEqual(db.get('teamData/tA/members/Emp One/order'), 999);
    assert.ok(c2.lines.some(l => l.includes('conflict (existing different value kept): teamData/tA/members/Emp One/order')));
    assert.strictEqual(auth.state.created.length, 6);
    assert.ok(uid);
});

test('mark-cutover blocks run and mirror; clear-cutover needs --yes and re-enables run', async () => {
    const { db, ctx } = setup();
    await C.run(ctx, RUN);
    await C.markCutover(ctx);
    assert.ok(db.get('migration/cutoverAt'));
    await assert.rejects(C.run(ctx, Object.assign({ resume: true }, RUN)), /cutoverAt exists/);
    await assert.rejects(C.run(ctx, Object.assign({ resume: true, mirror: true, 'confirm-no-secure-usage': true }, RUN)), /refused/);
    await assert.rejects(C.run(ctx, Object.assign({ resume: true, refresh: true, 'confirm-no-secure-usage': true }, RUN)), /refused/);
    await assert.rejects(C.clearCutover(ctx, {}), /--yes/);
    await C.clearCutover(ctx, { yes: true });
    assert.strictEqual(db.get('migration/cutoverAt'), null);
    assert.strictEqual(await C.run(ctx, Object.assign({ resume: true }, RUN)), 0);
});

test('verify detects a seeded difference and lists new-only entries after cutover as informational', async () => {
    const { db, auth, ctx } = setup();
    await C.run(ctx, RUN);
    await db.ref('teamData/tA/attendance/Emp One/2026-03-02').remove();
    const v = makeCtx(db, auth, ctx.cwd);
    assert.strictEqual(await C.verify(v, {}), 1);
    assert.ok(v.lines.some(l => l.includes('FAIL attendance checksum differs')));
    await db.ref('teamData/tA/attendance/Emp One/2026-03-02').set(true);
    await C.markCutover(ctx);
    await db.ref('teamData/tA/attendance/Emp One/2026-07-01').set(true);
    const v2 = makeCtx(db, auth, ctx.cwd);
    assert.strictEqual(await C.verify(v2, {}), 0, v2.lines.filter(l => l.startsWith('FAIL')).join('\n'));
    assert.ok(v2.lines.some(l => l.includes('new-only attendance entries (informational): 1')));
});

test('verify fails when there is not exactly one Superuser', async () => {
    const { db, auth, ctx } = setup();
    await C.run(ctx, RUN);
    const other = Object.keys(db.get('usersV2')).find(u => db.get('usersV2/' + u).name === 'Emp One');
    await db.ref('usersV2/' + other + '/isSuperAdmin').set(true);
    const v = makeCtx(db, auth, ctx.cwd);
    assert.strictEqual(await C.verify(v, {}), 1);
    assert.ok(v.lines.some(l => l.includes('exactly one Superuser')));
});

test('refresh carries legacy changes made after the first run (terminate, promote, team move, team rename/delete)', async () => {
    const { db, auth, ctx } = setup();
    await C.run(ctx, RUN);
    // legacy edits after R6 (fixture data, i.e. the legacy app)
    const users = db.state.tree.users;
    users['Emp One'].terminated = true;
    db.state.tree.teamMembers = db.state.tree.teamMembers.filter(n => n !== 'Emp One');
    db.state.tree.managers.push('Roster Only');
    db.state.tree.memberTeams['J___DOT___R___DOT___ Smith'] = 'tA';
    db.state.tree.teams.tA.name = 'Team A renamed';
    delete db.state.tree.teams.tB;
    db.state.tree.memberTeams['Roster Only'] = 'tA';
    const c2 = makeCtx(db, auth, ctx.cwd);
    assert.strictEqual(await C.run(c2, Object.assign({ resume: true, refresh: true, mirror: true, 'confirm-no-secure-usage': true }, RUN)), 0);
    const byName = n => Object.values(db.get('usersV2')).find(p => p.name === n);
    assert.strictEqual(byName('Emp One').terminated, true);
    assert.strictEqual(db.get('teamData/tA/members/Emp One/terminated'), true);
    assert.strictEqual(byName('J.R. Smith').teamId, 'tA');
    assert.deepStrictEqual(db.get('teamData/tA/leaves/J___DOT___R___DOT___ Smith'), { '2026-03-05': 'planned' });
    assert.strictEqual(db.get('teamData/tB'), null, 'old bucket emptied');
    assert.deepStrictEqual(db.get('teamNames'), { tA: 'Team A renamed' });
    const v = makeCtx(db, auth, ctx.cwd);
    assert.strictEqual(await C.verify(v, {}), 0, v.lines.filter(l => l.startsWith('FAIL')).join('\n'));
    assert.ok(c2.lines.every(l => !/[0-9a-f]{64}/.test(l)));
    remember(c2);
});

test('refresh: a hash-imported user promoted to Manager is rotated, never re-imported', async () => {
    const { db, auth, ctx } = setup();
    await C.run(ctx, { yes: true, 'no-rotate-all': true, 'hash-test-passed': true, prefer: 'arrays' });
    db.state.tree.managers.push('Emp One');
    const c2 = makeCtx(db, auth, ctx.cwd);
    await C.run(c2, { yes: true, 'no-rotate-all': true, 'hash-test-passed': true, prefer: 'arrays', resume: true, refresh: true, 'confirm-no-secure-usage': true });
    assert.strictEqual(auth.state.imported.length, 1, 'no second import');
    const uid = Object.keys(db.get('usersV2')).find(u => db.get('usersV2/' + u).name === 'Emp One');
    assert.ok(auth.state.updated.some(x => x.uid === uid && x.props.password.length >= 16));
    assert.strictEqual(db.get('usersV2/' + uid + '/isManager'), true);
    assert.strictEqual(db.get('usersV2/' + uid + '/mustResetPassword'), true);
    assert.ok(c2.lines.some(l => l.includes('eone (rotated)')));
});

test('refresh: a hash-imported user who changed their legacy password is re-imported', async () => {
    const { db, auth, ctx } = setup();
    await C.run(ctx, { yes: true, 'no-rotate-all': true, 'hash-test-passed': true, prefer: 'arrays' });
    db.state.tree.users['Emp One'].passwordHash = 'd'.repeat(64);
    const c2 = makeCtx(db, auth, ctx.cwd);
    await C.run(c2, { yes: true, 'no-rotate-all': true, 'hash-test-passed': true, prefer: 'arrays', resume: true, refresh: true, 'confirm-no-secure-usage': true });
    assert.strictEqual(auth.state.imported.length, 2);
    assert.ok(c2.lines.some(l => l.includes('eone (password re-imported)')));
    assert.ok(c2.lines.every(l => !l.includes('d'.repeat(64))));
});

test('mirror with unchanged legacy data deletes nothing; after a legacy toggle-off it deletes exactly that leaf', async () => {
    const { db, auth, ctx } = setup();
    await C.run(ctx, RUN);
    const snap = JSON.stringify(db.get('teamData')) + JSON.stringify(db.get('holidays'));
    const c2 = makeCtx(db, auth, ctx.cwd);
    await C.run(c2, Object.assign({ resume: true, mirror: true, 'confirm-no-secure-usage': true }, RUN));
    assert.strictEqual(JSON.stringify(db.get('teamData')) + JSON.stringify(db.get('holidays')), snap, 'roster uid and group 2/3 entries survive');
    delete db.state.tree.appData.attendance['Emp One']['2026-03-03'];
    const before = db.state.writes.length;
    const c3 = makeCtx(db, auth, ctx.cwd);
    await C.run(c3, Object.assign({ resume: true, mirror: true, 'confirm-no-secure-usage': true }, RUN));
    const newWrites = db.state.writes.slice(before);
    assert.deepStrictEqual(newWrites.map(w => w[1]), ['teamData/tA/attendance/Emp One/2026-03-03']);
    assert.strictEqual(newWrites[0][2], null);
});

test('--only creates a single account and writes no team data', async () => {
    const { db, auth, ctx } = setup();
    await C.run(ctx, Object.assign({ only: 'eone' }, RUN));
    assert.strictEqual(auth.state.created.length, 1);
    assert.strictEqual(db.get('teamData'), null);
});

// ---------- recovery commands ----------
test('reset-password --pending prints to terminal only, sets mustResetPassword and deletes the request', async () => {
    const { db, auth, ctx, dir } = setup();
    await C.run(ctx, RUN);
    const uid = Object.keys(db.get('usersV2')).find(u => db.get('usersV2/' + u).name === 'Emp One');
    await db.ref('usersV2/' + uid + '/mustResetPassword').remove();
    await db.ref('passwordResetRequests/' + uid).set({ requestedBy: 'x', requestedAt: 'T' });
    const filesBefore = fs.readdirSync(dir).length;
    const r = makeCtx(db, auth, dir);
    await C.resetPassword(r, { pending: true });
    assert.ok(r.lines.some(l => /^username eone {2}temporary password \S{16,}$/.test(l)));
    assert.strictEqual(db.get('usersV2/' + uid + '/mustResetPassword'), true);
    assert.strictEqual(db.get('passwordResetRequests'), null);
    assert.strictEqual(fs.readdirSync(dir).length, filesBefore, 'no file written');
});

test('delete-auth-user refuses when a profile exists; clear-claim refuses for a real claim', async () => {
    const { db, auth, ctx } = setup();
    await C.run(ctx, RUN);
    await assert.rejects(C.deleteAuthUser(ctx, { username: 'eone' }), /has a profile/);
    await assert.rejects(C.clearClaim(ctx, { key: 'Emp One' }), /has a profile/);
    const orphan = await auth.createUser({ email: 'ghost@attendance.local', password: 'x'.repeat(16) });
    await db.ref('memberOwners/Ghost').set(orphan.uid);
    await C.clearClaim(ctx, { key: 'Ghost' });
    assert.strictEqual(db.get('memberOwners/Ghost'), null);
    await C.deleteAuthUser(ctx, { username: 'ghost' });
    assert.ok(auth.state.deleted.includes(orphan.uid));
});

test('set-superuser requires the resolved Superuser name and leaves exactly one Superuser', async () => {
    const { db, auth, ctx } = setup();
    await C.run(ctx, RUN);
    await assert.rejects(C.setSuperuser(ctx, { username: 'eone' }), /is not the Superuser/);
    await C.setSuperuser(ctx, { username: 'agurav' });
    assert.strictEqual(Object.values(db.get('usersV2')).filter(p => p.isSuperAdmin).length, 1);
    assert.ok(auth);
});

test('set-superuser works with the name given by --superuser when no legacy record is flagged', async () => {
    const L = legacyFixture();
    delete L.users[SUPER].isSuperAdmin;
    const db = fakeDb(L);
    const ctx = makeCtx(db, fakeAuth(), tmpDir());
    await C.run(ctx, Object.assign({ superuser: SUPER }, RUN));
    await assert.rejects(C.setSuperuser(ctx, { username: 'agurav' }), /No legacy users/);
    await C.setSuperuser(ctx, { username: 'agurav', superuser: SUPER });
    assert.strictEqual(Object.values(db.get('usersV2')).filter(p => p.isSuperAdmin).length, 1);
});

test('resolveSuperName: flag only, record only, match, mismatch, none, several', () => {
    const rec = (n, s) => ({ name: n, isSuperAdmin: s });
    const one = { A: rec('A', true), B: rec('B', false) };
    assert.strictEqual(C.resolveSuperName({ superuser: 'X' }, { B: rec('B', false) }), 'X', 'flag only');
    assert.strictEqual(C.resolveSuperName({}, one), 'A', 'record only');
    assert.strictEqual(C.resolveSuperName({ superuser: 'A' }, one), 'A', 'match');
    assert.throws(() => C.resolveSuperName({ superuser: 'B' }, one), /does not match/, 'mismatch');
    assert.throws(() => C.resolveSuperName({}, { B: rec('B', false) }), /--superuser/, 'none');
    assert.throws(() => C.resolveSuperName({}, null), /No legacy users/, 'none, no users node');
    assert.throws(() => C.resolveSuperName({}, { A: rec('A', true), C: rec('C', true) }), /Several/, 'several, no flag');
    assert.strictEqual(C.resolveSuperName({ superuser: 'C' }, { A: rec('A', true), C: rec('C', true) }), 'C', 'several, flag picks');
});

test('no code path reads app.js: ctx carries no appJsPath and the tool never mentions it', () => {
    const { ctx } = setup();
    assert.ok(!('appJsPath' in ctx));
    for (const f of ['lib/commands.js', 'migrate.js']) {
        const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        assert.ok(!/appJsPath|app\.js|SUPER_ADMIN/.test(src), f);
    }
});

test('export-new writes teamData and holidays only', async () => {
    const { ctx, dir } = setup();
    await C.run(ctx, RUN);
    await C.exportNew(ctx, { 'to-json': 'export.json' });
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'export.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(data).sort(), ['holidays', 'teamData']);
});

test('CLI: argument parsing and help lists every runbook command', () => {
    const a = parseArgs(['run', '--yes', '--rotate-all', '--prefer', 'arrays', '--out-dir', 'x']);
    assert.strictEqual(a.cmd, 'run');
    assert.strictEqual(a.flags.prefer, 'arrays');
    assert.strictEqual(a.flags['out-dir'], 'x');
    for (const c of ['plan', 'run', 'verify', 'mark-cutover', 'clear-cutover', 'reset-password', 'set-superuser', 'clear-claim', 'delete-auth-user', 'export-new', 'show-passwords', '--resume', '--refresh', '--mirror', '--confirm-no-secure-usage', '--hash-test-passed', '--no-hash-import', '--encrypt-csv']) {
        assert.ok(HELP.includes(c), c);
    }
});

test('no password hash appears in any captured output', () => {
    const joined = allOutput.join('\n');
    assert.ok(allOutput.length > 20);
    [HASH_A, HASH_B, HASH_C].forEach(h => assert.ok(!joined.includes(h)));
    assert.ok(!/\b[0-9a-f]{64}\b/.test(joined));
});
