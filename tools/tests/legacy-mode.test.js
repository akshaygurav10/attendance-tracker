'use strict';
// Loads the real browser scripts into a Node vm context with a stubbed
// `firebase` global and checks the mode selection and the legacy path:
// no Auth instance, connectionTest still written, current user from localStorage.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SCRIPTS = ['auth-helpers.js', 'data-paths.js', 'secure-flows.js', 'permissions.js', 'secure-mode.js', 'app.js'];

function makeContext() {
    const calls = { auth: 0, sets: [], on: [], domReady: 0 };
    const storage = {};
    const ref = p => ({
        set: v => { calls.sets.push(p); return Promise.resolve(v); },
        on: () => { calls.on.push(p); },
        off: () => {},
        once: () => Promise.resolve({ val: () => null }),
        update: () => Promise.resolve(),
        push: () => ({ key: 'k' })
    });
    const authFn = () => { calls.auth++; return { onAuthStateChanged() {}, signOut: () => Promise.resolve(), currentUser: null }; };
    authFn.Auth = { Persistence: { LOCAL: 'local', SESSION: 'session' } };
    const firebase = {
        initializeApp: cfg => ({ cfg }),
        database: () => ({ ref }),
        auth: authFn
    };
    const sandbox = {
        firebase, console,
        document: {
            getElementById: () => null,
            addEventListener: (ev) => { if (ev === 'DOMContentLoaded') calls.domReady++; },
            querySelectorAll: () => [],
            body: { classList: { add() {}, remove() {} } }
        },
        localStorage: {
            getItem: k => (k in storage ? storage[k] : null),
            setItem: (k, v) => { storage[k] = String(v); },
            removeItem: k => { delete storage[k]; }
        },
        sessionStorage: { clear() {} },
        window: { addEventListener() {} },
        alert() {}, confirm: () => false, prompt: () => null,
        setTimeout, TextEncoder, crypto: globalThis.crypto
    };
    sandbox.self = sandbox;
    const ctx = vm.createContext(sandbox);
    return { ctx, calls, storage };
}

function load(configSource) {
    const env = makeContext();
    vm.runInContext(configSource, env.ctx, { filename: 'firebase-config.js' });
    for (const f of SCRIPTS) vm.runInContext(read(f), env.ctx, { filename: f });
    return env;
}

test('legacy (default config): MODE legacy, no Auth instance, connectionTest written', () => {
    const config = read('firebase-config.js');
    assert.ok(/const SECURITY_MODE = "legacy";/.test(config), 'default flag must be "legacy"');
    const env = load(config);
    assert.strictEqual(vm.runInContext('MODE', env.ctx), 'legacy');
    assert.strictEqual(env.calls.auth, 0, 'firebase.auth() must not be called in legacy mode');
    assert.strictEqual(vm.runInContext('firebaseAuth', env.ctx), null);
    assert.ok(env.calls.sets.includes('connectionTest'));
    assert.ok(env.calls.on.includes('.info/connected'));
    assert.strictEqual(env.calls.domReady, 1);
});

test('legacy: current user and roles still come from localStorage and the legacy arrays', () => {
    const env = load(read('firebase-config.js'));
    env.storage.attendance_current_user = 'Some One';
    assert.strictEqual(vm.runInContext('getCurrentUser()', env.ctx), 'Some One');
    assert.strictEqual(vm.runInContext('isAdmin()', env.ctx), false);
    vm.runInContext('ADMIN_MEMBERS = ["Some One"]; MANAGERS = ["Some One"]', env.ctx);
    assert.strictEqual(vm.runInContext('isAdmin()', env.ctx), true);
    assert.strictEqual(vm.runInContext('isManager()', env.ctx), true);
    // No name is the Superuser until a users/* record with isSuperAdmin === true is loaded
    env.storage.attendance_current_user = 'Some One';
    assert.strictEqual(vm.runInContext('isSuperUser()', env.ctx), false);
});

test('old cached firebase-config.js without the flag runs legacy', () => {
    const old = read('firebase-config.js')
        .replace(/const SECURITY_MODE = "legacy";/, '')
        .replace(/const firebaseAuth[\s\S]*?: null;/, '');
    const env = load(old);
    assert.strictEqual(vm.runInContext('MODE', env.ctx), 'legacy');
    assert.strictEqual(env.calls.auth, 0);
});

test('typos and non-strings are legacy; only "secure" creates Auth and skips connectionTest', () => {
    for (const v of ['"Secure"', '"SECURE"', 'true', '""', '"secure "']) {
        const env = load(read('firebase-config.js').replace('const SECURITY_MODE = "legacy";', 'const SECURITY_MODE = ' + v + ';'));
        assert.strictEqual(vm.runInContext('MODE', env.ctx), 'legacy', v);
        assert.strictEqual(env.calls.auth, 0, v);
        assert.ok(env.calls.sets.includes('connectionTest'), v);
    }
    const env = load(read('firebase-config.js').replace('const SECURITY_MODE = "legacy";', 'const SECURITY_MODE = "secure";'));
    assert.strictEqual(vm.runInContext('MODE', env.ctx), 'secure');
    assert.strictEqual(env.calls.auth, 1);
    assert.ok(!env.calls.sets.includes('connectionTest'));
    // Secure: current user is not taken from localStorage
    env.storage.attendance_current_user = 'Some One';
    assert.strictEqual(vm.runInContext('getCurrentUser()', env.ctx), null);
    assert.strictEqual(vm.runInContext('isSuperUser()', env.ctx), false);
});

test('secure mode: the legacy blob writers are no-ops', () => {
    const env = load(read('firebase-config.js').replace('const SECURITY_MODE = "legacy";', 'const SECURITY_MODE = "secure";'));
    env.calls.sets.length = 0;
    vm.runInContext('saveTeamMembers(["a"]); saveAdminList(["a"]);', env.ctx);
    assert.deepStrictEqual(env.calls.sets, []);
    assert.strictEqual(env.storage.attendance_team_members, undefined);
});

test('secure mode: lockApp cleanup drops profile state and signs out', async () => {
    const { makeEnv } = require('./secure-harness.js');
    const env = makeEnv({
        users: [{ uid: 'u1', username: 'xx', profile: { name: 'X', memberKey: 'X', isAdmin: true, teamId: 'tA' } }],
        tree: { teamData: { tA: { members: { X: { name: 'X', order: 1, uid: 'u1' } } } }, teamNames: { tA: 'Team A' } }
    });
    await env.login('xx');
    assert.strictEqual(vm.runInContext('getCurrentUser()', env.ctx), 'X');
    assert.strictEqual(vm.runInContext('isAdmin()', env.ctx), true);
    assert.strictEqual(vm.runInContext('SecureMode.snapshot().uid', env.ctx), 'u1');
    vm.runInContext('SecureMode.beforeLock()', env.ctx);
    assert.strictEqual(vm.runInContext('getCurrentUser()', env.ctx), null);
    assert.strictEqual(vm.runInContext('isAdmin()', env.ctx), false);
    assert.deepStrictEqual(vm.runInContext('JSON.stringify(SecureMode.snapshot().store)', env.ctx), '{}');
});
