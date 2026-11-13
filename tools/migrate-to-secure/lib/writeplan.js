'use strict';
// Add-only, refresh and mirror write planning (design 9). Pure functions over
// flattened leaf maps ({ 'a/b/c': value }).

const REFRESH_PROFILE_FIELDS = ['isAdmin', 'isManager', 'isSuperAdmin', 'teamId', 'terminated', 'terminatedAt', 'mustResetPassword', 'name'];

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// Add-only: write absent leaves, skip equal ones, report different ones as conflicts.
function addOnly(desiredFlat, currentFlat) {
    const writes = {};
    const conflicts = [];
    let equal = 0;
    Object.keys(desiredFlat).forEach(p => {
        if (!(p in currentFlat)) writes[p] = desiredFlat[p];
        else if (same(currentFlat[p], desiredFlat[p])) equal++;
        else conflicts.push(p);
    });
    return { writes, conflicts, equal };
}

// Refresh exceptions: overwrite listed profile fields of legacy users and teamNames,
// remove such fields / teamNames ids absent from the desired state, and move a
// member's data out of buckets other than the desired one.
function refreshOverrides(desiredFlat, currentFlat, legacyUids, desiredBucketByKey) {
    const u = {};
    const uidSet = new Set(legacyUids);
    const isRefreshField = p => {
        const m = /^usersV2\/([^/]+)\/([^/]+)$/.exec(p);
        return !!(m && uidSet.has(m[1]) && REFRESH_PROFILE_FIELDS.includes(m[2]));
    };
    Object.keys(desiredFlat).forEach(p => {
        if ((isRefreshField(p) || /^teamNames\/[^/]+$/.test(p)) && (p in currentFlat) && !same(currentFlat[p], desiredFlat[p])) u[p] = desiredFlat[p];
    });
    Object.keys(currentFlat).forEach(p => {
        if ((isRefreshField(p) || /^teamNames\/[^/]+$/.test(p)) && !(p in desiredFlat)) u[p] = null;
        const m = /^teamData\/([^/]+)\/(members|attendance|leaves)\/([^/]+)(\/|$)/.exec(p);
        if (m && desiredBucketByKey[m[3]] && desiredBucketByKey[m[3]] !== m[1]) {
            u['teamData/' + m[1] + '/' + m[2] + '/' + m[3]] = null;
        }
    });
    return u;
}

// Mirror: delete current leaves under the mirror prefixes that are absent from the desired state.
function mirrorDeletes(desiredFlat, currentFlat, prefixes) {
    const u = {};
    Object.keys(currentFlat).forEach(p => {
        if (prefixes.some(pre => p.startsWith(pre)) && !(p in desiredFlat)) u[p] = null;
    });
    return u;
}

// Drop null entries whose ancestor is also being set to null (RTDB refuses
// overlapping paths). A value written under a deleted ancestor is a planning
// error and throws rather than silently losing data.
function normalizeUpdates(u) {
    const nullPaths = Object.keys(u).filter(p => u[p] === null);
    const out = {};
    Object.keys(u).forEach(p => {
        const ancestor = nullPaths.find(q => q !== p && p.startsWith(q + '/'));
        if (!ancestor) { out[p] = u[p]; return; }
        if (u[p] !== null) throw new Error('Write plan error: "' + p + '" is written under deleted "' + ancestor + '"');
    });
    return out;
}

function chunk(u, size) {
    const keys = Object.keys(u);
    const out = [];
    for (let i = 0; i < keys.length; i += size) {
        const c = {};
        keys.slice(i, i + size).forEach(k => { c[k] = u[k]; });
        out.push(c);
    }
    return out;
}

module.exports = { REFRESH_PROFILE_FIELDS, addOnly, refreshOverrides, mirrorDeletes, normalizeUpdates, chunk, same };
