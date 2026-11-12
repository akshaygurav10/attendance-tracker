# Implementation Plan: Login-page privacy leak

## Findings (confirmed by reading)

No Firebase Auth is used. "Logged in" means `localStorage['attendance_current_user']` is set (`getCurrentUser()`, app.js ~72). Firebase Realtime DB is accessed via the global `database` (firebase-config.js, not read for secrets).

Confirmed causes:
1. **Login is only an overlay.** `#userModal` (index.html, "Auth Modal") sits on top of `.app-container`. `.modal` in styles.css (~539) has `background: rgba(0,0,0,0.7)`, so the calendar, stats, team list and names are visible through it. `.app-container` is never hidden. This is the reported bug.
2. **Page load renders data before login.** The `App` constructor (~app.js 495) builds `AttendanceData`, whose `load()` (~169) reads `attendance_tracker_data` from localStorage and attaches Firebase `on('value')` listeners. `init()` (~512) then runs `renderTeamList()` and `renderCalendar()` unconditionally. When logged out, `TEAM_MEMBERS[0]` is rendered as `selectedMember`.
3. **Logout clears almost nothing.** `bindUserDisplayEvents` (~788) `btnLogout.onclick` only does the following:
   - removes `attendance_current_user`
   - re-shows the modal
   - resets the form panels
   - clears `loginError`, `loginPassword` and `currentUserDisplay`

   It does not clear:
   - `#teamList`, `#calendarGrid`, `#attendanceStats`, `#viewingInfo`, `#currentMonthYear`
   - `#summaryBody`, `#holidayList`, `#teamMemberList`, `#reportDashboard`
   - the `#dayContextMenu` element appended to `body`
   - `this.selectedMember`, `TEAM_MEMBERS`, `ADMIN_MEMBERS`, or `this.data.data`
   - the Firebase listeners
   - localStorage personal data
4. **Listeners are never detached.** `database.ref('appData' | 'teamMembers' | 'admins' | 'settings/everyoneSeesAll').on('value', ...)` is called in `AttendanceData.load()` (~190-248). The refs and callbacks are not stored and there is no `.off()` anywhere. The callbacks call `onDataLoaded()` → `App.onDataUpdate()` (~506), which re-renders `#teamList` and the calendar while logged out. This repopulates the DOM right after any clearing.
5. **Personal data persists in localStorage:**
   - `attendance_tracker_data`
   - `attendance_team_members`
   - `attendance_admin_list`
   - `attendance_current_user`
   - `attendance_remembered_user`
   - `attendance_remembered_pass` (plaintext password)

   Only `attendance_theme` (and the `reminder_*` flags) are non-sensitive.
6. **`showUserSelection()` (~523) prefills the login form** with the remembered username and password and ticks `#rememberMe`. That puts the previous user's identity on the login screen.
7. **Async writes after logout.** `updateUserDisplay()` (~765) and `updateUIPermissions()` (~810) use `database.ref(...).once('value').then(...)` to write `#currentUserDisplay.innerHTML` and toggle buttons. These can fire after logout and re-insert the old user's name.
8. **`checkEmailReminder()` (~1991, called from `init()`)** can show a `confirm()` and open the report modal before login. Verify during implementation; it should only run when logged in.
9. Other places that hold personal data and must be closed or cleared on logout (verify during implementation):
   - `#syncModal`, `#emailModal` and `#reportDashboard`
   - the `dayContextMenu`
   - the register form fields `#registerName`, `#registerPassword`, `#registerConfirm`
   - `#loginUsername`
   - `#memberName`, `#holidayDate`, `#holidayName`

## Design decisions

- **Hide with CSS class.** Add `class="auth-locked"` statically on `<body>` in index.html, so there is no flash before JS runs. In styles.css, `body.auth-locked .app-container { display: none !important; }`. Also hide the other modals and the context menu while locked. App.js removes the class on login and adds it on logout. This gives "login view exclusively" including initial load. Rationale: it is one toggle, needs no new elements, and keeps the existing markup and styling.
- **Opaque login backdrop.** Add `body.auth-locked #userModal { background: var(--bg-primary); }` so nothing can show through even if the app container were somehow visible.
- **Deferred, detachable listeners.** Split `AttendanceData.load()` into two parts:
  - `loadLocal()` (the localStorage part)
  - `startListeners()` (the four `.on('value')` subscriptions)

  Store `{ref, cb}` pairs in `this._listeners`. Add `stopListeners()` (calls `ref.off('value', cb)`, sets `firebaseReady=false`) and `reset()` (sets `this.data = getDefaultData()`, with no holidays and no localStorage writes). The constructor calls `startListeners()` only when `getCurrentUser()` is set. Rationale: this avoids fetching and rendering data before login and keeps the existing callback code unchanged inside the new method.
- **Single `App.lockApp()` method** does all teardown. A matching `App.unlockApp()` is called from `handleLogin` and `handleRegister` on success. Rationale: one place guarantees all logout paths (button, cross-tab, stale session) behave identically.
- **Remember-me.** Logout removes `attendance_remembered_user` and `attendance_remembered_pass`, and clears the form. `showUserSelection()` no longer prefills when there is no active session unless the remember keys exist. This means "Remember me" survives a page refresh but not an explicit logout. Assumption: this is the acceptable reading of the requirement to clear login fields on logout. Flag to the user that this slightly changes remember-me behavior.
- **Keep:** `attendance_theme` and the `reminder_*` keys.

## Steps

- [ ] 1. **HTML/CSS: lock the app by default.**
      Add `class="auth-locked"` to `<body>` in index.html. In styles.css, near the Modal block (~539-555), add:
      - `body.auth-locked .app-container, body.auth-locked #syncModal, body.auth-locked #emailModal, body.auth-locked .day-context-menu { display: none !important; }`
      - `body.auth-locked #userModal { background: var(--bg-primary); }`

      Do not change existing rules.
      Files: index.html, styles.css
      Verify: open index.html in a browser (or `npx http-server .` if available). Logged out, DevTools shows `.app-container` computed `display: none`. The login box is on a solid background with nothing behind it.

- [ ] 2. **Refactor `AttendanceData` for deferred/detachable listeners.**
      In `class AttendanceData` (~154-250): keep the constructor field setup. Replace the final `this.load()` with `this.loadLocal(); if (getCurrentUser()) this.startListeners();`.
      - Move the `database.ref(...).on(...)` blocks (appData, teamMembers, admins, settings/everyoneSeesAll) into `startListeners()` unchanged, but register each through a small helper that records `{ref, cb}` in `this._listeners`. Include the error callback on appData.
      - Add `stopListeners()` and `reset()` as described in Design decisions.
      - Keep `loadLocal()` loading from localStorage only when a user is logged in; otherwise use `getDefaultData()`.
      - Make `save()` / `saveToFirebase()` no-ops when `getCurrentUser()` is null, so a late save cannot re-write cleared cache.
      Files: app.js
      Verify: reload while logged in; the calendar still populates, `#syncIndicator` shows Synced, and marking a day still saves. Reload while logged out; the Network tab shows no `appData` read.

- [ ] 3. **Add `App.lockApp()` and `App.unlockApp()`; call `lockApp()` for logged-out state in `init()`.**
      Add the following methods to `class App`, near `bindUserDisplayEvents` (~788).
      `lockApp()`:
      - `document.body.classList.add('auth-locked')`.
      - Call `this.data.stopListeners()` and `this.data.reset()`.
      - Reset in-memory state: `TEAM_MEMBERS = []`, `ADMIN_MEMBERS = [SUPER_ADMIN]`, `this.selectedMember = ''`, `this.currentView = 'calendar'`, `this.sortColumn = null`, `this.sortDirection = 'asc'`.
      - Remove `#dayContextMenu` if present.
      - Remove `active` from `#syncModal` and `#emailModal`.
      - Set `innerHTML = ''` (or `textContent = ''`) on: `teamList`, `calendarGrid`, `attendanceStats`, `viewingInfo`, `summaryBody`, `holidayList`, `teamMemberList`, `reportDashboard`, `currentUserDisplay`, `currentMonthYear`, `summaryMonthYear`, `syncStatus`.
      - Reset the view panels to Calendar: `.view` / `.btn-sidebar` `active` classes back to `#calendarView` / `#btnCalendarView`.
      - Clear the form fields `loginUsername`, `loginPassword`, `registerName`, `registerPassword`, `registerConfirm`, `memberName`, `holidayDate`, `holidayName`; uncheck `rememberMe`, `toggleVisibility`; clear `loginError`, `registerError`.
      - Reset `loginPassword` and `registerPassword` to `type="password"` (and the eye icons to 👁️).
      - Show the `loginForm` panel, hide `registerForm` and `forgotForm`, set `authModalTitle` to '🔐 Login'.
      - Add `active` to `#userModal`.
      - Remove from localStorage exactly: `attendance_current_user`, `attendance_tracker_data`, `attendance_team_members`, `attendance_admin_list`, `attendance_remembered_user`, `attendance_remembered_pass`. Keep `attendance_theme` and `reminder_*`.

      `unlockApp()`:
      - Remove the `auth-locked` class.
      - Call `this.data.loadLocal()` (default holidays) and `this.data.startListeners()`.

      In `init()` (~512), change the order to this:
      - `loadTheme()`
      - `bindEvents()`
      - if logged in (`getCurrentUser()` and `TEAM_MEMBERS.includes(...)`): `unlockApp()`, then render, then `checkEmailReminder()`
      - otherwise: `lockApp()`

      Do not call `renderTeamList()` or `renderCalendar()` when logged out.
      Files: app.js
      Verify: reload logged out → DOM inspector shows the listed containers empty and localStorage contains only `attendance_theme` (plus `reminder_*`). Reload logged in → app renders as before.

- [ ] 4. **Wire logout to `lockApp()`; remove the remember-me prefill for logged-out state.**
      In `bindUserDisplayEvents` (~788), replace the body of `btnLogout.onclick` with a call to `this.lockApp()`. Keep `btnChangePassword.onclick`.
      In `showUserSelection()` (~523), keep the logged-in branch. In the logged-out branch, prefill from the remember keys only; because logout now deletes them, a post-logout login screen is blank, while a pure refresh after "Remember me" still prefills. Do not change `handleLogin`'s remember-me writes (~669-676).
      Files: app.js
      Verify: log in, tick Remember me, click Logout → the login form is blank and the app is hidden. Refresh → still blank, and the localStorage keys are gone.

- [ ] 5. **Wire login/register success to `unlockApp()` and fix the order.**
      In `handleLogin` (~663-690) and `handleRegister` (~729-742): after `attendance_current_user` is set and `TEAM_MEMBERS` updated, and before `updateUserDisplay()` / `renderTeamList()` / `renderCalendar()`, call `this.unlockApp()`. Keep the existing `userModal` close and field clearing. Also clear `loginUsername` and `loginPassword` after success only if Remember me is unchecked (otherwise existing behavior).
      Files: app.js
      Verify: log in → the app appears and syncs; log out and log in as a different user → the calendar shows only the new user's data, never the previous user's, at any point.

- [ ] 6. **Guard async callbacks and cross-tab logout.**
      - In `updateUserDisplay()` `.then` (~772) and `updateUIPermissions()` `.then` (~826), return early if `getCurrentUser()` is falsy. This prevents the old name from being written after logout.
      - In `onDataUpdate()` (~506), return early if `!getCurrentUser()`.
      - In `checkEmailReminder()` (~1991), return if `!getCurrentUser()`.
      - In `bindEvents()` (~2010), add `window.addEventListener('storage', e => { if (e.key === 'attendance_current_user' && !e.newValue) this.lockApp(); })` so a logout in another tab locks this one.
      - Add `window.addEventListener('pageshow', e => { if (e.persisted && !getCurrentUser()) this.lockApp(); })` so back/forward cache does not restore the old DOM. Verify during implementation whether this is needed.
      Files: app.js
      Verify: log out in tab A → tab B locks without refresh. Click Logout immediately after login (before Firebase `once` resolves) → the username never reappears in the header.

- [ ] 7. **Manual regression pass (no automated tests exist in this repo; verify during implementation that none were added).**
      Check the following with DevTools open:
      - Cold load logged out: Elements panel has no names or calendar cells in `#teamList` / `#calendarGrid`; Application → Local Storage has only `attendance_theme`; Network shows no `appData` read.
      - Login → use calendar, summary, holidays, team views → Logout: all containers empty, `.app-container` `display:none`, form fields empty.
      - Escape key and backdrop click do not dismiss the login modal while logged out (existing guards use `getCurrentUser()`).
      - Theme preference (`light-theme` body class) persists through logout and is applied on the login screen.
      - Register and Forgot Password panels still switch correctly, and Logout always returns to the Login panel.
      Files: none
      Verify: all checks above pass; report any failure.

## Out of scope / notes for the implementer

- Passwords are stored hashed (SHA-256) in `users/*` and the Firebase rules are not visible here. Unauthenticated access to the DB is an access-control issue beyond this fix; mention it to the user.
- `index.html` forgot panel contains a literal `${SUPER_ADMIN}`, which is not interpolated. This is an unrelated pre-existing bug and should not be fixed here.
- Plaintext `attendance_remembered_pass` is a separate security concern. This plan only ensures it is removed on logout.
