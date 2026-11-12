# Signed-out lock and data wipe for the Login page

The previous user's attendance data was visible behind the login modal because the app container always rendered and Firebase/localStorage data loaded at startup regardless of sign-in state. The fix adds `auth-locked` to `<body>` in the HTML, so a CSS rule hides the app before any JS runs. It gates data loading and listeners on a signed-in user, and adds `lockApp()`/`unlockApp()` to wipe or restore state. Reviewed commit 605054d (app.js, index.html, styles.css); working tree is clean apart from `.agents/`.

Watch for: no browser or Firebase run was done, so sign-in and sync are verified by code reading only (confirmed by my read of `handleLogin`/`handleRegister`/`init`). "Remember me" prefill no longer survives logout (confirmed, intentional).

**Verdict**: APPROVED

## High-level view

The login view is now exclusive. `body.auth-locked` forces `display:none !important` on the app container, sync/email modals and context menu, and gives `#userModal` an opaque background. The class is in the static HTML, so there is no flash before `onAuthStateChanged`-style init resolves. `init()` only unlocks when a stored user is in the team list; otherwise it calls `lockApp()`.

`AttendanceData` no longer loads or subscribes in its constructor unless a user is signed in. All Firebase listeners go through `_listen()` and are detached by `stopListeners()`. Late callbacks are also guarded: `onDataUpdate`, `updateUserDisplay`, `updateUIPermissions`, `checkEmailReminder` and the visibility-toggle fetch all bail when signed out.

`lockApp()` is the single logout path. It runs on the Logout button, on cross-tab logout (`storage` event) and on bfcache restore (`pageshow` persisted). It stops listeners, resets in-memory data and team/admin lists, removes personal localStorage keys (keeping theme and `reminder_*`), clears sessionStorage, empties rendered containers, resets view panels and clears login/register fields.

Sign-in still reveals the app. `handleLogin` and `handleRegister` call `unlockApp()` (class removed, local load, listeners started) and then render. `refreshTeamMembers()` was added because the team list is no longer preloaded while signed out. Without it, the first save after login would overwrite Firebase `teamMembers`.

<details>
<summary>Issues (3)</summary>

1. **No runtime verification** (possible, non-blocking) — Login, logout and realtime sync were traced statically only. Do a manual browser pass: load signed out (no flash of app), log in as user A, log out, confirm blank background, DevTools storage shows no personal keys, then log in as user B.
2. **Stale session wipes storage on load** (confirmed, non-blocking) — If `attendance_current_user` is set but absent from the cached team list, `init()` runs `lockApp()` and clears cached data, remembered credentials and sessionStorage. Acceptable for the privacy goal; it only costs an extra Firebase fetch at next login.
3. **Remember-me no longer prefills after logout** (confirmed, non-blocking) — Intentional per the coder's notes, but it is a visible behavior change from the old flow. Tell the user.

</details>

<details>
<summary>Details</summary>

### Pre-JS lock and the modal background

Putting the class in the markup rather than adding it from JS is what closes the window before init. The opaque `#userModal` background means nothing underneath can show even if a container were missed. Changes are scoped to `body.auth-locked`, so signed-in styling is untouched.

### Listener teardown and data gating

`stopListeners()` calls `off('value', cb)` with the stored callback for each of the four paths (`appData`, `teamMembers`, `admins`, `settings/everyoneSeesAll`), so no listener survives logout. `save()` is a no-op when signed out, which prevents a late write from re-persisting data after the wipe. `startListeners()` is idempotent via the `_listeners.length === 0` check, so repeated unlock calls do not double-subscribe. Possible edge: a Firebase callback already in flight when `lockApp()` runs could still set `TEAM_MEMBERS`/`localStorage` inside the `appData` or `teamMembers` handler before `onDataUpdate`'s guard. `off()` prevents further callbacks, and Firebase delivers callbacks on the JS thread, so this is unlikely in practice (possible, non-blocking).

### Sign-in path after a wipe

After logout, localStorage holds no data, so `unlockApp()` → `loadLocal()` starts from defaults and the listener populates real data. The previous user's data therefore cannot reappear for the next user. Team list is fetched before the user lookup, then the user is pushed and saved, so the Firebase team list is not clobbered by a one-person list.

### Cross-tab and bfcache

`lockApp()` removes `attendance_current_user`, which fires `storage` in other tabs and locks them. A repeated removal of an already-missing key fires no event, so there is no ping-pong. Sign-in in one tab sets a value and does not trigger lock elsewhere.

### Pre-existing, not in scope

Unauthenticated Firebase DB access, plaintext remembered password while logged in, and literal `${SUPER_ADMIN}` in index.html are untouched and out of scope.

</details>

<details>
<summary>File map</summary>

- app.js — gated loading, `_listen`/`stopListeners`/`reset`, `lockApp`/`unlockApp`, `refreshTeamMembers`, async guards, storage/pageshow handlers
- index.html — `class="auth-locked"` on body
- styles.css — `body.auth-locked` hide rules and opaque login modal background

Full diff: `git show 605054d`.

</details>
