'use strict';
// Legacy -> secure desired state (design 9). Pure: no I/O, no Firebase.
// Never puts a password hash in any report field; hashes stay on `users[i].hash`
// for the importer only.

const H = require('../../../auth-helpers.js');
const { isUsableHash } = require('./hashes');

const LEAVE_TYPES = ['leave', 'wfh', 'wfh-email', 'exception', 'planned'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UNASSIGNED = 'unassigned';
const REQUIRED_PROFILE_FIELDS = ['name', 'username', 'memberKey', 'isAdmin', 'isManager', 'terminated', 'registeredAt'];

const nameKey = n => String(n).replace(/\./g, '___DOT___');
const decodeKey = k => String(k).replace(/___DOT___/g, '.');
const arr = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : (v && typeof v === 'object' ? Object.values(v).filter(x => typeof x === 'string' && x) : []));
// eslint-disable-next-line no-control-regex
const hasControl = s => /[\u0000-\u001f\u007f]/.test(s);

function keyProblem(key) {
    if (typeof key !== 'string' || key.length === 0) return 'empty key';
    if (key.length > 128) return 'key longer than 128 characters';
    if (/[$#\[\]\/.]/.test(key)) return 'key contains $ # [ ] / or .';
    if (hasControl(key)) return 'key contains control characters';
    return '';
}

function isAccount(rec) {
    return !!(rec && typeof rec === 'object' && typeof rec.passwordHash === 'string' && rec.passwordHash.length > 0);
}

// legacy: the root snapshot (appData, teamMembers, admins, managers, memberTeams, users, teams, settings)
// opts: { superuser, now (ISO), rotateAll (default true), importHashes, existingUsernames: {username: uid} }
function transform(legacy, opts) {
    const o = Object.assign({ rotateAll: true, importHashes: false, existingUsernames: {} }, opts || {});
    if (!o.superuser) throw new Error('transform: superuser name is required');
    const now = o.now || new Date().toISOString();
    const L = legacy || {};
    const appData = L.appData || {};
    const users = (L.users && typeof L.users === 'object') ? L.users : {};
    const admins = arr(L.admins);
    const managers = arr(L.managers);
    const memberTeams = (L.memberTeams && typeof L.memberTeams === 'object') ? L.memberTeams : {};
    const teams = (L.teams && typeof L.teams === 'object') ? L.teams : {};
    const teamMembers = arr(L.teamMembers);

    const report = {
        conflicts: [], teamIdConflicts: [], violations: [], duplicateHolidays: [], usernameCollisions: [],
        rosterOnlyUserRecords: [], membersWithoutTeam: [], unrosteredDataKeys: [], terminatedUsers: [],
        hashEligible: 0, hashIneligible: 0
    };
    const violate = (kind, detail) => report.violations.push(kind + ': ' + detail);

    // ---- teams -> teamNames (teams itself is never written) ----
    const teamNames = {};
    Object.keys(teams).forEach(id => {
        const t = teams[id];
        if (id === UNASSIGNED) { violate('teams', 'team id "unassigned" is reserved'); return; }
        if (!t || typeof t !== 'object' || t.id !== id || typeof t.name !== 'string' || t.name.length < 1 || t.name.length > 100) {
            violate('teams', 'team "' + id + '" fails the shape check (id equals key, name 1..100)');
            if (t && typeof t.name === 'string' && t.name.length >= 1 && t.name.length <= 100) teamNames[id] = t.name;
            return;
        }
        teamNames[id] = t.name;
    });
    const validTeam = id => typeof id === 'string' && !!teamNames[id];

    function effectiveTeam(key) {
        const viaMap = memberTeams[key];
        const viaUser = users[key] && users[key].teamId;
        const chosen = viaMap || viaUser || null;
        if (chosen && !validTeam(chosen)) {
            report.teamIdConflicts.push({ key, teamId: chosen });
            return null;
        }
        return chosen;
    }

    // ---- accounts (registered users) + Superuser ----
    const superKey = nameKey(o.superuser);
    const accountKeys = Object.keys(users).filter(k => isAccount(users[k]));
    Object.keys(users).filter(k => !isAccount(users[k]) && k !== superKey).forEach(k => report.rosterOnlyUserRecords.push(k));
    if (!accountKeys.includes(superKey)) accountKeys.push(superKey);
    accountKeys.sort();

    const taken = Object.assign({}, o.existingUsernames || {});
    const usersOut = [];
    accountKeys.forEach(key => {
        const rec = users[key] || {};
        const name = typeof rec.name === 'string' && rec.name ? rec.name : decodeKey(key);
        const isSuper = key === superKey;
        const isAdmin = isSuper || admins.includes(name);
        const isManager = managers.includes(name);
        const teamId = effectiveTeam(key);
        // Disagreements between users/* and the arrays/memberTeams (design 9 reconciliation)
        if (typeof rec.isAdmin === 'boolean' && rec.isAdmin !== isAdmin) report.conflicts.push({ key, field: 'isAdmin', usersValue: rec.isAdmin, arraysValue: isAdmin, used: isAdmin });
        if (typeof rec.isManager === 'boolean' && rec.isManager !== isManager) report.conflicts.push({ key, field: 'isManager', usersValue: rec.isManager, arraysValue: isManager, used: isManager });
        if (rec.teamId && memberTeams[key] && rec.teamId !== memberTeams[key]) report.conflicts.push({ key, field: 'teamId', usersValue: rec.teamId, arraysValue: memberTeams[key], used: memberTeams[key] });

        const kp = keyProblem(key);
        if (kp) violate('memberKey', '"' + key + '" ' + kp);
        if (nameKey(name) !== key) violate('name', 'name of "' + key + '" does not map to its key');
        if (name.length > 100) violate('name', '"' + key + '" name longer than 100 characters');
        if (hasControl(name)) violate('name', '"' + key + '" name contains control characters');

        let base = H.normalizeUsername(typeof rec.username === 'string' ? rec.username : '') || H.normalizeUsername(H.generateUsername(name));
        if (!base) base = 'member';
        if (base.length > 60) base = base.slice(0, 60);
        let username = base;
        let n = 2;
        while (taken[username] !== undefined && taken[username] !== key) { username = base + n; n++; }
        if (username !== base) report.usernameCollisions.push({ key, base, username });
        taken[username] = key;

        const terminated = rec.terminated === true;
        const privileged = isSuper || isAdmin || isManager;
        const usable = !isSuper && isUsableHash(rec.passwordHash);
        if (usable) report.hashEligible++; else report.hashIneligible++;
        const hashImport = !!o.importHashes && !o.rotateAll && !privileged && usable;
        const profile = {
            name, username, memberKey: key, isAdmin, isManager, terminated,
            registeredAt: typeof rec.registeredAt === 'string' ? rec.registeredAt : (typeof rec.createdAt === 'string' ? rec.createdAt : now)
        };
        if (teamId) profile.teamId = teamId;
        if (isSuper) profile.isSuperAdmin = true;
        if (terminated && typeof rec.terminatedAt === 'string') profile.terminatedAt = rec.terminatedAt;
        if (!hashImport || rec.mustResetPassword === true) profile.mustResetPassword = true;
        if (terminated) report.terminatedUsers.push(key);
        usersOut.push({
            key, name, username, email: H.authEmail(username), profile, isSuper, privileged, hashImport,
            role: isSuper ? 'superuser' : (isAdmin ? 'admin' : (isManager ? 'manager' : 'other')),
            hash: hashImport ? rec.passwordHash : null
        });
    });

    // ---- roster groups 1-3 ----
    const roster = {};
    const placed = {};
    const put = (key, entry) => {
        const t = effectiveTeam(key) || UNASSIGNED;
        if (t === UNASSIGNED) report.membersWithoutTeam.push(key);
        roster[t] = roster[t] || {};
        roster[t][key] = entry;
        placed[key] = t;
    };
    const termKeys = new Set(usersOut.filter(u => u.profile.terminated).map(u => u.key));
    teamMembers.forEach((name, i) => {
        const key = nameKey(name);
        if (placed[key]) return;
        const kp = keyProblem(key);
        if (kp) violate('memberKey', '"' + key + '" ' + kp);
        if (name.length > 100) violate('name', '"' + key + '" name longer than 100 characters');
        const e = { name, order: i };
        if (termKeys.has(key)) e.terminated = true;
        put(key, e);
    });
    let next = teamMembers.length;
    const group2 = usersOut.filter(u => u.profile.terminated && !placed[u.key]).map(u => u.key).sort();
    group2.forEach(key => { const u = usersOut.find(x => x.key === key); put(key, { name: u.name, order: next++, terminated: true }); });

    const att = appData.attendance && typeof appData.attendance === 'object' ? appData.attendance : {};
    const lv = appData.leaves && typeof appData.leaves === 'object' ? appData.leaves : {};
    const dataKeys = new Set(Object.keys(att).concat(Object.keys(lv)));
    const otherAccounts = usersOut.filter(u => !placed[u.key]).map(u => u.key);
    const group3 = Array.from(new Set(Array.from(dataKeys).filter(k => !placed[k]).concat(otherAccounts))).sort();
    group3.forEach(key => {
        if (dataKeys.has(key) && !usersOut.some(u => u.key === key)) report.unrosteredDataKeys.push(key);
        const kp = keyProblem(key);
        if (kp) violate('memberKey', '"' + key + '" ' + kp);
        const u = usersOut.find(x => x.key === key);
        put(key, { name: u ? u.name : decodeKey(key), order: next++ });
    });

    // ---- attendance / leaves by team bucket ----
    const attendance = {};
    const leaves = {};
    Object.keys(att).forEach(key => {
        const days = att[key];
        if (!days || typeof days !== 'object') { violate('attendance', '"' + key + '" is not a date map'); return; }
        Object.keys(days).forEach(d => {
            if (!DATE_RE.test(d)) { violate('attendance', '"' + key + '" date "' + d + '" is not YYYY-MM-DD'); return; }
            if (days[d] !== true) { violate('attendance', '"' + key + '" ' + d + ' value is not true'); return; }
            const t = placed[key];
            ((attendance[t] = attendance[t] || {})[key] = attendance[t][key] || {})[d] = true;
        });
    });
    Object.keys(lv).forEach(key => {
        const days = lv[key];
        if (!days || typeof days !== 'object') { violate('leaves', '"' + key + '" is not a date map'); return; }
        Object.keys(days).forEach(d => {
            if (!DATE_RE.test(d)) { violate('leaves', '"' + key + '" date "' + d + '" is not YYYY-MM-DD'); return; }
            if (!LEAVE_TYPES.includes(days[d])) { violate('leaves', '"' + key + '" ' + d + ' type "' + String(days[d]).slice(0, 20) + '" is not allowed'); return; }
            const t = placed[key];
            ((leaves[t] = leaves[t] || {})[key] = leaves[t][key] || {})[d] = days[d];
        });
    });

    // ---- holidays: array -> keyed by date, duplicates reported ----
    const holidays = {};
    const hl = Array.isArray(appData.holidays) ? appData.holidays : (appData.holidays && typeof appData.holidays === 'object' ? Object.values(appData.holidays) : []);
    hl.forEach(h => {
        if (!h || typeof h !== 'object') return;
        if (!DATE_RE.test(String(h.date))) { violate('holidays', 'date "' + String(h.date).slice(0, 20) + '" is not YYYY-MM-DD'); return; }
        if (typeof h.name !== 'string' || h.name.length < 1 || h.name.length > 100) { violate('holidays', h.date + ' name must be 1..100 characters'); return; }
        if (holidays[h.date]) { report.duplicateHolidays.push(h.date); return; }
        holidays[h.date] = { name: h.name };
    });

    // ---- counts line (design 9) ----
    const rotated = usersOut.filter(u => !u.hashImport);
    const c = {
        hashImported: usersOut.length - rotated.length,
        rotated: rotated.length,
        superuser: rotated.filter(u => u.role === 'superuser').length,
        admins: rotated.filter(u => u.role === 'admin').length,
        managers: rotated.filter(u => u.role === 'manager').length,
        others: rotated.filter(u => u.role === 'other').length
    };
    report.countsLine = c.hashImported + ' users hash-imported, ' + c.rotated + ' users rotated (Superuser ' + c.superuser +
        ', Admins ' + c.admins + ', Managers ' + c.managers + ', others ' + c.others + ')';
    report.counts = c;

    report.membersWithoutTeam = Array.from(new Set(report.membersWithoutTeam)).sort();
    return { users: usersOut, roster, attendance, leaves, holidays, teamNames, report };
}

// Profile shape check used by plan and verify (seven mandatory fields + patterns).
function profileProblems(p) {
    const out = [];
    if (!p || typeof p !== 'object') return ['not an object'];
    REQUIRED_PROFILE_FIELDS.forEach(f => { if (!(f in p)) out.push('missing ' + f); });
    ['isAdmin', 'isManager', 'terminated'].forEach(f => { if (f in p && typeof p[f] !== 'boolean') out.push(f + ' not boolean'); });
    if (typeof p.username !== 'string' || !/^[a-z0-9._-]{1,64}$/.test(p.username)) out.push('username pattern');
    if (keyProblem(p.memberKey)) out.push('memberKey pattern');
    if (typeof p.name !== 'string' || p.name.length < 1 || p.name.length > 100) out.push('name length');
    return out;
}

// Desired new-structure tree for the given uid map (key -> uid).
function desiredTree(state, uidByKey) {
    const tree = { usersV2: {}, memberOwners: {}, teamNames: Object.assign({}, state.teamNames), teamData: {}, holidays: JSON.parse(JSON.stringify(state.holidays)) };
    state.users.forEach(u => {
        const uid = uidByKey[u.key];
        if (!uid) return;
        tree.usersV2[uid] = Object.assign({}, u.profile);
        tree.memberOwners[u.key] = uid;
    });
    Object.keys(state.roster).forEach(t => {
        Object.keys(state.roster[t]).forEach(key => {
            const e = Object.assign({}, state.roster[t][key]);
            if (uidByKey[key]) e.uid = uidByKey[key];
            ((tree.teamData[t] = tree.teamData[t] || {}).members = tree.teamData[t].members || {})[key] = e;
        });
    });
    ['attendance', 'leaves'].forEach(kind => {
        Object.keys(state[kind]).forEach(t => {
            ((tree.teamData[t] = tree.teamData[t] || {})[kind] = tree.teamData[t][kind] || {});
            Object.assign(tree.teamData[t][kind], JSON.parse(JSON.stringify(state[kind][t])));
        });
    });
    return tree;
}

// Flatten to leaf paths: { 'a/b/c': value }.
function flatten(obj, prefix, out) {
    const res = out || {};
    if (obj === null || obj === undefined) return res;
    if (typeof obj !== 'object' || Array.isArray(obj)) { res[prefix] = obj; return res; }
    const keys = Object.keys(obj);
    if (keys.length === 0) return res;
    keys.forEach(k => flatten(obj[k], prefix ? prefix + '/' + k : k, res));
    return res;
}

module.exports = {
    transform, desiredTree, flatten, profileProblems, keyProblem, nameKey, decodeKey,
    LEAVE_TYPES, DATE_RE, UNASSIGNED, REQUIRED_PROFILE_FIELDS
};
