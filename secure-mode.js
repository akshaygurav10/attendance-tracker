// ==========================================
// SECURE MODE (browser glue; used only when MODE === 'secure')
// Implements design sections 4 and 5 on top of the existing App/AttendanceData
// classes. app.js calls into this object only behind `MODE === 'secure'`
// guards, so legacy mode never runs any of this code.
// Relies on globals from firebase-config.js (database, firebaseAuth),
// auth-helpers.js, data-paths.js, secure-flows.js and app.js (TEAM_MEMBERS,
// ADMIN_MEMBERS, MANAGERS, TEAMS, MEMBER_TEAMS, helpers).
// ==========================================
/* global firebase, database, firebaseAuth, AuthHelpers, DataPaths, SecureFlows,
   TEAM_MEMBERS, ADMIN_MEMBERS, MANAGERS, TEAMS, MEMBER_TEAMS, SUPER_ADMIN,
   escapeHtml, denyAction, canAdminTeamId, canAdminMember, getAdminScopeMembers,
   isSuperUser, nameKey */
const SecureMode = (function () {
    'use strict';
    const H = AuthHelpers;
    const D = DataPaths;
    const F = SecureFlows;

    const S = {
        app: null,
        uid: null,
        profile: null,
        store: {},
        roster: {},
        terminated: [],
        profiles: {},
        settings: {},
        planKey: '',
        fallback: false,
        deniedRetry: false,
        busy: false,
        initializing: false,
        perUid: {},
        failedLogins: 0,
        signInPassword: null
    };

    function authObj() {
        return (typeof firebaseAuth !== 'undefined' && firebaseAuth) ? firebaseAuth : null;
    }

    function makeCredential(email, password) {
        return firebase.auth.EmailAuthProvider.credential(email, password);
    }

    function el(id) { return document.getElementById(id); }

    function setSync(ok, message) {
        const indicator = el('syncIndicator');
        if (!indicator) return;
        indicator.textContent = ok ? '🟢 Synced' : '🔴 ' + message;
        indicator.className = 'sync-indicator ' + (ok ? 'connected' : 'disconnected');
        indicator.style.fontSize = '12px';
    }

    function writeFailed(e) {
        console.error('write failed: ' + ((e && e.code) || 'unknown'));
        setSync(false, 'Save failed');
    }

    // ---------- role state (read by app.js guards) ----------

    function currentUserName() {
        return S.profile && S.profile.terminated !== true ? S.profile.name : null;
    }
    function isSuper() { return !!(S.profile && S.profile.isSuperAdmin === true); }
    function isAdminUser() { return !!(S.profile && (S.profile.isAdmin === true || S.profile.isSuperAdmin === true)); }
    function isManagerUser() { return !!(S.profile && S.profile.isManager === true); }
    function memberTeamId(name) {
        if (!name) return null;
        if (S.profile && name === S.profile.name) return S.profile.teamId || null;
        return (MEMBER_TEAMS && MEMBER_TEAMS[nameKey(name)]) || null;
    }
    function canSelfAssign() { return D.canSelfAssignTeam(S.profile); }
    function adminCanEditHolidays() { return S.settings.adminCanEditHolidays === true; }
    function rosterFor(name) {
        if (S.roster[name]) return S.roster[name];
        if (S.profile && name === S.profile.name) {
            return { name, key: S.profile.memberKey, teamId: D.bucketOf(S.profile), uid: S.uid };
        }
        return null;
    }
    function hasAccount(name) { const r = rosterFor(name); return !!(r && r.uid); }

    // ---------- listeners ----------

    function planFor() {
        return D.listenerPlan(S.profile, S.settings, { fallback: S.fallback });
    }
    function keyOf(plan) {
        return [plan.role, D.bucketOf(S.profile), plan.teamWide, S.fallback].join('|');
    }

    function startListeners(data) {
        if (!S.profile || data._listeners.length > 0) return;
        const plan = planFor();
        S.planKey = keyOf(plan);
        S.perUid = {};
        const ownPath = D.paths.profile(S.uid);
        data._listen(ownPath, snap => onValue(data, ownPath, snap.val()), err => onDenied(data, ownPath, err, false));
        plan.paths.forEach(p => {
            const teamWideOptional = plan.role === 'employee' && plan.teamWide;
            data._listen(p, snap => onValue(data, p, snap.val()), err => onDenied(data, p, err, teamWideOptional));
        });
    }

    function restartListeners(data) {
        data.stopListeners();
        S.store = {};
        startListeners(data);
    }

    function attachTeamProfiles(data) {
        const plan = planFor();
        if (!plan.perUidProfiles) return;
        const team = D.bucketOf(S.profile);
        const members = (S.store[D.paths.members(team)] || {});
        Object.keys(members).forEach(k => {
            const uid = members[k] && members[k].uid;
            if (!uid || uid === S.uid || S.perUid[uid]) return;
            S.perUid[uid] = true;
            const p = D.paths.profile(uid);
            // A denial here (member moved away) is expected; drop that profile only.
            data._listen(p, snap => onValue(data, p, snap.val()), () => { delete S.store[p]; });
        });
    }

    function onValue(data, path, value) {
        if (!S.profile) return;
        S.store[path] = value;
        if (path === D.paths.profile(S.uid)) {
            if (!value || value.terminated === true) {
                endSession(value ? 'Your account has been terminated. Contact admin.' : 'Access changed. Please sign in again.');
                return;
            }
            S.profile = value;
        }
        if (path === 'settings') S.settings = value || {};
        if (keyOf(planFor()) !== S.planKey) { restartListeners(data); return; }
        refresh(data);
    }

    async function onDenied(data, path, err, optional) {
        console.error('listener denied: ' + ((err && err.code) || 'unknown'));
        if (!S.profile) return;
        if (optional && !S.fallback) {
            // Employee team-wide read refused: fall back to own paths (design 5.2).
            S.fallback = true;
            restartListeners(data);
            return;
        }
        let fresh = null;
        try { fresh = await F.loadProfile(database, S.uid); } catch (e) { fresh = null; }
        if (!fresh || fresh.terminated === true) {
            endSession('Your account has been terminated. Contact admin.');
            return;
        }
        if (!S.deniedRetry) {
            S.deniedRetry = true;
            S.profile = fresh;
            restartListeners(data);
            return;
        }
        endSession('Access changed. Please sign in again.');
    }

    function endSession(message) {
        const app = S.app;
        if (app) app.lockApp();
        const errorEl = el('loginError');
        if (errorEl && message) errorEl.textContent = message;
    }

    // Rebuild the in-memory shape the renderer uses.
    function refresh(data) {
        const a = D.assemble(S.store, S.profile, S.uid);
        TEAM_MEMBERS = a.teamMembers;
        MEMBER_TEAMS = a.memberTeams;
        TEAMS = a.teams;
        ADMIN_MEMBERS = a.admins;
        MANAGERS = a.managers;
        S.roster = a.roster;
        S.terminated = a.terminated;
        S.profiles = a.profiles;
        S.settings = a.settings;
        data.data = { attendance: a.attendance, leaves: a.leaves, holidays: a.holidays, lastUpdated: new Date().toISOString() };
        const toggle = el('toggleVisibility');
        if (toggle) toggle.checked = S.settings.everyoneSeesAll === true;
        attachTeamProfiles(data);
        data.firebaseReady = true;
        setSync(true);
        if (data.onDataLoaded) data.onDataLoaded();
    }

    // ---------- app lifecycle ----------

    function init(app) {
        S.app = app;
        app.loadTheme();
        app.bindEvents();
        S.initializing = true;
        app.lockApp();
        S.initializing = false;
        const auth = authObj();
        if (!auth || typeof firebase.auth !== 'function') {
            const errorEl = el('loginError');
            if (errorEl) errorEl.textContent = 'Could not load sign-in. Reload the page.';
            return;
        }
        auth.onAuthStateChanged(user => {
            if (S.busy) return; // login/register flows finish the sign-in themselves
            if (user) {
                if (!S.profile) resume(app, user);
            } else if (S.profile) {
                app.lockApp();
            }
        });
    }

    async function resume(app, user) {
        S.busy = true;
        try {
            const profile = await F.loadProfile(database, user.uid);
            await completeSignIn(app, user, profile, { password: null, pickedTeam: '' });
        } catch (e) {
            console.error('resume: ' + ((e && e.code) || 'unknown'));
            await signOutQuiet();
        } finally {
            S.busy = false;
        }
    }

    async function signOutQuiet() {
        const auth = authObj();
        if (auth) { try { await auth.signOut(); } catch (e) { /* ignore */ } }
    }

    async function loadTeamNames() {
        try { return (await database.ref('teamNames').once('value')).val() || {}; } catch (e) { return {}; }
    }

    // Prompt loop for the forced new password (design 4.6).
    async function forcedReset(user) {
        for (;;) {
            const pw = prompt('Please set a new password (min ' + H.MIN_PASSWORD_LENGTH + ' characters):');
            if (pw === null) return false;
            const err = H.validateNewPassword(pw);
            if (err) { alert(err); continue; }
            const confirmPw = prompt('Confirm new password:');
            if (pw !== confirmPw) { alert('Passwords do not match. Try again.'); continue; }
            let reauth = S.signInPassword;
            let r = await F.completeForcedReset({ auth: authObj(), db: database, uid: user.uid, newPassword: pw, reauthPassword: reauth, makeCredential });
            if (!r.ok && r.code === 'auth/requires-recent-login' && !reauth) {
                reauth = prompt('Please enter your current (temporary) password to continue:');
                if (reauth === null) return false;
                r = await F.completeForcedReset({ auth: authObj(), db: database, uid: user.uid, newPassword: pw, reauthPassword: reauth, makeCredential });
            }
            if (r.ok) return true;
            alert(r.message || 'Could not set the new password. Try again.');
        }
    }

    // Common tail of login, register and session resume (design 4.2 steps 4-7).
    async function completeSignIn(app, user, profile, opts) {
        const errorEl = el('loginError');
        const check = F.checkProfile(profile);
        if (!check.ok) {
            await signOutQuiet();
            if (errorEl) errorEl.textContent = check.message;
            return false;
        }
        if (check.mustReset) {
            const done = await forcedReset(user);
            if (!done) { await signOutQuiet(); return false; }
            delete profile.mustResetPassword;
        }
        const teamNames = await loadTeamNames();
        const post = await F.postSignIn({ db: database, uid: user.uid, profile, pickedTeam: opts.pickedTeam, teamNames, now: Date.now() });
        // Remember me no longer stores the password (design 4.2).
        localStorage.removeItem('attendance_remembered_pass');
        enter(app, user.uid, post.profile);
        if (!post.ok && post.message) alert(post.message);
        if (post.waitingForTeam) alert('Waiting for team assignment. Ask the Superuser to assign your team.');
        return true;
    }

    function enter(app, uid, profile) {
        S.uid = uid;
        S.profile = profile;
        S.store = {};
        S.deniedRetry = false;
        S.fallback = false;
        S.signInPassword = null;
        app.selectedMember = profile.name;
        app.unlockApp();
        el('userModal').classList.remove('active');
        const pw = el('loginPassword');
        if (pw) pw.value = '';
        app.updateUserDisplay();
        app.ensureSelectedVisible();
        app.updateUIPermissions();
        app.renderTeamList();
        app.renderCalendar();
        app.checkEmailReminder();
    }

    function unlockApp(app) {
        document.body.classList.remove('auth-locked');
        app.data.reset();
        startListeners(app.data);
    }

    // Called at the start of App.lockApp() in secure mode (design 4.4).
    function beforeLock() {
        const wasSignedIn = !!S.profile;
        S.profile = null;
        S.uid = null;
        S.store = {};
        S.roster = {};
        S.terminated = [];
        S.profiles = {};
        S.settings = {};
        S.planKey = '';
        S.perUid = {};
        S.fallback = false;
        S.deniedRetry = false;
        S.signInPassword = null;
        if (!S.initializing && (wasSignedIn || (authObj() && authObj().currentUser))) signOutQuiet();
    }

    async function loadTeamOptions() {
        const loginSel = el('loginTeam');
        const regSel = el('registerTeam');
        if (!loginSel || !regSel || typeof database === 'undefined') return;
        let names;
        try {
            names = (await database.ref('teamNames').once('value')).val() || {};
        } catch (e) {
            return; // fallback: pick a team after login
        }
        if (S.profile) return;
        const list = Object.keys(names).filter(id => typeof names[id] === 'string')
            .map(id => ({ id, name: names[id] })).sort((a, b) => a.name.localeCompare(b.name));
        const build = (sel, placeholder) => {
            sel.innerHTML = '';
            const first = document.createElement('option');
            first.value = '';
            first.textContent = placeholder;
            sel.appendChild(first);
            list.forEach(t => {
                const o = document.createElement('option');
                o.value = t.id;
                o.textContent = t.name;
                sel.appendChild(o);
            });
        };
        build(loginSel, list.length ? 'Keep my current team' : 'No teams yet');
        build(regSel, list.length ? 'Select your team' : 'No teams yet');
    }

    async function login(app) {
        const usernameInput = el('loginUsername').value.trim();
        const password = el('loginPassword').value;
        const errorEl = el('loginError');
        if (!usernameInput) { errorEl.textContent = 'Please enter your username.'; return; }
        if (!password) { errorEl.textContent = 'Please enter your password.'; return; }
        const auth = authObj();
        if (!auth) { errorEl.textContent = 'Could not load sign-in. Reload the page.'; return; }
        const remember = !!(el('rememberMe') && el('rememberMe').checked);
        const persistence = remember ? firebase.auth.Auth.Persistence.LOCAL : firebase.auth.Auth.Persistence.SESSION;
        S.busy = true;
        try {
            const r = await F.signIn(auth, usernameInput, password, persistence);
            if (!r.ok) {
                S.failedLogins++;
                let msg = H.loginErrorMessage(r.code);
                if (S.failedLogins >= 3 && H.shouldTryNextCandidate(r.code)) {
                    msg += ' If your password was shorter than 6 characters, ask the Superuser for a reset.';
                }
                errorEl.textContent = msg;
                return;
            }
            S.failedLogins = 0;
            errorEl.textContent = '';
            S.signInPassword = password;
            const profile = await F.loadProfile(database, r.user.uid);
            const pickedTeam = (el('loginTeam') || {}).value || '';
            const ok = await completeSignIn(app, r.user, profile, { password, pickedTeam });
            if (ok) {
                if (remember) localStorage.setItem('attendance_remembered_user', usernameInput);
                else localStorage.removeItem('attendance_remembered_user');
            }
        } catch (e) {
            console.error('login: ' + ((e && e.code) || 'unknown'));
            errorEl.textContent = 'Connection error. Please try again.';
            await signOutQuiet();
        } finally {
            S.signInPassword = null;
            S.busy = false;
        }
    }

    async function register(app) {
        const errorEl = el('registerError');
        const auth = authObj();
        if (!auth) { errorEl.textContent = 'Could not load sign-in. Reload the page.'; return; }
        S.busy = true;
        try {
            const teamNames = await loadTeamNames();
            const r = await F.register({
                auth, db: database,
                name: el('registerName').value,
                password: el('registerPassword').value,
                confirm: el('registerConfirm').value,
                teamId: (el('registerTeam') || {}).value || '',
                teamNames
            });
            if (!r.ok) { errorEl.textContent = r.message; return; }
            errorEl.textContent = '';
            ['registerName', 'registerPassword', 'registerConfirm'].forEach(id => { if (el(id)) el(id).value = ''; });
            await completeSignIn(app, r.user, r.profile, { password: null, pickedTeam: '' });
        } catch (e) {
            console.error('register: ' + ((e && e.code) || 'unknown'));
            errorEl.textContent = 'Registration failed. Try again.';
        } finally {
            S.busy = false;
        }
    }

    function updateUserDisplay(app) {
        const display = el('currentUserDisplay');
        if (!display) return;
        if (!S.profile) { display.innerHTML = ''; return; }
        const badge = isAdminUser() ? ' 👑' : '';
        display.innerHTML = `
            <span class="user-display-name">${escapeHtml(S.profile.username || S.profile.name)}${badge}</span>
            <span class="user-display-team" id="currentUserTeam"></span>
            <span class="user-display-sep">|</span>
            <span class="user-display-btn" id="btnChangePassword" title="Change password">🔑 Password</span>
            <span class="user-display-sep">|</span>
            <span class="user-display-btn" id="btnLogout" title="Logout">⇄ Logout</span>
        `;
        app.bindUserDisplayEvents(display);
        app.updateTeamLabels();
    }

    function updateUIPermissions(app) {
        app.applyRoleVisibility();
        const toggle = el('toggleVisibility');
        if (toggle) toggle.checked = S.settings.everyoneSeesAll === true;
        app.ensureSelectedVisible();
        app.renderTeamList();
    }

    async function changeOwnPassword() {
        if (!S.profile) return;
        const current = prompt('Enter your current password:');
        if (!current) return;
        const next = prompt('Enter new password (min ' + H.MIN_PASSWORD_LENGTH + ' characters):');
        const err = H.validateNewPassword(next || '');
        if (err) { alert(err); return; }
        const confirmPw = prompt('Confirm new password:');
        if (next !== confirmPw) { alert('❌ Passwords do not match.'); return; }
        const r = await F.changeOwnPassword({ auth: authObj(), currentPassword: current, newPassword: next, makeCredential });
        alert(r.ok ? '✅ Password changed successfully.' : '❌ ' + r.message);
    }

    // Admin/Superuser: "Request password reset" (design 4.5).
    async function requestReset(member) {
        if (!isAdminUser() || !canAdminMember(member)) {
            alert('You can only request password resets for members of your own team.');
            return;
        }
        const r = rosterFor(member);
        if (!r || !r.uid) { alert(`"${member}" has not registered yet.`); return; }
        try {
            await F.requestPasswordReset(database, r.uid, S.uid);
            alert(`Password reset requested for "${member}". The Superuser will hand over a temporary password.`);
        } catch (e) {
            writeFailed(e);
            alert('Could not request the password reset.');
        }
    }

    function renderTerminatedSection() {
        const section = el('terminatedSection');
        if (!section) return;
        const list = S.terminated.filter(e => canAdminTeamId(e.teamId === D.UNASSIGNED ? null : e.teamId)).map(e => e.name);
        if (list.length === 0) return;
        section.innerHTML = `
            <h4 class="terminated-header">🚫 Terminated Members (${list.length})</h4>
            ${list.map(name => `
                <div class="team-member-item terminated-item">
                    <div class="team-member-info">
                        <span class="avatar" style="background:#666">✗</span>
                        <span class="team-member-name terminated-name">${escapeHtml(name)}</span>
                    </div>
                    <div class="team-member-actions">
                        <button class="btn-restore" data-member="${escapeHtml(name)}" title="Restore member">♻️ Restore</button>
                    </div>
                </div>
            `).join('')}
        `;
    }

    // ---------- attendance writes (granular, design 5.2) ----------

    function update(payload) {
        return database.ref().update(payload).then(() => setSync(true), writeFailed);
    }

    function localSet(data, kind, member, date, value) {
        const node = data.data[kind] || (data.data[kind] = {});
        if (value === null) {
            if (node[member]) { delete node[member][date]; if (Object.keys(node[member]).length === 0) delete node[member]; }
        } else {
            node[member] = node[member] || {};
            node[member][date] = value;
        }
    }

    function markAttendance(data, member, date, present) {
        const r = rosterFor(member);
        if (!r) return;
        localSet(data, 'attendance', member, date, present ? true : null);
        const u = {};
        u[D.paths.attendanceDay(r.teamId, r.key, date)] = present ? true : null;
        return update(u);
    }

    function markLeave(data, member, date, type) {
        const r = rosterFor(member);
        if (!r) return;
        localSet(data, 'leaves', member, date, type);
        localSet(data, 'attendance', member, date, null);
        const u = {};
        u[D.paths.leaveDay(r.teamId, r.key, date)] = type;
        u[D.paths.attendanceDay(r.teamId, r.key, date)] = null;
        return update(u);
    }

    function removeLeave(data, member, date) {
        const r = rosterFor(member);
        if (!r) return;
        localSet(data, 'leaves', member, date, null);
        const u = {};
        u[D.paths.leaveDay(r.teamId, r.key, date)] = null;
        return update(u);
    }

    function addHoliday(data, date, name) {
        if (data.data.holidays.find(h => h.date === date)) return;
        return database.ref(D.paths.holiday(date)).set({ name: String(name).slice(0, 100) }).then(() => setSync(true), writeFailed);
    }

    function removeHoliday(data, date) {
        return database.ref(D.paths.holiday(date)).remove().then(() => setSync(true), writeFailed);
    }

    // Superuser import: replaces attendance and leaves of known roster members
    // and the holiday list. Names without a roster entry are skipped and counted.
    function importJSON(data, jsonStr) {
        let imported;
        try { imported = JSON.parse(jsonStr); } catch (e) { return false; }
        if (!imported || !imported.attendance || !imported.holidays) return false;
        const u = {};
        let skipped = 0;
        const names = new Set(Object.keys(imported.attendance || {}).concat(Object.keys(imported.leaves || {})));
        names.forEach(name => {
            const r = rosterFor(name);
            if (!r) { skipped++; return; }
            const att = {};
            Object.keys(imported.attendance[name] || {}).forEach(d => { if (D.DATE_RE.test(d) && imported.attendance[name][d] === true) att[d] = true; });
            const lv = {};
            Object.keys((imported.leaves || {})[name] || {}).forEach(d => {
                const t = imported.leaves[name][d];
                if (D.DATE_RE.test(d) && D.LEAVE_TYPES.includes(t)) lv[d] = t;
            });
            u[D.paths.attendance(r.teamId, r.key)] = Object.keys(att).length ? att : null;
            u[D.paths.leaves(r.teamId, r.key)] = Object.keys(lv).length ? lv : null;
        });
        const hol = D.holidayListToNode(imported.holidays);
        u.holidays = Object.keys(hol).length ? hol : null;
        update(u);
        if (skipped) alert(`${skipped} name(s) in the file are not on any roster and were skipped.`);
        return true;
    }

    // ---------- team management ----------

    function teamNode(teamId) {
        const tree = D.storeToTree(S.store);
        return ((tree.teamData || {})[teamId]) || {};
    }

    function memberData(entry) {
        const t = teamNode(entry.teamId);
        return {
            member: (t.members || {})[entry.key] || { name: entry.name, order: Date.now() },
            attendance: (t.attendance || {})[entry.key] || {},
            leaves: (t.leaves || {})[entry.key] || {}
        };
    }

    function setRole(app, member, field, value) {
        const r = rosterFor(member);
        if (!r || !r.uid) {
            alert(`"${member}" has not registered yet. Roles can be set after they register.`);
            app.renderTeamManagement();
            return false;
        }
        const u = {};
        u['usersV2/' + r.uid + '/' + field] = value;
        update(u);
        app.renderTeamManagement();
        return true;
    }

    function createTeam(name) {
        const id = database.ref('teams').push().key;
        update(D.teamCreatePayload(id, name, currentUserName(), new Date().toISOString()));
        return true;
    }

    function renameTeam(teamId, name) {
        update(D.teamRenamePayload(teamId, name));
        return true;
    }

    function deleteTeam(teamId) {
        update(D.teamDeletePayload(teamId, teamNode(teamId)));
        return true;
    }

    function assignTeam(member, teamId) {
        const r = rosterFor(member);
        if (!r) return false;
        const to = teamId || D.UNASSIGNED;
        if (to === r.teamId) return true;
        update(D.memberMovePayload(r.key, r.teamId, to, memberData(r), r.uid));
        return true;
    }

    async function addMember(app, name, teamId) {
        name = H.cleanName(name);
        const err = H.validateName(name);
        if (err) { alert('⚠️ ' + err); return; }
        if (TEAM_MEMBERS.includes(name) || name === SUPER_ADMIN) { alert('⚠️ This member already exists!'); return; }
        const term = S.terminated.find(e => e.name === name);
        if (term) {
            if (confirm(`"${name}" is a terminated member. Do you want to restore them instead?`)) await app.restoreMember(name);
            return;
        }
        const bucket = teamId || D.UNASSIGNED;
        const key = H.secureNameKey(name);
        try {
            await database.ref(D.paths.member(bucket, key)).set({ name, order: Date.now(), addedBy: String(S.profile.memberKey).slice(0, 100) });
            setSync(true);
        } catch (e) {
            writeFailed(e);
            alert('⚠️ Could not add this member.');
            return;
        }
        app.selectedMember = name;
        app.renderTeamList();
        app.renderTeamManagement();
        app.renderCalendar();
    }

    // Rename changes the display name only; the memberKey never changes (design 3).
    function editMember(app, oldName, newName) {
        const r = rosterFor(oldName);
        if (!r) return;
        const err = H.validateName(newName);
        if (err) { alert('⚠️ ' + err); return; }
        // Rules let only the Superuser (or an Admin of another member's team) change a profile name.
        if (r.uid && r.uid === S.uid && !isSuper()) { alert('⚠️ Only the Superuser can change your own name.'); return; }
        const u = {};
        u[D.paths.member(r.teamId, r.key) + '/name'] = newName;
        if (r.uid) u['usersV2/' + r.uid + '/name'] = newName;
        update(u);
        if (app.selectedMember === oldName) app.selectedMember = newName;
    }

    function removeMember(app, name) {
        const r = rosterFor(name);
        if (!r) return;
        const prof = r.uid ? S.profiles[r.uid] : null;
        update(D.terminatePayload(r, prof, new Date().toISOString()));
        if (app.selectedMember === name) app.selectedMember = currentUserName() || '';
        app.renderTeamList();
        app.renderTeamManagement();
        app.renderCalendar();
    }

    async function restoreMember(app, name) {
        const r = S.terminated.find(e => e.name === name) || rosterFor(name);
        if (!r) return;
        if (!canAdminTeamId(r.teamId === D.UNASSIGNED ? null : r.teamId)) {
            denyAction('You can only restore members of your own team.');
            return;
        }
        try {
            await database.ref().update(D.restorePayload(r));
        } catch (e) {
            writeFailed(e);
            return;
        }
        const msg = `"${name}" has been restored.\n\nThey will be asked to set a new password on next login.` +
            (r.uid ? '\nDo you also want to request a password reset from the Superuser now?' : '');
        if (r.uid && confirm(msg)) await requestReset(name);
        else if (!r.uid) alert(msg);
        app.renderTeamManagement();
        app.renderTeamList();
    }

    // Reorder writes `order` for every member in the actor's scope.
    function reorderMembers(dragged, target) {
        const scope = getAdminScopeMembers();
        const from = scope.indexOf(dragged);
        const to = scope.indexOf(target);
        if (from < 0 || to < 0) return false;
        scope.splice(from, 1);
        scope.splice(to, 0, dragged);
        const base = Date.now();
        const u = {};
        scope.forEach((name, i) => {
            const r = rosterFor(name);
            if (r && S.roster[name]) u[D.paths.member(r.teamId, r.key) + '/order'] = base + i;
        });
        update(u);
        return true;
    }

    return {
        state: S,
        currentUserName, isSuper, isAdminUser, isManagerUser, memberTeamId, canSelfAssign,
        adminCanEditHolidays, hasAccount, rosterFor,
        init, unlockApp, beforeLock, loadTeamOptions, login, register,
        updateUserDisplay, updateUIPermissions, changeOwnPassword, requestReset,
        renderTerminatedSection, startListeners,
        markAttendance, markLeave, removeLeave, addHoliday, removeHoliday, importJSON,
        setRole, createTeam, renameTeam, deleteTeam, assignTeam,
        addMember, editMember, removeMember, restoreMember, reorderMembers
    };
})();
