'use strict';
// The client carries no Superuser name. Legacy mode learns the Superuser from the
// single users/* record with isSuperAdmin === true; secure mode from usersV2.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SCRIPTS = ['auth-helpers.js', 'data-paths.js', 'secure-flows.js', 'permissions.js', 'secure-mode.js', 'app.js'];
const sha256 = s => nodeCrypto.createHash('sha256').update(s).digest('hex');

test('source scan: no SUPER_ADMIN constant or literal Superuser name in client files', () => {
    for (const f of ['app.js', 'secure-mode.js', 'permissions.js', 'index.html', 'firebase-config.js']) {
        const src = read(f);
        assert.ok(!/SUPER_ADMIN/.test(src), f + ' mentions SUPER_ADMIN');
        assert.ok(!/Akshay|Gurav|agurav/i.test(src), f + ' contains a literal Superuser name');
    }
    assert.ok(!/\$\{SUPER/.test(read('index.html')));
});

function legacyEnv(users) {
    const writes = [];
    const storage = {};
    const els = {};
    const element = id => els[id] || (els[id] = {
        id, value: '', checked: false, textContent: '', innerHTML: '', style: {}, dataset: {},
        classList: { add() {}, remove() {}, contains: () => false }, addEventListener() {}, appendChild() {}, remove() {}
    });
    const snap = v => ({ val: () => (v === undefined ? null : JSON.parse(JSON.stringify(v))), exists: () => v != null });
    const ref = p => ({
        set: v => { writes.push(['set', p]); return Promise.resolve(v); },
        remove: () => { writes.push(['remove', p]); return Promise.resolve(); },
        update: v => { writes.push(['update', p, Object.keys(v || {})]); return Promise.resolve(); },
        on() {}, off() {},
        once: () => Promise.resolve(snap(p === 'users' ? users : null)),
        push: () => ({ key: 'k' })
    });
    const authFn = () => ({ onAuthStateChanged() {}, signOut: () => Promise.resolve(), currentUser: null });
    authFn.Auth = { Persistence: { LOCAL: 'local', SESSION: 'session' } };
    const sandbox = {
        firebase: { initializeApp: c => ({ c }), database: () => ({ ref }), auth: authFn },
        console: { log() {}, error() {}, warn() {} },
        document: { getElementById: element, addEventListener() {}, querySelectorAll: () => [], createElement: () => element('n'), body: { classList: { add() {}, remove() {} } } },
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
    vm.runInContext(read('firebase-config.js'), ctx, { filename: 'firebase-config.js' });
    for (const f of SCRIPTS) vm.runInContext(read(f), ctx, { filename: f });
    const run = code => vm.runInContext(code, ctx);
    return { ctx, run, storage, element, writes };
}

const USERS = {
    'Sue Super': { name: 'Sue Super', username: 'ssuper', isAdmin: true, isSuperAdmin: true, passwordHash: sha256('pw') },
    'Bob Plain': { name: 'Bob Plain', username: 'bplain', isAdmin: false, passwordHash: sha256('pw') }
};

test('legacy: nobody is the Superuser until the record is loaded, then only the flagged user', async () => {
    const env = legacyEnv(USERS);
    env.storage.attendance_current_user = 'Sue Super';
    assert.strictEqual(env.run('isSuperUser()'), false, 'fails closed before loading');
    assert.strictEqual(env.run('isAdmin()'), false);
    await env.run('loadLegacySuper()');
    assert.strictEqual(env.run('isSuperUser()'), true);
    assert.strictEqual(env.run('isAdmin()'), true);
    assert.strictEqual(env.run("memberIsSuper('Sue Super')"), true);
    assert.strictEqual(env.run("memberIsSuper('Bob Plain')"), false);
    assert.strictEqual(env.run("canAdminMember('Sue Super')"), true);
    env.storage.attendance_current_user = 'Bob Plain';
    assert.strictEqual(env.run('isSuperUser()'), false);
    assert.strictEqual(env.run("canAdminMember('Sue Super')"), false, 'a non-Superuser cannot administer the Superuser');
    assert.strictEqual(env.run("canSelfAssignTeam('Sue Super')"), false);
});

test('legacy: a localStorage user without an isSuperAdmin record is not the Superuser', async () => {
    const env = legacyEnv({ 'Bob Plain': USERS['Bob Plain'] });
    env.storage.attendance_current_user = 'Anyone Else';
    await env.run('loadLegacySuper()');
    assert.strictEqual(env.run('isSuperUser()'), false);
    assert.strictEqual(env.run('isAdmin()'), false);
    assert.strictEqual(env.run('LEGACY_SUPER_NAME'), null);
});

test('legacy: two isSuperAdmin records resolve to nobody (fail closed)', async () => {
    const two = Object.assign({}, USERS, { 'Eve Two': { name: 'Eve Two', isSuperAdmin: true } });
    const env = legacyEnv(two);
    env.storage.attendance_current_user = 'Sue Super';
    await env.run('loadLegacySuper()');
    assert.strictEqual(env.run('isSuperUser()'), false);
});

test('legacy: the saved admin list is not extended with a hardcoded name', () => {
    const env = legacyEnv({});
    assert.strictEqual(env.run('JSON.stringify(getAdminList())'), '[]');
    env.storage.attendance_admin_list = JSON.stringify(['Bob Plain']);
    assert.strictEqual(env.run('JSON.stringify(getAdminList())'), '["Bob Plain"]');
});

function loginThis(env) {
    return env.run(`Object.assign(Object.create(App.prototype), {
        unlockApp() {}, updateUserDisplay() {}, ensureSelectedVisible() {}, updateUIPermissions() {},
        renderTeamList() {}, renderCalendar() {}, checkEmailReminder() {}, selectedMember: ''
    })`);
}

test('legacy login: an unknown name is refused and writes no users/* record (no first-login bootstrap)', async () => {
    const env = legacyEnv({ 'Bob Plain': USERS['Bob Plain'] });
    env.element('loginUsername').value = 'Sue Super';
    env.element('loginPassword').value = 'pw';
    const self = loginThis(env);
    env.ctx.__self = self;
    await env.run('App.prototype.handleLogin.call(__self)');
    assert.ok(/not found|not registered/i.test(env.element('loginError').textContent), env.element('loginError').textContent);
    assert.strictEqual(env.writes.filter(w => /^users/.test(w[1])).length, 0);
    assert.strictEqual(env.storage.attendance_current_user, undefined);
});

test('legacy login: a registered user without a password hash is refused and nothing is written', async () => {
    const env = legacyEnv({ 'Sue Super': { name: 'Sue Super', username: 'ssuper', isSuperAdmin: true, isAdmin: true } });
    env.element('loginUsername').value = 'ssuper';
    env.element('loginPassword').value = 'pw';
    env.ctx.__self = loginThis(env);
    await env.run('App.prototype.handleLogin.call(__self)');
    assert.ok(/not registered/i.test(env.element('loginError').textContent));
    assert.strictEqual(env.writes.filter(w => /^users/.test(w[1])).length, 0);
});

test('legacy login: a correct password learns the Superuser from the records', async () => {
    const env = legacyEnv(USERS);
    env.element('loginUsername').value = 'ssuper';
    env.element('loginPassword').value = 'pw';
    env.ctx.__self = loginThis(env);
    await env.run('App.prototype.handleLogin.call(__self)');
    assert.strictEqual(env.storage.attendance_current_user, 'Sue Super');
    assert.strictEqual(env.run('isSuperUser()'), true);
});

test('legacy: lockApp forgets the Superuser and the admin list', async () => {
    const env = legacyEnv(USERS);
    env.storage.attendance_current_user = 'Sue Super';
    await env.run('loadLegacySuper()');
    assert.strictEqual(env.run('isSuperUser()'), true);
    env.ctx.__self = env.run(`Object.assign(Object.create(App.prototype), {
        data: { stopListeners() {}, reset() {} }, applyRoleVisibility() {}, clearTeamOptions() {}, loadTeamOptions() {}
    })`);
    env.run('App.prototype.lockApp.call(__self)');
    assert.strictEqual(env.run('LEGACY_SUPER_NAME'), null);
    assert.strictEqual(env.run('JSON.stringify(ADMIN_MEMBERS)'), '[]');
    assert.strictEqual(env.run('isSuperUser()'), false);
});
