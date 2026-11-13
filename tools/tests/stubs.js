'use strict';
// In-memory stand-ins for the compat Realtime Database and Auth APIs used by
// secure-flows.js. `deny(op, path, value)` returning true simulates a rules denial.

function err(code) { const e = new Error(code); e.code = code; return e; }

function split(p) { return String(p || '').split('/').filter(Boolean); }

function getIn(tree, path) {
    let cur = tree;
    for (const part of split(path)) {
        if (cur == null || typeof cur !== 'object') return null;
        cur = cur[part];
    }
    return cur === undefined ? null : cur;
}

function prune(tree, parts) {
    if (parts.length === 0) return;
    const parent = getIn(tree, parts.slice(0, -1).join('/'));
    if (parent && typeof parent === 'object' && parent[parts[parts.length - 1]] &&
        typeof parent[parts[parts.length - 1]] === 'object' &&
        Object.keys(parent[parts[parts.length - 1]]).length === 0) {
        delete parent[parts[parts.length - 1]];
        prune(tree, parts.slice(0, -1));
    }
}

function setIn(tree, path, value) {
    const parts = split(path);
    let cur = tree;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (value === null || value === undefined) { delete cur[last]; prune(tree, parts.slice(0, -1)); }
    else cur[last] = JSON.parse(JSON.stringify(value));
}

function makeDb(initial, deny) {
    const state = { tree: JSON.parse(JSON.stringify(initial || {})), writes: [], reads: [] };
    const check = (op, path, value) => { if (deny && deny(op, path, value, state)) throw err('PERMISSION_DENIED'); };
    function ref(path) {
        const p = split(path).join('/');
        return {
            async once() {
                check('read', p);
                state.reads.push(p);
                const v = getIn(state.tree, p);
                return { val: () => (v === null ? null : JSON.parse(JSON.stringify(v))), exists: () => v !== null };
            },
            async set(value) {
                check('write', p, value);
                state.writes.push({ op: 'set', path: p, value });
                setIn(state.tree, p, value);
            },
            async remove() {
                check('write', p, null);
                state.writes.push({ op: 'remove', path: p });
                setIn(state.tree, p, null);
            },
            async update(values) {
                Object.keys(values).forEach(k => check('write', (p ? p + '/' : '') + k, values[k]));
                state.writes.push({ op: 'update', path: p, value: values });
                Object.keys(values).forEach(k => setIn(state.tree, (p ? p + '/' : '') + k, values[k]));
            },
            push() { return { key: 'push' + Math.random().toString(36).slice(2, 8) }; }
        };
    }
    return { ref, state, get: p => getIn(state.tree, p) };
}

// Auth stub. `accounts` maps email -> { password, uid }.
function makeAuth(accounts, opts) {
    const o = opts || {};
    const state = { accounts: Object.assign({}, accounts || {}), currentUser: null, signedOut: 0, deleted: [], persistence: null, calls: [] };
    let counter = 0;
    function userFor(email, uid) {
        const user = {
            uid, email,
            async delete() {
                if (o.failDelete) throw err('auth/requires-recent-login');
                state.deleted.push(uid);
                delete state.accounts[email];
                state.currentUser = null;
            },
            async updatePassword(pw) {
                state.calls.push('updatePassword');
                if (o.requireRecentLoginOnce && !state.reauthed) throw err('auth/requires-recent-login');
                state.accounts[email].password = pw;
            },
            async reauthenticateWithCredential(cred) {
                state.calls.push('reauth');
                if (!state.accounts[email] || state.accounts[email].password !== cred.password) throw err('auth/invalid-credential');
                state.reauthed = true;
            }
        };
        return user;
    }
    return {
        state,
        get currentUser() { return state.currentUser; },
        async setPersistence(p) { state.persistence = p; },
        async signInWithEmailAndPassword(email, password) {
            state.calls.push('signIn:' + email);
            if (o.signInError) throw err(o.signInError);
            if (!email || !/@/.test(email)) throw err('auth/invalid-email');
            const a = state.accounts[email];
            if (!a || a.password !== password) throw err('auth/invalid-credential');
            state.currentUser = userFor(email, a.uid);
            return { user: state.currentUser };
        },
        async createUserWithEmailAndPassword(email, password) {
            state.calls.push('create:' + email);
            if (state.accounts[email]) throw err('auth/email-already-in-use');
            if (password.length < 6) throw err('auth/weak-password');
            const uid = 'uid' + (++counter);
            state.accounts[email] = { password, uid };
            state.currentUser = userFor(email, uid);
            return { user: state.currentUser };
        },
        async signOut() { state.signedOut++; state.currentUser = null; }
    };
}

module.exports = { makeDb, makeAuth, getIn, err };
