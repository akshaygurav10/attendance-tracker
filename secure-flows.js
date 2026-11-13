// ==========================================
// SECURE FLOWS (secure mode, design 4.2 / 4.3 / 4.5 / 4.6)
// Sign-in, registration, post-sign-in repairs and password flows. All Firebase
// access goes through the injected `auth` / `db` objects (compat-style API), so
// the sequences can be unit tested in Node with stubs. No DOM access.
// Browser global `SecureFlows`; require()-able from Node.
// ==========================================
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./auth-helpers.js'), require('./data-paths.js'));
    } else {
        root.SecureFlows = factory(root.AuthHelpers, root.DataPaths);
    }
})(typeof self !== 'undefined' ? self : this, function (H, D) {
    'use strict';

    function code(e) { return (e && e.code) || 'unknown'; }
    function logCode(where, e) {
        // Only the error code is logged, never credentials (design 4.2).
        if (typeof console !== 'undefined') console.error(where + ': ' + code(e));
    }

    async function read(db, path) {
        const snap = await db.ref(path).once('value');
        return snap.val();
    }

    // Login candidate loop (design 4.1). Returns { ok, user } or { ok:false, code }.
    async function signIn(auth, input, password, persistence) {
        const candidates = H.loginCandidates(input);
        if (candidates.length === 0) return { ok: false, code: 'auth/invalid-credential' };
        if (persistence !== undefined && typeof auth.setPersistence === 'function') {
            await auth.setPersistence(persistence);
        }
        for (const cand of candidates) {
            try {
                const cred = await auth.signInWithEmailAndPassword(H.authEmail(cand), password);
                return { ok: true, user: cred.user, username: cand };
            } catch (e) {
                if (H.shouldTryNextCandidate(code(e))) continue;
                logCode('signIn', e);
                return { ok: false, code: code(e) };
            }
        }
        return { ok: false, code: 'auth/invalid-credential' };
    }

    async function loadProfile(db, uid) {
        return read(db, D.paths.profile(uid));
    }

    // Classify a freshly signed-in account (design 4.2 step 4/5).
    function checkProfile(profile) {
        if (!profile) return { ok: false, reason: 'missing', message: 'Account not set up. Contact admin.' };
        if (profile.terminated === true) return { ok: false, reason: 'terminated', message: 'Your account has been terminated. Contact admin.' };
        return { ok: true, mustReset: profile.mustResetPassword === true };
    }

    async function safe(fn) {
        try { await fn(); return true; } catch (e) { logCode('rollback', e); return false; }
    }

    // Four-step registration with rollback (design 4.3).
    // args: { auth, db, name, password, confirm, teamId, teamNames, nowIso, now, rand }
    async function register(args) {
        const { auth, db } = args;
        const name = H.cleanName(args.name);
        const nameErr = H.validateName(name);
        if (nameErr) return { ok: false, step: 1, message: nameErr };
        const pwErr = H.validateNewPassword(args.password, args.confirm);
        if (pwErr) return { ok: false, step: 1, message: pwErr };
        const teamNames = args.teamNames || {};
        const picked = args.teamId || '';
        if (Object.keys(teamNames).length > 0 && !picked) return { ok: false, step: 1, message: 'Please select your team.' };
        if (picked && !teamNames[picked]) return { ok: false, step: 1, message: 'Selected team no longer exists. Please pick again.' };

        const key = H.secureNameKey(name);
        const nowIso = args.nowIso || new Date().toISOString();
        const now = args.now || Date.now();

        // Step 2: create the Auth user with the first free username.
        let user = null;
        let username = '';
        for (const cand of H.registrationCandidates(name, args.rand, 10)) {
            try {
                const cred = await auth.createUserWithEmailAndPassword(H.authEmail(cand), args.password);
                user = cred.user;
                username = cand;
                break;
            } catch (e) {
                if (code(e) === 'auth/email-already-in-use') continue;
                logCode('register.create', e);
                if (code(e) === 'auth/weak-password') return { ok: false, step: 2, message: 'Password must be at least 6 characters.' };
                return { ok: false, step: 2, message: 'Connection error. Please try again.' };
            }
        }
        if (!user) return { ok: false, step: 2, message: 'Could not allocate a username. Contact admin.' };
        const uid = user.uid;

        // Step 3: claim the name.
        try {
            await db.ref('memberOwners/' + key).set(uid);
        } catch (e) {
            let owner = null;
            try { owner = await read(db, 'memberOwners/' + key); } catch (e2) { owner = null; }
            if (owner !== uid) {
                if (!(await safe(() => user.delete()))) await safe(() => auth.signOut());
                return { ok: false, step: 3, message: 'This name is already registered. Please login.' };
            }
        }

        // Step 4: create the profile (rules force non-privileged flags).
        const profile = {
            name, username, memberKey: key, isAdmin: false, isManager: false,
            terminated: false, registeredAt: nowIso
        };
        if (picked) profile.teamId = picked;
        try {
            await db.ref(D.paths.profile(uid)).set(profile);
        } catch (e) {
            logCode('register.profile', e);
            await safe(() => db.ref('memberOwners/' + key).remove());
            if (!(await safe(() => user.delete()))) await safe(() => auth.signOut());
            return { ok: false, step: 4, message: 'Registration failed. Try again.' };
        }

        // Step 5: roster entry (non-fatal; login step 6b repairs it).
        const rosterOk = await ensureRosterEntry(db, uid, profile, now);
        return { ok: true, user, uid, profile, username, rosterOk };
    }

    // Login 6b roster self-heal: create own entry or attach own uid.
    async function ensureRosterEntry(db, uid, profile, now) {
        const bucket = D.bucketOf(profile);
        const path = D.paths.member(bucket, profile.memberKey);
        try {
            const entry = await read(db, path);
            if (!entry) await db.ref(path).set(D.rosterSelfEntry(profile, uid, now || Date.now()));
            else if (!entry.uid) await db.ref(path + '/uid').set(uid);
            return true;
        } catch (e) {
            logCode('roster', e);
            return false;
        }
    }

    async function readOwnData(db, team, key) {
        const [member, attendance, leaves] = await Promise.all([
            read(db, D.paths.member(team, key)),
            read(db, D.paths.attendance(team, key)),
            read(db, D.paths.leaves(team, key))
        ]);
        return { member, attendance, leaves };
    }

    function hasAny(d) { return !!(d && (d.member || d.attendance || d.leaves)); }

    // Login 6a (team pick) and 6b (move repair, roster self-heal).
    // Returns { ok, profile, waitingForTeam, message? }.
    async function postSignIn(args) {
        const { db, uid } = args;
        let profile = Object.assign({}, args.profile);
        const key = profile.memberKey;
        const teamNames = args.teamNames || {};
        try {
            // 6a: first team pick (three ordered steps).
            if (args.pickedTeam && teamNames[args.pickedTeam] && D.canSelfAssignTeam(profile)) {
                const team = args.pickedTeam;
                const src = await readOwnData(db, D.UNASSIGNED, key);           // step 1
                await db.ref(D.paths.profile(uid) + '/teamId').set(team);       // step 2
                profile.teamId = team;
                const existing = await readOwnData(db, team, key);
                const payload = D.selfMoveStep3Payload(profile, uid, team, src, existing);
                if (Object.keys(payload).length) await db.ref().update(payload); // step 3
            }
            // 6b: move repair (own unassigned copies left behind after an interruption).
            if (D.bucketOf(profile) !== D.UNASSIGNED) {
                const src = await readOwnData(db, D.UNASSIGNED, key);
                if (hasAny(src)) {
                    const team = profile.teamId;
                    const existing = await readOwnData(db, team, key);
                    const payload = D.selfMoveStep3Payload(profile, uid, team, src, existing);
                    if (Object.keys(payload).length) await db.ref().update(payload);
                }
            }
            // 6b: roster self-heal.
            const rosterOk = await ensureRosterEntry(db, uid, profile, args.now);
            const waitingForTeam = !profile.teamId && profile.isManager === true &&
                profile.isAdmin !== true && profile.isSuperAdmin !== true;
            if (!rosterOk) return { ok: false, profile, waitingForTeam, message: 'Could not finish setting up your team. Try again.' };
            return { ok: true, profile, waitingForTeam };
        } catch (e) {
            logCode('postSignIn', e);
            return { ok: false, profile, waitingForTeam: false, message: 'Could not finish setting up your team. Try again.' };
        }
    }

    // Forced new password (design 4.6). `reauthPassword` is the password just
    // used to sign in; `makeCredential(email, password)` builds an Auth credential.
    async function completeForcedReset(args) {
        const { auth, db, uid, newPassword, reauthPassword, makeCredential } = args;
        const user = auth.currentUser;
        if (!user) return { ok: false, message: 'Please sign in again.' };
        try {
            await user.updatePassword(newPassword);
        } catch (e) {
            if (code(e) === 'auth/requires-recent-login' && reauthPassword && makeCredential) {
                await user.reauthenticateWithCredential(makeCredential(user.email, reauthPassword));
                await user.updatePassword(newPassword);
            } else {
                logCode('forcedReset', e);
                return { ok: false, code: code(e), message: code(e) === 'auth/weak-password' ? 'Password must be at least 6 characters.' : 'Could not set the new password. Try again.' };
            }
        }
        try { await db.ref(D.paths.profile(uid) + '/mustResetPassword').remove(); } catch (e) { logCode('forcedReset.flag', e); }
        return { ok: true };
    }

    // Change own password (design 4.5): reauthenticate, then update.
    async function changeOwnPassword(args) {
        const { auth, currentPassword, newPassword, makeCredential } = args;
        const user = auth.currentUser;
        if (!user) return { ok: false, message: 'Please sign in again.' };
        try {
            await user.reauthenticateWithCredential(makeCredential(user.email, currentPassword));
        } catch (e) {
            logCode('changePassword.reauth', e);
            return { ok: false, message: H.shouldTryNextCandidate(code(e)) ? 'Current password is incorrect.' : H.loginErrorMessage(code(e)) };
        }
        try {
            await user.updatePassword(newPassword);
            return { ok: true };
        } catch (e) {
            logCode('changePassword.update', e);
            return { ok: false, message: 'Could not change the password. Try again.' };
        }
    }

    // "Request password reset" (design 4.5).
    async function requestPasswordReset(db, targetUid, myUid, nowIso) {
        await db.ref(D.paths.resetRequest(targetUid)).set({ requestedBy: myUid, requestedAt: nowIso || new Date().toISOString() });
    }

    return {
        signIn, loadProfile, checkProfile, register, ensureRosterEntry, readOwnData,
        postSignIn, completeForcedReset, changeOwnPassword, requestPasswordReset
    };
});
