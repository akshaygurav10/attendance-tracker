'use strict';
// migrate-to-secure commands (design 9). All Firebase access goes through the
// injected ctx.db (Admin SDK Realtime Database) and ctx.auth (Admin SDK Auth),
// so the commands run against mocks in the unit tests. Every database write goes
// through the write guard. Password hashes are never printed or written to files.

const fs = require('fs');
const path = require('path');
const T = require('./transform');
const W = require('./writeplan');
const G = require('./guard');
const S = require('./secrets');
const { hexToHashBuffer } = require('./hashes');
const { summarize } = require('./checksum');

const LEGACY_NODES = ['appData', 'teamMembers', 'admins', 'managers', 'memberTeams', 'users', 'teams', 'settings'];
const NEW_NODES = ['usersV2', 'memberOwners', 'teamNames', 'teamData', 'holidays', 'migration'];
const EMAIL_DOMAIN = '@attendance.local';

function redact(s) { return String(s).replace(/\b[0-9a-fA-F]{64}\b/g, '[redacted]'); }
function logger(ctx) { return (...a) => ctx.out(redact(a.join(' '))); }

// Superuser name: --superuser "<name>" and/or the single legacy users/* record
// with isSuperAdmin === true. Nothing is read from the client code.
function resolveSuperName(flags, legacyUsers) {
    const flagName = typeof flags.superuser === 'string' && flags.superuser ? flags.superuser : null;
    const recs = Object.keys(legacyUsers || {})
        .filter(k => legacyUsers[k] && legacyUsers[k].isSuperAdmin === true)
        .map(k => legacyUsers[k].name || k);
    if (flagName) {
        if (recs.length === 1 && recs[0] !== flagName) {
            throw new Error('--superuser "' + flagName + '" does not match the legacy Superuser record "' + recs[0] + '"');
        }
        return flagName;
    }
    if (recs.length === 1) return recs[0];
    if (recs.length === 0) throw new Error('No legacy users/* record has isSuperAdmin === true. Pass --superuser "<name>" with the Superuser\'s exact name.');
    throw new Error('Several legacy users/* records have isSuperAdmin === true (' + recs.join(', ') + '). Pass --superuser "<name>" to choose the Superuser.');
}

async function readNodes(db, names) {
    const out = {};
    for (const n of names) out[n] = (await db.ref(n).once('value')).val();
    return out;
}

async function listAuthUsers(auth) {
    const users = [];
    let token;
    do {
        const page = await auth.listUsers(1000, token);
        page.users.forEach(u => users.push({ uid: u.uid, email: u.email || '' }));
        token = page.pageToken;
    } while (token);
    return users;
}

function uidMapFromProfiles(usersV2) {
    const m = {};
    Object.keys(usersV2 || {}).forEach(uid => { const p = usersV2[uid]; if (p && p.memberKey) m[p.memberKey] = uid; });
    return m;
}

function bucketOfKey(state, key) {
    return Object.keys(state.roster).find(t => state.roster[t][key]) || T.UNASSIGNED;
}

// ---- shared preparation ----
async function prepare(ctx, flags) {
    const log = logger(ctx);
    const legacy = await readNodes(ctx.db, LEGACY_NODES);
    const superName = resolveSuperName(flags, legacy.users);
    const current = await readNodes(ctx.db, NEW_NODES);
    const authUsers = await listAuthUsers(ctx.auth);
    const byUidProfile = current.usersV2 || {};
    const existingUsernames = {};
    authUsers.forEach(u => {
        if (!u.email.endsWith(EMAIL_DOMAIN)) return;
        const local = u.email.slice(0, -EMAIL_DOMAIN.length);
        const p = byUidProfile[u.uid];
        existingUsernames[local] = p && p.memberKey ? p.memberKey : '__other__:' + u.uid;
    });
    const rotateAll = !flags['no-rotate-all'];
    const importHashes = !!flags['no-rotate-all'] && !!flags['hash-test-passed'] && !flags['no-hash-import'];
    const state = T.transform(legacy, { superuser: superName, now: ctx.now(), rotateAll, importHashes, existingUsernames });
    return { log, superName, legacy, current, authUsers, state, rotateAll, importHashes };
}

function printReport(log, state, extra) {
    const r = state.report;
    log('Teams: ' + Object.keys(state.teamNames).length);
    Object.keys(state.roster).sort().forEach(t => log('  ' + t + ': ' + Object.keys(state.roster[t]).length + ' roster entries'));
    log('Users (accounts): ' + state.users.length);
    log(r.countsLine);
    log('Legacy hashes usable for import: ' + r.hashEligible + ', not usable: ' + r.hashIneligible);
    log('Members without a team: ' + r.membersWithoutTeam.length);
    log('Attendance/leave keys not on the roster (given entries): ' + r.unrosteredDataKeys.length);
    log('Terminated users: ' + r.terminatedUsers.length);
    log('Duplicate holiday dates: ' + (r.duplicateHolidays.join(', ') || 'none'));
    log('Username collisions: ' + (r.usernameCollisions.map(c => c.key + ' -> ' + c.username).join(', ') || 'none'));
    log('Usernames:');
    state.users.forEach(u => log('  ' + u.name + ' -> ' + u.username));
    log('Role/team disagreements between users/* and the arrays: ' + r.conflicts.length);
    r.conflicts.forEach(c => log('  ' + c.key + ' ' + c.field + ': users=' + c.usersValue + ' arrays=' + c.arraysValue + ' -> would use ' + c.used));
    const tic = Array.from(new Set(r.teamIdConflicts.map(c => c.key + '=' + c.teamId)));
    log('teamId values that are not a team: ' + (tic.join(', ') || 'none'));
    log('Data-domain violations the rules would reject: ' + r.violations.length);
    r.violations.forEach(v => log('  ' + v));
    if (extra) extra.forEach(l => log(l));
}

// ---- plan ----
async function plan(ctx, flags) {
    const p = await prepare(ctx, flags);
    p.log('PLAN (read-only, nothing is written)');
    printReport(p.log, p.state);
    return 0;
}

function writeOutFile(ctx, dir, name, content) {
    const d = path.resolve(dir || ctx.cwd);
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, name);
    fs.writeFileSync(f, content);
    return f;
}

function stamp(ctx) { return ctx.now().replace(/[:.]/g, '-'); }

// ---- run (also --resume, --refresh, --mirror, --dry-run) ----
async function run(ctx, flags) {
    const dry = !!flags['dry-run'];
    const log = logger(ctx);
    if (!dry && !flags.yes) throw new Error('run needs --yes (or use --dry-run)');
    if (flags['no-rotate-all'] && !flags['hash-test-passed']) throw new Error('--no-rotate-all requires --hash-test-passed (scratch-project gate, design 8)');
    const policy = ['rotate-all', 'hash-test-passed', 'no-hash-import'].filter(f => flags[f]);
    if (!dry && policy.length === 0) throw new Error('run needs one of --rotate-all (default in the runbook), --hash-test-passed or --no-hash-import');
    if ((flags.refresh || flags.mirror) && !flags['confirm-no-secure-usage']) throw new Error('--refresh and --mirror require --confirm-no-secure-usage');
    if (flags.refresh && !flags.resume) throw new Error('--refresh is used with --resume');
    const gi = S.checkGitignore(ctx.cwd);
    if (!gi.ok) throw new Error('.gitignore must contain: ' + gi.missing.join(', '));

    const cutover = (await ctx.db.ref('migration/cutoverAt').once('value')).val();
    if (cutover && (flags.mirror || flags.refresh)) throw new Error('--mirror/--refresh refused: migration/cutoverAt exists (' + cutover + ')');
    if (cutover && !flags['force-after-cutover']) throw new Error('run refused: migration/cutoverAt exists (' + cutover + '). Use --force-after-cutover only if you know why.');

    const p = await prepare(ctx, flags);
    const { state } = p;
    if (state.report.conflicts.length && flags.prefer !== 'arrays') {
        printReport(log, state);
        throw new Error('Role/team disagreements found; rerun with --prefer arrays to use the arrays and memberTeams (what the live app honors)');
    }
    if (flags.prefer === 'arrays' && state.report.conflicts.length) log('Using --prefer arrays: arrays and memberTeams win for ' + state.report.conflicts.length + ' disagreement(s).');
    if (state.report.violations.length && !flags['allow-invalid']) {
        printReport(log, state);
        throw new Error('Data-domain violations found; fix them in the legacy app first (or --allow-invalid)');
    }

    const db = G.guardedDb(ctx.db);
    const only = flags.only ? String(flags.only) : null;
    const users = only ? state.users.filter(u => u.username === only) : state.users;
    if (only && users.length === 0) throw new Error('--only: no user with username "' + only + '"');

    // ---- Auth accounts ----
    const uidByKey = uidMapFromProfiles(p.current.usersV2);
    const authByEmail = {};
    p.authUsers.forEach(u => { authByEmail[u.email] = u.uid; });
    const tempRows = [];
    const toImport = [];
    for (const u of users) {
        if (uidByKey[u.key]) continue;
        if (authByEmail[u.email]) { uidByKey[u.key] = authByEmail[u.email]; continue; }
        if (dry) { uidByKey[u.key] = 'dry-run:' + u.key; continue; }
        if (u.hashImport) {
            const uid = S.randomUid();
            toImport.push({ u, uid });
            uidByKey[u.key] = uid;
        } else {
            const pw = S.tempPassword(16);
            const rec = await ctx.auth.createUser({ email: u.email, password: pw });
            uidByKey[u.key] = rec.uid;
            tempRows.push([u.username, pw]);
        }
    }
    // Hash import in batches of 1000; stop on unexpected errors (design 8).
    for (let i = 0; i < toImport.length; i += 1000) {
        const batch = toImport.slice(i, i + 1000);
        const records = batch.map(b => ({ uid: b.uid, email: b.u.email, passwordHash: hexToHashBuffer(b.u.hash) }));
        const res = await ctx.auth.importUsers(records, { hash: { algorithm: 'SHA256', rounds: 1 } });
        if (res.errors && res.errors.length) {
            res.errors.forEach(e => log('  import failed for ' + batch[e.index].u.username + ': ' + ((e.error && e.error.code) || 'error')));
            throw new Error('Hash import reported ' + res.errors.length + ' error(s); stopped after this batch. Affected users can be reset with reset-password --username.');
        }
    }

    // ---- refresh: password fingerprints (migration-state.json) ----
    const statePath = path.join(path.resolve(flags['out-dir'] || ctx.cwd), 'migration-state.json');
    let secret = ctx.env.MIGRATION_STATE_SECRET;
    if (!dry && !secret) secret = await ctx.prompt('MIGRATION_STATE_SECRET (not stored): ');
    const prevState = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { users: {} };
    const newState = { createdAt: prevState.createdAt || ctx.now(), updatedAt: ctx.now(), users: {} };
    const changed = [];
    for (const u of users) {
        const legacyHash = ((p.legacy.users || {})[u.key] || {}).passwordHash || '';
        const fp = secret ? S.fingerprint(secret, legacyHash) : null;
        const prev = prevState.users[u.key];
        newState.users[u.key] = { fingerprint: fp, hashImported: prev ? (prev.hashImported && u.hashImport) : u.hashImport };
        if (!flags.refresh || !prev || dry) continue;
        const uid = uidByKey[u.key];
        const fpChanged = prev.fingerprint !== fp;
        if (prev.hashImported && (u.privileged || !u.hashImport)) {
            const pw = S.tempPassword(16);
            await ctx.auth.updateUser(uid, { password: pw });
            tempRows.push([u.username, pw]);
            newState.users[u.key].hashImported = false;
            changed.push(u.username + ' (rotated)');
        } else if (prev.hashImported && fpChanged) {
            const res = await ctx.auth.importUsers([{ uid, email: u.email, passwordHash: hexToHashBuffer(legacyHash) }], { hash: { algorithm: 'SHA256', rounds: 1 } });
            if (res.errors && res.errors.length) throw new Error('Re-import failed for ' + u.username);
            changed.push(u.username + ' (password re-imported)');
        }
    }

    // ---- database writes ----
    const desired = T.desiredTree(Object.assign({}, state, { users }), uidByKey);
    if (only) { desired.teamData = {}; desired.holidays = {}; desired.teamNames = {}; }
    // Rotated users keep mustResetPassword only when they are not hash-imported.
    const desiredFlat = {};
    ['usersV2', 'memberOwners', 'teamNames', 'teamData', 'holidays'].forEach(n => T.flatten(desired[n], n, desiredFlat));
    const currentFlat = {};
    ['usersV2', 'memberOwners', 'teamNames', 'teamData', 'holidays'].forEach(n => T.flatten(p.current[n], n, currentFlat));

    const plan = W.addOnly(desiredFlat, currentFlat);
    let updates = Object.assign({}, plan.writes);
    if (flags.refresh) {
        const legacyUids = users.map(u => uidByKey[u.key]).filter(Boolean);
        const bucketByKey = {};
        Object.keys(state.roster).forEach(t => Object.keys(state.roster[t]).forEach(k => { bucketByKey[k] = t; }));
        const ov = W.refreshOverrides(desiredFlat, currentFlat, legacyUids, bucketByKey);
        Object.keys(ov).forEach(k => { if (k in ov) updates[k] = ov[k]; });
        // Overridden paths are no longer conflicts.
        plan.conflicts = plan.conflicts.filter(c => !(c in ov));
    }
    if (flags.mirror) Object.assign(updates, W.mirrorDeletes(desiredFlat, currentFlat, G.MIRROR_PREFIXES));
    updates = W.normalizeUpdates(updates);

    log((dry ? 'DRY RUN: would write ' : 'Writing ') + Object.keys(updates).length + ' leaf change(s); ' + plan.equal + ' already equal; ' + plan.conflicts.length + ' conflict(s) left untouched.');
    plan.conflicts.slice(0, 200).forEach(c => log('  conflict (existing different value kept): ' + c));
    if (!dry) {
        for (const c of W.chunk(updates, 500)) await db.update(c);
    } else {
        // Guard check even on a dry run, so a bad plan fails before the real run.
        Object.keys(updates).forEach(k => G.assertAllowed(k));
    }

    printReport(log, state, [changed.length ? 'Refresh changed: ' + changed.join(', ') : 'Refresh changed: none']);

    if (!dry) {
        if (secret) {
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            fs.writeFileSync(statePath, JSON.stringify(newState, null, 2));
        }
        const ts = stamp(ctx);
        writeOutFile(ctx, flags['out-dir'], 'migration-usernames-' + ts + '.csv', S.toCsv(['name', 'username'], state.users.map(u => [u.name, u.username])));
        if (tempRows.length) {
            const csv = S.toCsv(['username', 'temporaryPassword'], tempRows);
            let file;
            if (flags['encrypt-csv']) {
                const pass = ctx.env.MIGRATION_CSV_PASSPHRASE || await ctx.prompt('Passphrase for the encrypted temporary-password file: ');
                file = writeOutFile(ctx, flags['out-dir'], 'migration-temp-passwords-' + ts + '.csv.enc', S.encrypt(csv, pass));
                log('Temporary passwords written (encrypted) to ' + file + '. Read with: node migrate.js show-passwords "' + file + '"');
            } else {
                file = writeOutFile(ctx, flags['out-dir'], 'migration-temp-passwords-' + ts + '.csv', csv);
                log('Temporary passwords written to ' + file);
            }
            log('Restrict access now. Windows: icacls "' + file + '" /inheritance:r /grant:r "%USERNAME%:F"   macOS/Linux: chmod 600 "' + file + '"');
            log('Delete the file after every temporary password has been handed over.');
        }
    }
    return 0;
}

// ---- verify (read-only) ----
async function verify(ctx, flags) {
    const p = await prepare(ctx, flags);
    const log = p.log;
    const fails = [];
    const warns = [];
    const cutover = p.current.migration && p.current.migration.cutoverAt;
    const usersV2 = p.current.usersV2 || {};
    const teamData = p.current.teamData || {};
    const uidByKey = uidMapFromProfiles(usersV2);
    const authUids = new Set(p.authUsers.map(u => u.uid));

    // user counts
    const appAuth = p.authUsers.filter(u => u.email.endsWith(EMAIL_DOMAIN)).length;
    log('Users: legacy accounts ' + p.state.users.length + ', usersV2 ' + Object.keys(usersV2).length + ', Auth ' + appAuth);
    p.state.users.forEach(u => { if (!uidByKey[u.key]) fails.push('no usersV2 profile for ' + u.key); });

    // roster coverage: every desired key exactly once, in the desired bucket
    const keyTeams = {};
    Object.keys(teamData).forEach(t => Object.keys((teamData[t] || {}).members || {}).forEach(k => { (keyTeams[k] = keyTeams[k] || []).push(t); }));
    let unmatched = 0;
    Object.keys(p.state.roster).forEach(t => Object.keys(p.state.roster[t]).forEach(k => {
        if (!keyTeams[k] || !keyTeams[k].includes(t)) { unmatched++; if (!cutover) fails.push('roster entry missing: ' + t + '/' + k); }
    }));
    log('Roster entries unmatched: ' + unmatched);
    Object.keys(keyTeams).forEach(k => {
        if (keyTeams[k].length > 1) (cutover ? warns : fails).push('memberKey in more than one team: ' + k + ' (' + keyTeams[k].join(', ') + ')');
    });
    Object.keys(teamData).forEach(t => ['attendance', 'leaves'].forEach(kind => Object.keys((teamData[t] || {})[kind] || {}).forEach(k => {
        if (!((teamData[t].members || {})[k])) fails.push(kind + ' key without a roster entry in the same bucket: ' + t + '/' + k);
    })));

    // checksums
    const curAtt = {}; const curLv = {};
    Object.keys(teamData).forEach(t => { curAtt[t] = (teamData[t] || {}).attendance || {}; curLv[t] = (teamData[t] || {}).leaves || {}; });
    const want = summarize(p.state.attendance, p.state.leaves);
    const have = summarize(curAtt, curLv);
    log('Attendance: legacy ' + want.attendanceCount + ' / new ' + have.attendanceCount + '; leaves: legacy ' + want.leaveCount + ' / new ' + have.leaveCount);
    if (!cutover) {
        if (want.attendanceSum !== have.attendanceSum) fails.push('attendance checksum differs');
        if (want.leaveSum !== have.leaveSum) fails.push('leaves checksum differs');
    } else {
        const extraA = have.attendanceCount - want.attendanceCount;
        log('After cutover: new-only attendance entries (informational): ' + Math.max(0, extraA));
    }
    const holCur = Object.keys(p.current.holidays || {}).length;
    const holWant = Object.keys(p.state.holidays).length;
    log('Holidays: legacy ' + holWant + ' / new ' + holCur);
    if (!cutover && holCur !== holWant) fails.push('holiday count differs');

    // teams shape and teamNames sync
    p.state.report.violations.filter(v => v.startsWith('teams:')).forEach(v => fails.push(v));
    const teamIds = Object.keys(p.legacy.teams || {}).sort().join(',');
    const nameIds = Object.keys(p.current.teamNames || {}).sort().join(',');
    if (teamIds !== nameIds) fails.push('teams ids and teamNames ids differ');

    // exactly one Superuser
    const supers = Object.keys(usersV2).filter(uid => usersV2[uid] && usersV2[uid].isSuperAdmin === true);
    if (supers.length !== 1) fails.push('expected exactly one Superuser profile, found ' + supers.length);
    else {
        if (!authUids.has(supers[0])) fails.push('Superuser has no Auth user');
        if (usersV2[supers[0]].name !== p.superName) fails.push('Superuser profile name differs from the expected Superuser name');
    }

    // profile checks, terminated agreement, roles
    Object.keys(usersV2).forEach(uid => {
        const prof = usersV2[uid];
        const probs = T.profileProblems(prof);
        if (probs.length) fails.push('profile ' + uid + ': ' + probs.join(', '));
        const au = p.authUsers.find(a => a.uid === uid);
        if (au && prof && au.email !== prof.username + EMAIL_DOMAIN) warns.push('username differs from Auth email for ' + prof.memberKey);
        if (prof && prof.memberKey) {
            const t = prof.teamId || T.UNASSIGNED;
            const entry = ((teamData[t] || {}).members || {})[prof.memberKey];
            if (entry && (entry.terminated === true) !== (prof.terminated === true)) fails.push('terminated differs between roster and profile for ' + prof.memberKey);
        }
    });
    if (!cutover) {
        p.state.users.forEach(u => {
            const prof = usersV2[uidByKey[u.key]];
            if (!prof) return;
            ['isAdmin', 'isManager'].forEach(f => { if (prof[f] !== u.profile[f]) fails.push(f + ' differs from legacy for ' + u.key); });
            if ((prof.teamId || null) !== (u.profile.teamId || null)) fails.push('teamId differs from legacy for ' + u.key);
        });
    }
    // orphan claims
    Object.keys(p.current.memberOwners || {}).forEach(k => { if (!usersV2[p.current.memberOwners[k]]) warns.push('orphan claim: ' + k + ' (clear-claim --key)'); });

    warns.forEach(w => log('WARNING ' + w));
    fails.forEach(f => log('FAIL ' + f));
    log(fails.length ? 'VERIFY FAILED (' + fails.length + ' difference(s))' : 'VERIFY PASSED');
    return fails.length ? 1 : 0;
}

// ---- small commands ----
async function markCutover(ctx) {
    await G.guardedDb(ctx.db).set('migration/cutoverAt', ctx.now());
    logger(ctx)('migration/cutoverAt set. run --resume and --mirror are now refused.');
    return 0;
}

async function clearCutover(ctx, flags) {
    if (!flags.yes) throw new Error('clear-cutover needs --yes');
    await G.guardedDb(ctx.db).remove('migration/cutoverAt');
    logger(ctx)('migration/cutoverAt removed (nothing else changed).');
    return 0;
}

async function findUidByUsername(ctx, username) {
    const u = await ctx.auth.getUserByEmail(String(username).toLowerCase() + EMAIL_DOMAIN);
    return u.uid;
}

// reset-password: random 16+ char password to the terminal only (design 4.5).
async function resetPassword(ctx, flags) {
    const log = logger(ctx);
    const db = G.guardedDb(ctx.db, G.ALLOWED_PREFIXES.concat(['passwordResetRequests/']));
    let targets = [];
    if (flags.username) targets.push(await findUidByUsername(ctx, flags.username));
    else if (flags.pending) targets = Object.keys((await ctx.db.ref('passwordResetRequests').once('value')).val() || {});
    else throw new Error('reset-password needs --pending or --username <name>');
    if (targets.length === 0) { log('No pending requests.'); return 0; }
    for (const uid of targets) {
        const prof = (await ctx.db.ref('usersV2/' + uid).once('value')).val();
        if (!prof) { log('skip ' + uid + ': no profile'); continue; }
        const pw = S.tempPassword(16);
        await ctx.auth.updateUser(uid, { password: pw });
        await db.set('usersV2/' + uid + '/mustResetPassword', true);
        await db.remove('passwordResetRequests/' + uid);
        ctx.out('username ' + prof.username + '  temporary password ' + pw);
    }
    log('Hand the temporary passwords over in person or by phone; they are not stored anywhere.');
    return 0;
}

async function setSuperuser(ctx, flags) {
    if (!flags.username) throw new Error('set-superuser needs --username');
    const superName = resolveSuperName(flags, (await ctx.db.ref('users').once('value')).val());
    const uid = await findUidByUsername(ctx, flags.username);
    const usersV2 = (await ctx.db.ref('usersV2').once('value')).val() || {};
    if (!usersV2[uid]) throw new Error('No profile for that user');
    if (usersV2[uid].name !== superName) throw new Error('Profile name "' + usersV2[uid].name + '" is not the Superuser "' + superName + '"');
    const db = G.guardedDb(ctx.db);
    const u = {};
    Object.keys(usersV2).forEach(id => { if (id !== uid && usersV2[id].isSuperAdmin === true) u['usersV2/' + id + '/isSuperAdmin'] = null; });
    u['usersV2/' + uid + '/isSuperAdmin'] = true;
    u['usersV2/' + uid + '/isAdmin'] = true;
    await db.update(u);
    logger(ctx)('Superuser set to ' + flags.username);
    return 0;
}

async function clearClaim(ctx, flags) {
    if (!flags.key) throw new Error('clear-claim needs --key');
    const owner = (await ctx.db.ref('memberOwners/' + flags.key).once('value')).val();
    if (!owner) { logger(ctx)('No claim for that key.'); return 0; }
    const prof = (await ctx.db.ref('usersV2/' + owner).once('value')).val();
    if (prof) throw new Error('Refusing: the claimant has a profile (not an orphan claim)');
    await G.guardedDb(ctx.db).remove('memberOwners/' + flags.key);
    logger(ctx)('Claim removed.');
    return 0;
}

async function deleteAuthUser(ctx, flags) {
    if (!flags.username) throw new Error('delete-auth-user needs --username');
    const uid = await findUidByUsername(ctx, flags.username);
    const prof = (await ctx.db.ref('usersV2/' + uid).once('value')).val();
    if (prof) throw new Error('Refusing: this Auth user has a profile');
    await ctx.auth.deleteUser(uid);
    logger(ctx)('Auth user deleted.');
    return 0;
}

async function exportNew(ctx, flags) {
    const file = flags['to-json'];
    if (!file) throw new Error('export-new needs --to-json <file>');
    const data = await readNodes(ctx.db, ['teamData', 'holidays']);
    fs.writeFileSync(path.resolve(ctx.cwd, file), JSON.stringify(data, null, 2));
    logger(ctx)('Wrote ' + file + ' (contains attendance data; keep it private).');
    return 0;
}

async function showPasswords(ctx, flags, file) {
    if (!file) throw new Error('show-passwords needs a file');
    const pass = ctx.env.MIGRATION_CSV_PASSPHRASE || await ctx.prompt('Passphrase: ');
    ctx.out(S.decrypt(fs.readFileSync(file, 'utf8'), pass));
    return 0;
}

module.exports = {
    plan, run, verify, markCutover, clearCutover, resetPassword, setSuperuser, clearClaim,
    deleteAuthUser, exportNew, showPasswords, resolveSuperName, redact, LEGACY_NODES, NEW_NODES
};
