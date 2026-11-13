// ==========================================
// DATA PATHS (secure mode, design 3 / 5.2 / 5.3)
// Pure path builders, listener plans, in-memory assembly and multi-path
// payloads for the per-team structure. No DOM and no Firebase calls.
// Browser global `DataPaths`; require()-able from Node for unit tests.
// ==========================================
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.DataPaths = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const UNASSIGNED = 'unassigned';
    const LEAVE_TYPES = ['leave', 'wfh', 'wfh-email', 'exception', 'planned'];
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

    function decodeKey(key) { return String(key == null ? '' : key).replace(/___DOT___/g, '.'); }

    function bucketOf(profile) {
        return profile && typeof profile.teamId === 'string' && profile.teamId ? profile.teamId : UNASSIGNED;
    }

    function isSuper(p) { return !!(p && p.isSuperAdmin === true); }
    function isAdminProfile(p) { return !!(p && (p.isAdmin === true || p.isSuperAdmin === true)); }

    // Role used for the listener plan (design 5.2). A team-less Admin or Manager
    // is treated as Unassigned.
    function roleOf(profile) {
        if (!profile) return 'none';
        if (isSuper(profile)) return 'superuser';
        const hasTeam = bucketOf(profile) !== UNASSIGNED;
        if (!hasTeam) return 'unassigned';
        if (profile.isAdmin === true) return 'admin';
        if (profile.isManager === true) return 'manager';
        return 'employee';
    }

    // First team self-assignment is allowed only for non-privileged users (design 4.2 6a, Q13).
    function canSelfAssignTeam(profile) {
        return !!profile && profile.isAdmin !== true && profile.isSuperAdmin !== true &&
            profile.isManager !== true && bucketOf(profile) === UNASSIGNED;
    }

    const paths = {
        profile: uid => 'usersV2/' + uid,
        members: t => 'teamData/' + t + '/members',
        member: (t, k) => 'teamData/' + t + '/members/' + k,
        attendance: (t, k) => 'teamData/' + t + '/attendance' + (k ? '/' + k : ''),
        attendanceDay: (t, k, d) => 'teamData/' + t + '/attendance/' + k + '/' + d,
        leaves: (t, k) => 'teamData/' + t + '/leaves' + (k ? '/' + k : ''),
        leaveDay: (t, k, d) => 'teamData/' + t + '/leaves/' + k + '/' + d,
        holiday: d => 'holidays/' + d,
        resetRequest: uid => 'passwordResetRequests/' + uid
    };

    function selfSet(bucket, key) {
        return [paths.member(bucket, key), paths.attendance(bucket, key), paths.leaves(bucket, key)];
    }
    function teamSet(team) {
        return [paths.members(team), paths.attendance(team), paths.leaves(team)];
    }
    const SHARED = ['holidays', 'settings', 'teams'];

    // Listener plan per role (design 5.2). `fallback` = the team-wide read was denied.
    function listenerPlan(profile, settings, opts) {
        const o = opts || {};
        const role = roleOf(profile);
        const bucket = bucketOf(profile);
        const key = profile ? profile.memberKey : '';
        if (role === 'none') return { role, paths: [], perUidProfiles: false, teamWide: false };
        if (role === 'superuser') {
            return { role, paths: ['teamData', 'teams', 'holidays', 'settings', 'usersV2'], perUidProfiles: false, teamWide: true };
        }
        if (role === 'admin') {
            return { role, paths: teamSet(bucket).concat(SHARED), perUidProfiles: true, teamWide: true };
        }
        if (role === 'manager') {
            return { role, paths: teamSet(bucket).concat(SHARED), perUidProfiles: false, teamWide: true };
        }
        const toggle = !!(settings && settings.everyoneSeesAll === true);
        if (role === 'employee' && toggle && !o.fallback) {
            return { role, paths: teamSet(bucket).concat(SHARED), perUidProfiles: false, teamWide: true };
        }
        // Employee (toggle off or fallback) and Unassigned: own paths only, never team-wide.
        return { role, paths: selfSet(bucket, key).concat(SHARED), perUidProfiles: false, teamWide: false };
    }

    // Write `value` into a nested object at the slash path (null removes).
    function setIn(obj, path, value) {
        const parts = path.split('/').filter(Boolean);
        let cur = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
            cur = cur[parts[i]];
        }
        const last = parts[parts.length - 1];
        if (value === null || value === undefined) delete cur[last];
        else cur[last] = value;
        return obj;
    }

    // Build a tree from { path: value } listener results.
    function storeToTree(store) {
        const tree = {};
        Object.keys(store).sort((a, b) => a.split('/').length - b.split('/').length).forEach(p => {
            const v = store[p];
            setIn(tree, p, v === null || v === undefined ? null : JSON.parse(JSON.stringify(v)));
        });
        return tree;
    }

    function holidaysToList(h) {
        if (!h || typeof h !== 'object') return [];
        return Object.keys(h).filter(d => h[d] && typeof h[d].name === 'string')
            .sort().map(d => ({ date: d, name: h[d].name }));
    }

    // Assemble the in-memory shape the renderer already uses (design 5.2):
    // attendance[name][date], leaves[name][date], holidays[], plus roster
    // derived lists. `ownUid`/`profile` describe the signed-in user.
    function assemble(store, profile, ownUid) {
        const tree = storeToTree(store || {});
        const teamData = tree.teamData || {};
        const out = {
            teamMembers: [], memberTeams: {}, attendance: {}, leaves: {}, holidays: holidaysToList(tree.holidays),
            teams: (tree.teams && typeof tree.teams === 'object') ? tree.teams : {},
            settings: (tree.settings && typeof tree.settings === 'object') ? tree.settings : {},
            roster: {}, terminated: [], admins: [], managers: [], profiles: {}
        };
        const entries = [];
        Object.keys(teamData).forEach(teamId => {
            const t = teamData[teamId] || {};
            const members = t.members || {};
            const nameOf = key => (members[key] && members[key].name) ||
                (profile && key === profile.memberKey ? profile.name : decodeKey(key));
            Object.keys(members).forEach(key => {
                const m = members[key] || {};
                entries.push({
                    name: m.name || decodeKey(key), key, teamId, uid: m.uid || null,
                    order: typeof m.order === 'number' ? m.order : Number.MAX_SAFE_INTEGER,
                    terminated: m.terminated === true
                });
            });
            Object.keys(t.attendance || {}).forEach(key => {
                const name = nameOf(key);
                out.attendance[name] = Object.assign(out.attendance[name] || {}, t.attendance[key]);
            });
            Object.keys(t.leaves || {}).forEach(key => {
                const name = nameOf(key);
                out.leaves[name] = Object.assign(out.leaves[name] || {}, t.leaves[key]);
            });
        });
        entries.sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
        entries.forEach(e => {
            if (!out.roster[e.name]) out.roster[e.name] = e;
            if (e.terminated) {
                if (!out.terminated.some(x => x.name === e.name)) out.terminated.push(e);
                return;
            }
            if (!out.teamMembers.includes(e.name)) out.teamMembers.push(e.name);
            if (e.teamId !== UNASSIGNED) out.memberTeams[e.name.replace(/\./g, '___DOT___')] = e.teamId;
        });
        // The signed-in user is always present for themselves.
        if (profile && profile.terminated !== true) {
            if (!out.teamMembers.includes(profile.name)) out.teamMembers.unshift(profile.name);
            if (!out.roster[profile.name]) {
                out.roster[profile.name] = { name: profile.name, key: profile.memberKey, teamId: bucketOf(profile), uid: ownUid || null, order: 0, terminated: false };
            }
            const myTeam = bucketOf(profile);
            if (myTeam !== UNASSIGNED) out.memberTeams[profile.name.replace(/\./g, '___DOT___')] = myTeam;
        }
        // Role data for others: whole usersV2 (Superuser) or per-uid profiles (Admin).
        const profiles = Object.assign({}, tree.usersV2 || {});
        if (profile && ownUid) profiles[ownUid] = profile;
        out.profiles = profiles;
        Object.keys(profiles).forEach(uid => {
            const p = profiles[uid];
            if (!p || typeof p !== 'object' || p.terminated === true) return;
            if (isAdminProfile(p) && !out.admins.includes(p.name)) out.admins.push(p.name);
            if (p.isManager === true && !out.managers.includes(p.name)) out.managers.push(p.name);
        });
        return out;
    }

    // ---- Multi-path payloads ----

    // Superuser (or team delete) move of one member's roster, attendance and leaves.
    function memberMovePayload(key, from, to, data, uid) {
        const d = data || {};
        const u = {};
        if (d.member) u[paths.member(to, key)] = d.member;
        Object.keys(d.attendance || {}).forEach(date => { u[paths.attendanceDay(to, key, date)] = d.attendance[date]; });
        Object.keys(d.leaves || {}).forEach(date => { u[paths.leaveDay(to, key, date)] = d.leaves[date]; });
        u[paths.member(from, key)] = null;
        u[paths.attendance(from, key)] = null;
        u[paths.leaves(from, key)] = null;
        if (uid) u['usersV2/' + uid + '/teamId'] = to === UNASSIGNED ? null : to;
        return u;
    }

    // Self move step 3 (design 4.2 6a): copy to T where T lacks the leaf, then
    // remove the unassigned copies, in one update. `existing` = own data already in T.
    function selfMoveStep3Payload(profile, uid, team, unassignedData, existing) {
        const key = profile.memberKey;
        const src = unassignedData || {};
        const have = existing || {};
        const u = {};
        if (!have.member) {
            const m = src.member || {};
            u[paths.member(team, key)] = {
                name: profile.name,
                order: typeof m.order === 'number' ? m.order : Date.now(),
                uid,
                addedBy: (typeof m.addedBy === 'string' ? m.addedBy : key).slice(0, 100)
            };
        } else if (!have.member.uid) {
            u[paths.member(team, key) + '/uid'] = uid;
        }
        Object.keys(src.attendance || {}).forEach(date => {
            if (!(have.attendance && have.attendance[date] !== undefined)) u[paths.attendanceDay(team, key, date)] = src.attendance[date];
        });
        Object.keys(src.leaves || {}).forEach(date => {
            if (!(have.leaves && have.leaves[date] !== undefined)) u[paths.leaveDay(team, key, date)] = src.leaves[date];
        });
        if (src.member) u[paths.member(UNASSIGNED, key)] = null;
        if (src.attendance) u[paths.attendance(UNASSIGNED, key)] = null;
        if (src.leaves) u[paths.leaves(UNASSIGNED, key)] = null;
        return u;
    }

    function rosterSelfEntry(profile, uid, now) {
        // addedBy is limited to 100 characters by the rules; memberKey may be longer.
        return { name: profile.name, order: now, uid, addedBy: String(profile.memberKey).slice(0, 100) };
    }

    function terminatePayload(entry, targetProfile, nowIso) {
        const u = {};
        u[paths.member(entry.teamId, entry.key) + '/terminated'] = true;
        if (entry.uid) {
            u['usersV2/' + entry.uid + '/terminated'] = true;
            u['usersV2/' + entry.uid + '/terminatedAt'] = nowIso;
            if (targetProfile && targetProfile.isAdmin === true) u['usersV2/' + entry.uid + '/isAdmin'] = false;
        }
        return u;
    }

    function restorePayload(entry) {
        const u = {};
        u[paths.member(entry.teamId, entry.key) + '/terminated'] = false;
        if (entry.uid) {
            u['usersV2/' + entry.uid + '/terminated'] = false;
            u['usersV2/' + entry.uid + '/terminatedAt'] = null;
            u['usersV2/' + entry.uid + '/mustResetPassword'] = true;
        }
        return u;
    }

    function teamCreatePayload(id, name, createdBy, nowIso) {
        const u = {};
        u['teams/' + id] = { id, name, createdBy, createdAt: nowIso };
        u['teamNames/' + id] = name;
        return u;
    }

    function teamRenamePayload(id, name) {
        const u = {};
        u['teams/' + id + '/name'] = name;
        u['teamNames/' + id] = name;
        return u;
    }

    // Delete a team: members move to `unassigned`, their teamId is cleared,
    // `teams` and `teamNames` are removed together. No user is deleted.
    function teamDeletePayload(teamId, teamNode) {
        const t = teamNode || {};
        const u = {};
        const keys = new Set(Object.keys(t.members || {})
            .concat(Object.keys(t.attendance || {})).concat(Object.keys(t.leaves || {})));
        keys.forEach(key => {
            const m = (t.members || {})[key];
            if (m) u[paths.member(UNASSIGNED, key)] = m;
            Object.keys((t.attendance || {})[key] || {}).forEach(d => { u[paths.attendanceDay(UNASSIGNED, key, d)] = t.attendance[key][d]; });
            Object.keys((t.leaves || {})[key] || {}).forEach(d => { u[paths.leaveDay(UNASSIGNED, key, d)] = t.leaves[key][d]; });
            if (m && m.uid) u['usersV2/' + m.uid + '/teamId'] = null;
            // Per-key removals: the rules grant writes per member key, not on teamData/{team}.
            if (m) u[paths.member(teamId, key)] = null;
            if ((t.attendance || {})[key]) u[paths.attendance(teamId, key)] = null;
            if ((t.leaves || {})[key]) u[paths.leaves(teamId, key)] = null;
        });
        u['teams/' + teamId] = null;
        u['teamNames/' + teamId] = null;
        return u;
    }

    function holidayListToNode(list) {
        const node = {};
        (list || []).forEach(h => { if (h && DATE_RE.test(h.date) && h.name) node[h.date] = { name: String(h.name).slice(0, 100) }; });
        return node;
    }

    return {
        UNASSIGNED, LEAVE_TYPES, DATE_RE, paths, bucketOf, roleOf, canSelfAssignTeam,
        listenerPlan, setIn, storeToTree, assemble, holidaysToList, holidayListToNode,
        memberMovePayload, selfMoveStep3Payload, rosterSelfEntry, terminatePayload,
        restorePayload, teamCreatePayload, teamRenamePayload, teamDeletePayload, decodeKey
    };
});
