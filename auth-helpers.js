// ==========================================
// AUTH HELPERS (secure mode, design 4.0 / 4.1 / 4.3)
// Pure functions, no DOM and no Firebase. Loaded in the browser as the global
// `AuthHelpers` and require()-able from Node for unit tests.
// ==========================================
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.AuthHelpers = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const AUTH_EMAIL_DOMAIN = 'attendance.local';
    const MIN_PASSWORD_LENGTH = 6; // Firebase Auth minimum (design 4.7)
    const MAX_NAME_LENGTH = 100;
    const MAX_KEY_LENGTH = 128;
    // eslint-disable-next-line no-control-regex
    const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
    const FORBIDDEN_NAME_CHARS = /[$#\[\]\/]/;

    // Only the exact string "secure" selects secure mode (design 4.0).
    function resolveMode(value) {
        return value === 'secure' ? 'secure' : 'legacy';
    }

    // Lowercase, keep [a-z0-9._-], collapse repeated dots, trim leading/trailing dots.
    function normalizeUsername(input) {
        return String(input == null ? '' : input)
            .toLowerCase()
            .replace(/[^a-z0-9._-]/g, '')
            .replace(/\.{2,}/g, '.')
            .replace(/^\.+|\.+$/g, '');
    }

    function authEmail(username) {
        const n = normalizeUsername(username);
        return n ? n + '@' + AUTH_EMAIL_DOMAIN : '';
    }

    function usernameFromEmail(email) {
        const s = String(email || '');
        const at = s.lastIndexOf('@');
        return at > 0 ? s.slice(0, at) : s;
    }

    function nameParts(fullName) {
        const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
        return parts.map(p => p.replace(/\./g, '').toLowerCase());
    }

    // Same shape as the legacy generateUsername(): first initial + last name.
    function generateUsername(fullName) {
        const parts = nameParts(fullName);
        if (parts.length === 0) return '';
        if (parts.length === 1) return parts[0];
        const first = parts[0];
        const last = parts[parts.length - 1];
        return (first[0] || '') + last;
    }

    // First two letters of the first name + last name (legacy fallback).
    function altUsername(fullName) {
        const parts = nameParts(fullName);
        if (parts.length === 0) return '';
        if (parts.length === 1) return parts[0];
        return parts[0].substring(0, 2) + parts[parts.length - 1];
    }

    function unique(list) {
        const out = [];
        list.forEach(v => { if (v && !out.includes(v)) out.push(v); });
        return out;
    }

    // Login: try the input itself, then the generated username, then first-two + last.
    function loginCandidates(input) {
        return unique([
            normalizeUsername(input),
            normalizeUsername(generateUsername(input)),
            normalizeUsername(altUsername(input))
        ]);
    }

    // Registration: generated, first-two + last, then base + random 2 digits, up to `max`.
    function registrationCandidates(fullName, randomFn, max) {
        const limit = max || 10;
        const rand = randomFn || Math.random;
        const gen = normalizeUsername(generateUsername(fullName));
        const alt = normalizeUsername(altUsername(fullName));
        const base = alt || gen || 'member';
        const list = unique([gen || 'member', alt]);
        let guard = 0;
        while (list.length < limit && guard < limit * 20) {
            guard++;
            const suffix = String(Math.floor(rand() * 100)).padStart(2, '0');
            const cand = base + suffix;
            if (!list.includes(cand)) list.push(cand);
        }
        return list.slice(0, limit);
    }

    // Strip control characters and surrounding whitespace from a display name.
    function cleanName(name) {
        return String(name == null ? '' : name).replace(CONTROL_CHARS, '').trim();
    }

    // memberKey for secure mode: legacy nameKey with control characters removed
    // (KEYRE control-character fallback, rules/RESULTS.md).
    function secureNameKey(name) {
        return cleanName(name).replace(/\./g, '___DOT___');
    }

    function decodeKey(key) {
        return String(key == null ? '' : key).replace(/___DOT___/g, '.');
    }

    function isValidMemberKey(key) {
        return typeof key === 'string' && key.length >= 1 && key.length <= MAX_KEY_LENGTH &&
            /^[^$#\[\]\/.]+$/.test(key) && !/[\u0000-\u001f\u007f]/.test(key);
    }

    // Returns an error message or '' when the name can be registered.
    function validateName(name) {
        const n = cleanName(name);
        if (!n) return 'Please enter your full name.';
        if (n.length > MAX_NAME_LENGTH) return 'Name must be ' + MAX_NAME_LENGTH + ' characters or fewer.';
        if (FORBIDDEN_NAME_CHARS.test(n)) return 'Name cannot contain $ # [ ] or /.';
        if (!isValidMemberKey(secureNameKey(n))) return 'Name is too long.';
        return '';
    }

    function validateNewPassword(password, confirm) {
        if (!password) return 'Please enter a password.';
        if (password.length < MIN_PASSWORD_LENGTH) return 'Password must be at least ' + MIN_PASSWORD_LENGTH + ' characters.';
        if (confirm !== undefined && password !== confirm) return 'Passwords do not match.';
        return '';
    }

    // Error codes that mean "try the next username candidate" at login.
    const ADVANCE_CODES = [
        'auth/invalid-credential', 'auth/invalid-login-credentials',
        'auth/user-not-found', 'auth/invalid-email', 'auth/wrong-password'
    ];

    function shouldTryNextCandidate(code) {
        return ADVANCE_CODES.includes(code);
    }

    function loginErrorMessage(code) {
        if (shouldTryNextCandidate(code)) return 'Incorrect username or password.';
        if (code === 'auth/too-many-requests') return 'Too many attempts. Try again later.';
        if (code === 'auth/network-request-failed') return 'Connection error. Please try again.';
        if (code === 'auth/user-disabled') return 'Your account has been terminated. Contact admin.';
        return 'Connection error. Please try again.';
    }

    return {
        AUTH_EMAIL_DOMAIN, MIN_PASSWORD_LENGTH, MAX_NAME_LENGTH, MAX_KEY_LENGTH,
        resolveMode, normalizeUsername, authEmail, usernameFromEmail,
        generateUsername, altUsername, loginCandidates, registrationCandidates,
        cleanName, secureNameKey, decodeKey, isValidMemberKey, validateName,
        validateNewPassword, shouldTryNextCandidate, loginErrorMessage
    };
});
