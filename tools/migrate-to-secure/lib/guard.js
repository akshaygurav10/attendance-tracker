'use strict';
// Write guard (design 9): the migration may write only under the new prefixes.
// Everything else, including `teams`, `settings` and every legacy node
// (appData, teamMembers, admins, managers, memberTeams, users), is refused
// in code before any database call.

const ALLOWED_PREFIXES = ['usersV2/', 'memberOwners/', 'teamNames/', 'teamData/', 'holidays/', 'migration/'];
// Desired-state mirror deletes are limited further (design 9 --mirror).
const MIRROR_PREFIXES = ['teamData/', 'holidays/', 'teamNames/'];

function normalize(p) {
    return String(p == null ? '' : p).replace(/^\/+/, '').replace(/\/+$/, '');
}

function isAllowed(p, prefixes) {
    const n = normalize(p);
    if (!n || n.includes('..')) return false;
    return (prefixes || ALLOWED_PREFIXES).some(pre => n.startsWith(pre) && n.length > pre.length);
}

function assertAllowed(p, prefixes) {
    if (!isAllowed(p, prefixes)) {
        throw new Error('Write guard: refusing to write outside the new paths: "' + normalize(p) + '"');
    }
}

// Wrap an Admin SDK database so every write goes through the guard.
// Only set/update/remove at explicit child paths are exposed; root writes are refused.
function guardedDb(db, prefixes) {
    return {
        async get(path) { return (await db.ref(normalize(path)).once('value')).val(); },
        async set(path, value) { assertAllowed(path, prefixes); return db.ref(normalize(path)).set(value); },
        async remove(path) { assertAllowed(path, prefixes); return db.ref(normalize(path)).remove(); },
        async update(values) {
            const keys = Object.keys(values || {});
            keys.forEach(k => assertAllowed(k, prefixes));
            if (keys.length === 0) return;
            return db.ref().update(values);
        }
    };
}

module.exports = { ALLOWED_PREFIXES, MIRROR_PREFIXES, isAllowed, assertAllowed, guardedDb, normalize };
