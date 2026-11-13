'use strict';
// Shared vm harness for secure-mode client tests: loads the real browser
// scripts with SECURITY_MODE "secure" against an in-memory Realtime Database and
// Auth stub, then signs a user in through SecureMode.login(). Not a test file.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeDb, makeAuth } = require('./stubs.js');
const H = require('../../auth-helpers.js');

const ROOT = path.join(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SCRIPTS = ['auth-helpers.js', 'data-paths.js', 'secure-flows.js', 'permissions.js', 'secure-mode.js', 'app.js'];

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function makeElement(id) {
    return {
        id, value: '', checked: false, textContent: '', innerHTML: '', style: {}, dataset: {}, children: [],
        classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
        addEventListener() {}, appendChild(c) { this.children.push(c); }, remove() {}, setAttribute() {}, focus() {}
    };
}

// users: [{ uid, username, password, profile }]; roster: { teamId: { memberKey: entry } }
function makeEnv(opts) {
    const o = opts || {};
    const tree = Object.assign({ usersV2: {}, memberOwners: {}, teamData: {}, teams: {}, teamNames: {}, settings: {}, holidays: {} }, o.tree || {});
    const accounts = {};
    (o.users || []).forEach(u => {
        accounts[H.authEmail(u.username)] = { password: u.password || 'pw123456', uid: u.uid };
        tree.usersV2[u.uid] = Object.assign({ username: u.username, terminated: false, isAdmin: false, isManager: false }, u.profile);
        tree.memberOwners[u.profile.memberKey || u.profile.name] = u.uid;
    });
    const db = makeDb(tree);
    const baseRef = db.ref;
    db.ref = p => {
        const r = baseRef(p);
        r.on = (ev, cb) => { Promise.resolve().then(() => r.once().then(snap => cb(snap))); };
        r.off = () => {};
        return r;
    };
    const auth = makeAuth(accounts);
    auth.onAuthStateChanged = () => {};
    const authFn = () => auth;
    authFn.Auth = { Persistence: { LOCAL: 'local', SESSION: 'session' } };
    authFn.EmailAuthProvider = { credential: (email, password) => ({ email, password }) };
    const firebase = { initializeApp: cfg => ({ cfg }), database: () => db, auth: authFn };

    const storage = {};
    const els = {};
    const element = id => els[id] || (els[id] = makeElement(id));
    const alerts = [];
    const sandbox = {
        firebase, console: { log() {}, error() {}, warn() {} },
        document: {
            getElementById: element, addEventListener() {}, querySelectorAll: () => [],
            createElement: () => makeElement('new'), body: { classList: { add() {}, remove() {} }, appendChild() {} }
        },
        localStorage: {
            getItem: k => (k in storage ? storage[k] : null),
            setItem: (k, v) => { storage[k] = String(v); },
            removeItem: k => { delete storage[k]; }
        },
        sessionStorage: { clear() {} },
        window: { addEventListener() {} },
        alert: m => { alerts.push(String(m)); }, confirm: () => true, prompt: () => null,
        setTimeout, TextEncoder, crypto: globalThis.crypto
    };
    sandbox.self = sandbox;
    const ctx = vm.createContext(sandbox);
    const config = read('firebase-config.js').replace('const SECURITY_MODE = "legacy";', 'const SECURITY_MODE = "secure";');
    vm.runInContext(config, ctx, { filename: 'firebase-config.js' });
    for (const f of SCRIPTS) vm.runInContext(read(f), ctx, { filename: f });

    // Minimal App stand-in: the real AttendanceData plus the render hooks SecureMode calls.
    const data = vm.runInContext('new AttendanceData(() => {})', ctx);
    const app = {
        data, selectedMember: '', rendered: 0,
        loadTheme() {}, bindEvents() {}, bindUserDisplayEvents() {}, updateTeamLabels() {},
        lockApp() { vm.runInContext('SecureMode', ctx).beforeLock(); },
        unlockApp() { vm.runInContext('SecureMode', ctx).unlockApp(app); },
        updateUserDisplay() {}, ensureSelectedVisible() {}, updateUIPermissions() {},
        renderTeamList() {}, renderCalendar() {}, renderTeamManagement() { app.rendered++; },
        checkEmailReminder() {}, applyRoleVisibility() {}
    };
    ctx.__app = app;

    async function login(username, password) {
        element('loginUsername').value = username;
        element('loginPassword').value = password || 'pw123456';
        await vm.runInContext('SecureMode', ctx).login(app);
        await flush();
    }
    const run = code => vm.runInContext(code, ctx);
    return { ctx, app, db, auth, storage, els, element, alerts, login, run, flush };
}

module.exports = { makeEnv, flush, read, ROOT };
