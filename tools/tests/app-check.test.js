'use strict';
// App Check is optional: empty key => nothing loaded or called; key => activated once.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'app-check-init.js'), 'utf8');

function env(keyDecl, opts = {}) {
    const calls = { writes: [], activate: [] };
    const firebase = {};
    const sandbox = { firebase, console, document: { write: s => calls.writes.push(s) } };
    if (opts.throwOnWrite) sandbox.document.write = () => { throw new Error('blocked'); };
    const ctx = vm.createContext(sandbox);
    if (keyDecl !== null) vm.runInContext(keyDecl, ctx);
    const run = () => vm.runInContext(SRC, ctx, { filename: 'app-check-init.js' });
    const installSdk = () => { firebase.appCheck = () => ({ activate: (...a) => calls.activate.push(a) }); };
    return { calls, run, installSdk };
}

test('config ships with an empty key and index.html wires the file after firebase-config.js', () => {
    assert.ok(/const APP_CHECK_SITE_KEY = "";/.test(fs.readFileSync(path.join(ROOT, 'firebase-config.js'), 'utf8')));
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(html.indexOf('firebase-config.js') < html.indexOf('app-check-init.js'));
    assert.ok(html.indexOf('app-check-init.js') < html.indexOf('src="app.js"'));
    assert.ok(!/app-check-compat/.test(html), 'SDK must not be a static tag');
});

test('empty key: nothing loaded, nothing activated', () => {
    const e = env('const APP_CHECK_SITE_KEY = "";');
    e.run();
    assert.deepStrictEqual(e.calls.writes, []);
    assert.deepStrictEqual(e.calls.activate, []);
});

test('missing or blank key behaves as disabled', () => {
    for (const decl of [null, 'const APP_CHECK_SITE_KEY = "   ";']) {
        const e = env(decl);
        e.run();
        assert.deepStrictEqual(e.calls.writes, []);
        assert.deepStrictEqual(e.calls.activate, []);
    }
});

test('key set: pass 1 writes the 9.23.0 SDK tag, pass 2 activates once with that key', () => {
    const e = env('const APP_CHECK_SITE_KEY = "site-key-123";');
    e.run();
    assert.strictEqual(e.calls.writes.length, 2);
    assert.ok(e.calls.writes[0].includes('firebasejs/9.23.0/firebase-app-check-compat.js'));
    assert.ok(e.calls.writes[1].includes('app-check-init.js'));
    assert.strictEqual(e.calls.activate.length, 0);
    e.installSdk();
    e.run();
    e.run(); // a repeat must not activate again
    assert.deepStrictEqual(e.calls.activate, [['site-key-123', true]]);
});

test('SDK load failure is tolerated (no throw, no activate, no write loop)', () => {
    const e = env('const APP_CHECK_SITE_KEY = "site-key-123";');
    e.run();
    assert.doesNotThrow(() => e.run()); // second pass, SDK absent
    assert.strictEqual(e.calls.writes.length, 2);
    assert.strictEqual(e.calls.activate.length, 0);
});

test('errors while writing or activating are swallowed', () => {
    const a = env('const APP_CHECK_SITE_KEY = "k";', { throwOnWrite: true });
    assert.doesNotThrow(() => a.run());
    const b = env('const APP_CHECK_SITE_KEY = "k";');
    b.run();
    b.calls.activate.push = () => { throw new Error('x'); };
    b.installSdk();
    assert.doesNotThrow(() => b.run());
});
