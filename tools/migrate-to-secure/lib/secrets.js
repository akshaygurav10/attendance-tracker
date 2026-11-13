'use strict';
// Temporary passwords, the temp-password CSV (plain or AES-256-GCM), HMAC
// fingerprints for migration-state.json, and the .gitignore precondition.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function tempPassword(length, randomBytes) {
    const n = Math.max(16, length || 16);
    const rb = randomBytes || crypto.randomBytes;
    const bytes = rb(n * 2);
    let out = '';
    for (let i = 0; out.length < n && i < bytes.length; i++) {
        const b = bytes[i];
        if (b < 256 - (256 % ALPHABET.length)) out += ALPHABET[b % ALPHABET.length];
    }
    while (out.length < n) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
    return out;
}

function randomUid() {
    return crypto.randomBytes(21).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 28).padEnd(28, '0');
}

function fingerprint(secret, legacyHash) {
    return crypto.createHmac('sha256', String(secret)).update(String(legacyHash || '')).digest('hex');
}

function csvEscape(v) {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(header, rows) {
    return [header.join(',')].concat(rows.map(r => r.map(csvEscape).join(','))).join('\n') + '\n';
}

function encrypt(text, passphrase) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(String(passphrase), salt, 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, alg: 'aes-256-gcm', kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}

function decrypt(blob, passphrase) {
    const o = JSON.parse(blob);
    const key = crypto.scryptSync(String(passphrase), Buffer.from(o.salt, 'base64'), 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(o.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(o.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(o.data, 'base64')), decipher.final()]).toString('utf8');
}

// Walk up from `dir` to find .gitignore; require the migration artifact patterns.
const REQUIRED_IGNORES = ['migration-temp-passwords-*', 'migration-state.json'];
function checkGitignore(dir) {
    let cur = path.resolve(dir || process.cwd());
    for (;;) {
        const f = path.join(cur, '.gitignore');
        if (fs.existsSync(f)) {
            const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).map(s => s.trim());
            const missing = REQUIRED_IGNORES.filter(p => !lines.includes(p));
            return { ok: missing.length === 0, file: f, missing };
        }
        const parent = path.dirname(cur);
        if (parent === cur) return { ok: false, file: null, missing: REQUIRED_IGNORES.slice() };
        cur = parent;
    }
}

module.exports = { tempPassword, randomUid, fingerprint, toCsv, encrypt, decrypt, checkGitignore, REQUIRED_IGNORES };
