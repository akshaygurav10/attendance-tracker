# Verification

## Changes
- index.html: `<body class="auth-locked">` (locked before any JS runs).
- styles.css: `body.auth-locked` hides `.app-container`, `#syncModal`, `#emailModal`, `.day-context-menu` with `display:none !important`; `#userModal` gets an opaque background.
- app.js:
  - `AttendanceData`: constructor loads localStorage and attaches Firebase listeners only if a user is signed in. `load()` is split into `loadLocal()` and `startListeners()`. Listeners go through `_listen()` and are detached by `stopListeners()`. `reset()` clears in-memory data. `save()` is a no-op when signed out.
  - `App.lockApp()`: adds `auth-locked`, stops listeners, resets data/TEAM_MEMBERS/ADMIN_MEMBERS/selectedMember/view state, removes personal localStorage keys (current user, data, team members, admin list, remembered user/pass; keeps `attendance_theme` and `reminder_*`), clears sessionStorage, removes context menu, closes sync/email modals, empties all data containers, resets view panels, clears login/register/member/holiday fields, resets password visibility, shows the login panel.
  - `App.unlockApp()`: removes `auth-locked`, `loadLocal()`, `startListeners()`. Called from `handleLogin`, `handleRegister` and `init` (signed in).
  - Logout button calls `lockApp()`. A `storage` event (other-tab logout) and `pageshow` with `persisted` also call it.
  - Async guards: `updateUserDisplay`, `updateUIPermissions` and `checkEmailReminder` return if signed out; `onDataUpdate` returns if signed out.
  - `refreshTeamMembers()` is called in `handleLogin` and `handleRegister` before any team-list save. Without it, the team list is no longer preloaded while logged out, and the first login would overwrite Firebase `teamMembers` with a one-person list.

## Commands run
- `node --check app.js` -> exit 0 (no syntax errors).
- grep: no remaining direct `database.ref(...).on(` calls (all go through `_listen`).

## Flow trace (static)
- Initial load, signed out: body has `auth-locked` in HTML, so the app container is `display:none` before JS. `new App()` creates `AttendanceData` with no load and no listeners. `init()` takes the else branch: `bindEvents()`, then `lockApp()`. No render of team list or calendar. Only the login modal shows.
- Initial load, signed in with a known user: `unlockApp()` (class removed, local load, listeners), then the original render sequence.
- Login: validate, `refreshTeamMembers()`, set current user, `unlockApp()`, close modal, render. Data comes from the new listeners, so a previous user's data is never shown.
- Logout / other-tab logout / bfcache restore: `lockApp()`. Listeners are detached before DOM and state are cleared, so nothing re-renders.

## Not verified
- Firebase login and realtime sync could not be exercised (no credentials / no browser run). Behaviours above are by code reading only.

## Behaviour notes
- "Remember me" credentials are now removed on logout (and on a signed-out load), so the login screen is blank after logout. This is the visible change from the old prefill behaviour.
- Pre-existing, untouched: unauthenticated Firebase DB access, plaintext remembered password while logged in, literal `${SUPER_ADMIN}` in index.html.
