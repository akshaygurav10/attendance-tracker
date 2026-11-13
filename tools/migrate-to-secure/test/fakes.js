'use strict';
// Mock Admin SDK (Realtime Database + Auth) for the migration unit tests.
const fs = require('fs');
const os = require('os');
const path = require('path');

const split = p => String(p || '').split('/').filter(Boolean);
function getIn(t, p) { let c = t; for (const k of split(p)) { if (c == null || typeof c !== 'object') return null; c = c[k]; } return c === undefined ? null : c; }
function prune(t, parts) {
    for (let i = parts.length; i > 0; i--) {
        const node = getIn(t, parts.slice(0, i).join('/'));
        if (node && typeof node === 'object' && Object.keys(node).length === 0) {
            const parent = i === 1 ? t : getIn(t, parts.slice(0, i - 1).join('/'));
            delete parent[parts[i - 1]];
        } else break;
    }
}
function setIn(t, p, v) {
    const parts = split(p);
    let c = t;
    for (let i = 0; i < parts.length - 1; i++) { if (!c[parts[i]] || typeof c[parts[i]] !== 'object') c[parts[i]] = {}; c = c[parts[i]]; }
    if (v === null || v === undefined) { delete c[parts[parts.length - 1]]; prune(t, parts.slice(0, -1)); }
    else c[parts[parts.length - 1]] = JSON.parse(JSON.stringify(v));
}

function fakeDb(initial) {
    const state = { tree: JSON.parse(JSON.stringify(initial || {})), writes: [] };
    const ref = (p) => {
        const key = split(p).join('/');
        return {
            once: async () => ({ val: () => { const v = getIn(state.tree, key); return v === null ? null : JSON.parse(JSON.stringify(v)); } }),
            set: async v => { state.writes.push(['set', key, v]); setIn(state.tree, key, v); },
            remove: async () => { state.writes.push(['remove', key]); setIn(state.tree, key, null); },
            update: async vals => {
                Object.keys(vals).forEach(k => state.writes.push(['update', (key ? key + '/' : '') + k, vals[k]]));
                Object.keys(vals).forEach(k => setIn(state.tree, (key ? key + '/' : '') + k, vals[k]));
            }
        };
    };
    return { ref, state, get: p => getIn(state.tree, p) };
}

function fakeAuth(initialUsers) {
    const state = { users: {}, created: [], imported: [], updated: [], deleted: [] };
    (initialUsers || []).forEach(u => { state.users[u.uid] = Object.assign({}, u); });
    let n = 0;
    const byEmail = e => Object.values(state.users).find(u => u.email === e);
    return {
        state,
        async listUsers() { return { users: Object.values(state.users).map(u => ({ uid: u.uid, email: u.email })), pageToken: undefined }; },
        async createUser(props) {
            if (byEmail(props.email)) { const e = new Error('exists'); e.code = 'auth/email-already-exists'; throw e; }
            const uid = 'auth' + (++n);
            state.users[uid] = { uid, email: props.email, password: props.password, disabled: props.disabled };
            state.created.push(Object.assign({ uid }, props));
            return { uid };
        },
        async importUsers(records, opts) {
            state.imported.push({ records, opts });
            records.forEach(r => { state.users[r.uid] = { uid: r.uid, email: r.email, imported: true }; });
            return { successCount: records.length, failureCount: 0, errors: [] };
        },
        async updateUser(uid, props) { state.updated.push({ uid, props }); Object.assign(state.users[uid], props); return { uid }; },
        async getUserByEmail(email) { const u = byEmail(email); if (!u) { const e = new Error('nf'); e.code = 'auth/user-not-found'; throw e; } return u; },
        async deleteUser(uid) { state.deleted.push(uid); delete state.users[uid]; }
    };
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

// A small legacy dataset with the drift cases from design 9.
function legacyFixture() {
    return {
        teams: {
            tA: { id: 'tA', name: 'Team A', createdBy: 'Akshay Gurav', createdAt: '2026-01-01T00:00:00Z' },
            tB: { id: 'tB', name: 'Team B', createdBy: 'Akshay Gurav', createdAt: '2026-01-01T00:00:00Z' }
        },
        settings: { everyoneSeesAll: false },
        teamMembers: ['Akshay Gurav', 'Admin One', 'Mgr One', 'Emp One', 'J.R. Smith', 'Roster Only'],
        admins: ['Akshay Gurav', 'Admin One'],
        managers: ['Mgr One'],
        memberTeams: { 'Admin One': 'tA', 'Mgr One': 'tA', 'Emp One': 'tA', 'J___DOT___R___DOT___ Smith': 'tB', 'Roster Only': 'tB', 'Gone Person': 'tA' },
        users: {
            'Akshay Gurav': { name: 'Akshay Gurav', passwordHash: HASH_A, username: 'agurav', isAdmin: true, isSuperAdmin: true, registeredAt: '2026-01-01T00:00:00Z' },
            'Admin One': { name: 'Admin One', passwordHash: HASH_B, username: 'aone', isAdmin: true, registeredAt: '2026-01-02T00:00:00Z', teamId: 'tA' },
            'Mgr One': { name: 'Mgr One', passwordHash: HASH_C, username: 'mone', isAdmin: false, registeredAt: '2026-01-03T00:00:00Z' },
            'Emp One': { name: 'Emp One', passwordHash: HASH_A, isAdmin: false },
            'J___DOT___R___DOT___ Smith': { name: 'J.R. Smith', passwordHash: 'not-a-hash', username: 'jsmith', registeredAt: '2026-01-04T00:00:00Z' },
            'Gone Person': { name: 'Gone Person', passwordHash: HASH_B, username: 'gperson', isAdmin: true, terminated: true, terminatedAt: '2026-02-01T00:00:00Z', registeredAt: '2026-01-05T00:00:00Z' },
            'Roster Only': { teamId: 'tB' }
        },
        appData: {
            attendance: {
                'Emp One': { '2026-03-02': true, '2026-03-03': true },
                'Gone Person': { '2026-01-10': true },
                'Old Name': { '2026-01-11': true }
            },
            leaves: { 'Emp One': { '2026-03-04': 'wfh' }, 'J___DOT___R___DOT___ Smith': { '2026-03-05': 'planned' } },
            holidays: [{ date: '2026-12-25', name: 'Christmas' }, { date: '2026-01-26', name: 'Republic Day' }, { date: '2026-12-25', name: 'Xmas dup' }]
        }
    };
}

function tmpDir(withGitignore) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-test-'));
    if (withGitignore !== false) {
        fs.writeFileSync(path.join(d, '.gitignore'), withGitignore === 'partial' ? 'node_modules/\n' : 'migration-temp-passwords-*\nmigration-state.json\nmigration-*.csv\n');
    }
    return d;
}

function makeCtx(db, auth, dir, extraEnv) {
    const out = [];
    return {
        out: l => out.push(String(l)), lines: out,
        now: (() => { let i = 0; return () => new Date(Date.UTC(2026, 5, 1, 0, 0, i++)).toISOString(); })(),
        cwd: dir, env: Object.assign({ MIGRATION_STATE_SECRET: 'test-secret', MIGRATION_CSV_PASSPHRASE: 'pass phrase' }, extraEnv || {}),
        prompt: async () => 'prompted',
        appJsPath: path.join(__dirname, '..', '..', '..', 'app.js'),
        db, auth
    };
}

module.exports = { fakeDb, fakeAuth, legacyFixture, tmpDir, makeCtx, HASH_A, HASH_B, HASH_C, getIn };
