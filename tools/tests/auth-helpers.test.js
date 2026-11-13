'use strict';
const test = require('node:test');
const assert = require('node:assert');
const H = require('../../auth-helpers.js');

test('resolveMode: only the exact string "secure" selects secure', () => {
    assert.strictEqual(H.resolveMode('secure'), 'secure');
    for (const v of [undefined, null, '', 'Secure', 'SECURE', ' secure', true, 1, 'legacy', {}]) {
        assert.strictEqual(H.resolveMode(v), 'legacy', String(v));
    }
});

test('normalizeUsername: lowercase, strip, collapse and trim dots', () => {
    assert.strictEqual(H.normalizeUsername('J..Smith'), 'j.smith');
    assert.strictEqual(H.normalizeUsername('..akshay..'), 'akshay');
    assert.strictEqual(H.normalizeUsername('.a...b.'), 'a.b');
    assert.strictEqual(H.normalizeUsername('Ánna Ö'), 'nna');
    assert.strictEqual(H.normalizeUsername('Üß'), '');
    assert.strictEqual(H.normalizeUsername(''), '');
    assert.strictEqual(H.normalizeUsername(null), '');
    assert.strictEqual(H.normalizeUsername('a_b-c.9'), 'a_b-c.9');
    assert.strictEqual(H.normalizeUsername('a b$c#d'), 'abcd');
});

test('authEmail uses the non-routable domain and never builds an empty local part', () => {
    assert.strictEqual(H.authEmail('AGurav'), 'agurav@attendance.local');
    assert.strictEqual(H.authEmail('..'), '');
    assert.strictEqual(H.authEmail('Üß'), '');
    assert.strictEqual(H.usernameFromEmail('agurav@attendance.local'), 'agurav');
});

test('generateUsername matches the legacy shape', () => {
    assert.strictEqual(H.generateUsername('Akshay Gurav'), 'agurav');
    assert.strictEqual(H.generateUsername('J. R. Smith'), 'jsmith');
    assert.strictEqual(H.generateUsername('Single'), 'single');
    assert.strictEqual(H.generateUsername(''), '');
    assert.strictEqual(H.altUsername('Akshay Gurav'), 'akgurav');
});

test('loginCandidates: input, generated, first-two + last; unique and non-empty', () => {
    assert.deepStrictEqual(H.loginCandidates('Akshay Gurav'), ['akshaygurav', 'agurav', 'akgurav']);
    assert.deepStrictEqual(H.loginCandidates('agurav'), ['agurav']);
    assert.deepStrictEqual(H.loginCandidates('  '), []);
});

test('registrationCandidates: generated, alt, then base + 2 digits, max 10, deterministic with a seeded rand', () => {
    let i = 0;
    const rand = () => [0.05, 0.05, 0.42, 0.99][i++ % 4];
    const c = H.registrationCandidates('Akshay Gurav', rand, 5);
    assert.deepStrictEqual(c.slice(0, 2), ['agurav', 'akgurav']);
    assert.strictEqual(c.length, 5);
    assert.ok(c.slice(2).every(x => /^akgurav\d{2}$/.test(x)));
    assert.strictEqual(new Set(c).size, c.length);
    const empty = H.registrationCandidates('Üß', () => 0.1, 3);
    assert.strictEqual(empty[0], 'member');
});

test('secureNameKey strips control characters and encodes dots', () => {
    assert.strictEqual(H.secureNameKey('J.R. Smith'), 'J___DOT___R___DOT___ Smith');
    assert.strictEqual(H.secureNameKey('A\u0001B\u007f'), 'AB');
    assert.strictEqual(H.decodeKey('J___DOT___R'), 'J.R');
});

test('validateName and isValidMemberKey', () => {
    assert.strictEqual(H.validateName(''), 'Please enter your full name.');
    assert.ok(H.validateName('a/b'));
    assert.ok(H.validateName('a$b'));
    assert.ok(H.validateName('x'.repeat(101)));
    assert.strictEqual(H.validateName('Akshay Gurav'), '');
    assert.ok(H.isValidMemberKey('Akshay Gurav'));
    assert.ok(!H.isValidMemberKey('a.b'));
    assert.ok(!H.isValidMemberKey(''));
    assert.ok(!H.isValidMemberKey('x'.repeat(129)));
});

test('password policy: minimum 6 and confirmation', () => {
    assert.ok(H.validateNewPassword('12345'));
    assert.strictEqual(H.validateNewPassword('123456', '123456'), '');
    assert.strictEqual(H.validateNewPassword('123456', '1234567'), 'Passwords do not match.');
});

test('login error mapping: one message for wrong user or password', () => {
    for (const c of ['auth/invalid-credential', 'auth/invalid-login-credentials', 'auth/user-not-found', 'auth/invalid-email']) {
        assert.ok(H.shouldTryNextCandidate(c));
        assert.strictEqual(H.loginErrorMessage(c), 'Incorrect username or password.');
    }
    assert.strictEqual(H.loginErrorMessage('auth/too-many-requests'), 'Too many attempts. Try again later.');
    assert.strictEqual(H.loginErrorMessage('auth/network-request-failed'), 'Connection error. Please try again.');
    assert.ok(!H.shouldTryNextCandidate('auth/too-many-requests'));
});
