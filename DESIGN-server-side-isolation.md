# Design: Server-side team isolation (Firebase Auth + per-team data + rules)

Status: design for review (iteration 5, revised after the iteration-4 review `design-review-r2.md`; findings of iterations 1 to 4 are handled in section 17). Branch `feature/server-side-team-isolation`, from `a7001f7`.
Implements `FUTURE-ENHANCEMENTS.md` section 1. No code is written by this document. Section 17 lists how every review finding was handled.

## 1. Overview

Today every permission check is in browser code. There is no Firebase Auth, the whole attendance dataset is one blob (`appData`), and the `users` node holds password hashes that the browser downloads at login. Anyone with the public Firebase config can read or write everything from dev tools.

The design moves authority to Firebase. Users sign in with Firebase Auth (Email/Password, using a synthetic email derived from the username). Roles and team live in a profile node keyed by `auth.uid`, which no client can promote itself in. Attendance, leaves and the roster move to per-team paths under `teamData/{teamId}/...`, so Realtime Database rules can allow or deny a read by team. Password hashes leave client-readable data and live only in Firebase Auth. A config flag (`SECURITY_MODE`, default `"legacy"`) keeps the live app working exactly as today until the user migrates and flips it to `"secure"`.

Stack, locked on approval: static HTML/JS (no build step), Firebase JS SDK 9.23.0 compat (`firebase-app-compat`, `firebase-database-compat`, plus new `firebase-auth-compat` at the same version), Realtime Database, Firebase Auth Email/Password, `database.rules.json`, a Node migration/admin script with `firebase-admin`, and rules tests with `@firebase/rules-unit-testing` and the Database emulator. No Cloud Functions.

Two things changed the shape of this revision. First, the rules are now written out in full (section 7) with the create-versus-update split made explicit, because Realtime Database rules evaluate `root` against the state before the write, which forces registration and the team move to be sequences of writes rather than one multi-path write. Second, `teams` and `settings` are shared with the legacy app, so the migration never writes them (section 3, section 9).

## 2. Options compared

| | A. Auth email/password + DB roles, rules via `auth.uid` | B. Custom tokens via Cloud Functions | C. Custom claims via Cloud Function |
|---|---|---|---|
| Extra infrastructure | None. | A deployed Function that verifies old logins and mints tokens. | A deployed Function that sets claims when the Superuser changes roles. |
| Plan | Spark (free) is enough, to my knowledge; confirm in the console (section 2.1). | Blaze (pay-as-you-go; needs a billing account and card). Cloud Functions deploy requires Blaze. | Blaze, same reason. |
| Role changes in the app | Instant. Rules read `usersV2/{uid}` flags. | Instant if roles are in the DB, as in A. | Delayed until the user's ID token refreshes (up to about an hour, or a forced refresh). |
| Admin sets another user's password | Not possible from the browser. Needs the Admin SDK (our local script). | Possible via Function. | Possible via Function. |
| Keeps old passwords | Not by default. Rotation of every password is the default (section 9); non-privileged users may optionally keep old passwords via `importUsers` with SHA256 (section 8) behind a hard test gate. | Yes, and without a hash import. | Same as A. |
| Honest downside | Loses in-app Admin password reset (4.5). | Cost, deployment, a server to maintain. | Same as B, and claim lag. |

Recommendation: **Option A.** It is the only option that needs no server and no paid plan, and it genuinely enforces access: every rule is evaluated by Firebase against the verified `auth.uid`, and the flags it consults can be written only by the Superuser (or by the Admin SDK script). What A gives up is in-app password reset by an Admin and self-service "forgot password" (there is no deliverable email). Section 4.5 states the replacement and the user impact.

**Binding user decision: the project stays on the free Spark plan permanently and must still be genuinely secure.** B and C are rejected, not deferred. Nothing in this design depends on Cloud Functions, custom tokens, custom claims or any Blaze feature. The Admin SDK is a free library run on the user's own machine; it is not a hosted server.

### 2.1 Free-plan feasibility (Spark, binding)

The figures in this subsection come from the Firebase pricing and limits pages as read during iteration 1. They were not re-fetched in this revision and carry no date; **treat them as unverified and re-confirm in the console before cutover** (Realtime Database usage tab, Authentication usage). Pages: `https://firebase.google.com/pricing` and `https://firebase.google.com/docs/database/usage/limits`.

- Realtime Database on Spark: about 100 simultaneous connections (a tab or device with an open listener), 1 GB stored, about 10 GB/month downloaded. Exceeding a Spark limit throttles or stops service rather than billing. Attendance data is a few kilobytes per member per year, so storage is not a concern. More than about 100 people online at once would be refused; the team is well below that, but it is a hard ceiling to watch. Download volume should fall: today every client downloads the whole `appData` blob on each change, whereas Employees will listen only to their own paths and Managers and Admins to their team.
- Authentication, Email/Password: I found no charge or user cap for Email/Password on the pages read. The runbook has the user confirm this in the console. The design sends no email and no SMS, so email-send quotas do not apply.
- Admin SDK: free, runs locally. `importUsers` is an Auth management API; I found no Spark restriction on it. The scratch-project gate in section 8 confirms it works before the real run.
- Cloud Functions, server-minted tokens and custom claims: excluded (server or Blaze).
- Security rules and the Database emulator: free.
- Rule evaluation limits: Realtime Database caps the data lookups a single rule evaluation may perform. I have not verified the cap, and this design does not assume a number. Every rule reads the caller's profile through `root.child('usersV2').child(auth.uid)`; the emulator tests (section 13) include the worst cases (Admin writing a member's attendance, Manager reading a team, the move write) **Decision, with no deferred fallback: the data model stays as in section 3 and there is no denormalized `usersV2/{uid}/auth` summary node.** An acceptance gate applies instead. The PR must record (a) the byte size of the expanded `database.rules.json` and (b) the emulator result for the three worst cases. If any case fails with a lookup-limit or size error, implementation stops and returns to design review; the implementer must not improvise a denormalization. Reason for not adopting the summary node now: it is a second copy of the role flags that every writer (Superuser flag change, terminate, first team assignment, move) would have to keep consistent with the profile, creating drift risk in the very data the rules trust, in order to guard against a limit that may not bind. Custom claims are not an option.

What free-plan rules can and cannot express, and what we do instead:

| Requirement | Can rules do it on Spark? | Free alternative used |
|---|---|---|
| Team isolation of reads | Yes, if the team is in the path | `teamData/{teamId}/...` per-team paths (section 3) |
| Roles and team come from a trusted place | Yes, from `usersV2/{uid}` which only the Superuser can change | Section 7 |
| Unprivileged self-registration without a server minting roles | Yes, by forcing the role flags to `false` on create | Section 7, `usersV2` create rule |
| Stop a client changing its own role or team | Yes (per-field write rules) | Section 7 |
| Disable a terminated user's login | No (needs the Admin SDK `disabled` flag) | Rules deny all data when `terminated === true`; the Auth account still exists but is useless |
| One-time first team assignment | Yes (`!data.exists()` on `teamId`) | Section 7 |
| Set or reset another user's password | No (needs a server or the Admin SDK) | Local Admin SDK script operated by the Superuser (4.5) |
| Self-service forgot-password email | Not with synthetic emails | None by default; real email optional (Q2) |
| Referential integrity across nodes | Partly: rules see the pre-write `root`, not the post-write state | Sequenced writes: claim, then profile, then roster (4.3). Residual name squatting (section 14) |
| Rate limiting / registration approval | No | Firebase Auth built-in throttling only; approval is Q3 |
| Filtered list reads across teams | No (rules cannot filter) | Per-team paths so the allowed set is the whole path |
| Immutable audit trail | No | Not provided |
| Un-spoofable Superuser flag | Yes, via `.write: false` on `isSuperAdmin` | Only the Admin SDK script can set it |

Conclusion: the requirements are feasible on Spark with the listed trade-offs. The visible losses compared with today are the in-app Admin password reset, self-service forgot-password, the 6-character password minimum, and login by full name for suffixed usernames.

## 3. Data model

New paths (exact). Nodes fall into three groups.

**Legacy-only nodes** (read by the legacy app, never written by the migration, denied by the new rules): `appData`, `teamMembers`, `admins`, `managers`, `memberTeams`, `users`.

**Shared nodes** (used by both modes, **not written by the migration**): `teams` and `settings`. Both are already populated and live. Legacy shapes are identical to the secure-mode shapes (`teams/{id}` = `{id, name, createdBy, createdAt}` with `createdAt` an ISO string; `settings/everyoneSeesAll` boolean). `verify` checks every `teams/{id}` has `id` equal to its key and a string `name`. `settings/adminCanEditHolidays` is created later by the Superuser from the secure UI (absent = false), not by the migration. After cutover these two nodes are governed by the new rules (section 7).

**New nodes** (the only paths the migration writes):

```
usersV2/{uid}                                   // uid = Firebase Auth uid
  name: string                                // full name, e.g. "Akshay Gurav"; 1..100 chars
  username: string                            // display copy of the Auth email local part; lowercase [a-z0-9._-], 1..64. Uniqueness is enforced by Auth, not by this field; login uses Auth only
  memberKey: string                           // nameKey(name): '.' -> '___DOT___'; immutable; 1..128 chars; no $ # [ ] / . or control chars
  teamId: string | absent                     // absent = unassigned. Superuser-assigned, or self first assignment
  isAdmin: boolean
  isManager: boolean
  isSuperAdmin: boolean | absent              // rules: .write false, so only the Admin SDK script sets it
  terminated: boolean                         // always present, true or false
  terminatedAt: string (ISO) | absent
  mustResetPassword: true | absent
  registeredAt: string (ISO)
  // NO passwordHash. Credentials live in Firebase Auth only.

memberOwners/{memberKey}: uid                 // write-once claim; only the claimant (or the Superuser) can read it
teamNames/{teamId}: string                    // PUBLIC read. Name only. Used by the pre-login team picker.

teamData/{teamId}/members/{memberKey}: { name, order, uid?, terminated?, addedBy? }
teamData/{teamId}/attendance/{memberKey}/{yyyy-mm-dd}: true
teamData/{teamId}/leaves/{memberKey}/{yyyy-mm-dd}: "leave" | "wfh" | "wfh-email" | "exception" | "planned"
teamData/unassigned/...                       // same shape; bucket for users whose teamId is absent

holidays/{yyyy-mm-dd}: { name }               // new node; signed-in read
passwordResetRequests/{uid}: { requestedBy: uid, requestedAt: string }
migration/cutoverAt: string (ISO)             // Admin SDK only; marker written by migrate.js mark-cutover
```

Decisions and reasons:

- **`memberKey` is the existing sanitized name and never changes.** Attendance is already keyed by name, so migration keeps keys, and a rename only changes `name`. Roster-only members (added by an Admin before they register) get a roster entry without `uid`; a user who registers with that name claims it. This preserves current behaviour, including the caveat that the first person to register a name gets it.
- **`teamId` in the path, not only in a field.** Rules cannot filter a list by a field. A Manager or Admin must read "everything for my team" with one listener, which requires the team in the path. An Employee reads only `.../attendance/{ownKey}`.
- **`teamId` is absent, not `null`, for unassigned.** Realtime Database does not store nulls; rules test it with `exists()`.
- **Why not `attendance/{uid}`?** Roster-only members have no uid, and legacy data is keyed by name.
- **Holidays keyed by date**: legacy is an array of `{date, name}`. The migration reports duplicate dates instead of silently dropping them (section 9).
- **`teamNames` is a deliberate public node** (5.1). Keeping the pre-login picker preserves the sign-up UX. Cost: anyone with the config can read team names. Team ids are opaque push ids. No person data is public. `teams` and `teamNames` are kept in sync by always writing both in one multi-path `update()` on team create, rename and delete (client code, Superuser only), and the migration derives `teamNames` from `teams`.
- **A team Admin's list of members comes from the roster**, not from `usersV2` (RTDB cannot list profiles by field). See 5.3.
- Moving a member between teams (Superuser) is one multi-path `update()` that copies the member's roster, attendance and leaves to the new team path, removes the old copies, and sets `usersV2/{uid}/teamId`. Deleting a team moves its members to `teamData/unassigned` the same way and clears their `teamId` (current behaviour: members become Unassigned; no user is deleted). A user's own first assignment is the one non-Superuser move (4.2 step 6).
- Writes become granular (`.../attendance/{key}/{date}`) instead of rewriting a whole blob. This removes the need for the existing "never overwrite with empty data" guard in `saveToFirebase` for secure mode.

## 4. Authentication flow

Client changes live in `app.js` and `index.html`; `firebase-config.js` gains the auth init and the flag.

### 4.0 Mode selection (cache-safe)

`firebase-config.js` declares `const SECURITY_MODE = "legacy";`. `app.js` must not reference `SECURITY_MODE` directly. It defines once, at the top:

```
const MODE = (typeof SECURITY_MODE !== 'undefined' && SECURITY_MODE === 'secure') ? 'secure' : 'legacy';
```

and uses only `MODE`. In `firebase-config.js` the Auth object is created only inside the same test, `typeof SECURITY_MODE !== 'undefined' && SECURITY_MODE === 'secure' && typeof firebase.auth === 'function'`, so in legacy mode our code creates no Auth instance and the legacy path is expected to be inert. The `firebase-auth-compat` script tag in `index.html` is expected to be harmless on its own, but that is unverified: the Realtime Database SDK looks up an auth provider when a database instance is created, so loading the auth component may instantiate Auth internally (probably benign with no signed-in user). The legacy parity check in section 13 decides it. The legacy-mode diff to the `connectionTest` block is only the wrapping condition (a no-op in legacy). `typeof` on an undeclared global does not throw, so a new `app.js` served with an old cached `firebase-config.js` runs in legacy. Anything other than the exact string `"secure"` (a typo, `"Secure"`, `true`, empty) is legacy. All Auth SDK use is behind `MODE === 'secure'` and additionally guarded with `typeof firebase.auth === 'function'`, so a failed load of `firebase-auth-compat` cannot break legacy. In secure mode, if `firebase.auth` is missing, the login screen shows "Could not load sign-in. Reload the page." and nothing else runs. The `connectionTest` write in `firebase-config.js` stays in legacy and is skipped when the mode is secure (the check in `firebase-config.js` uses the same `typeof` expression). The mixed-version case in the other direction (old `app.js`, new `firebase-config.js` set to secure) is legacy code against the new rules: it is blocked, which is why the cutover order in section 10 deploys rules before the flag.

### 4.1 Identity mapping

Auth email = `normalize(username) + "@attendance.local"`. `normalize` lowercases, strips characters outside `[a-z0-9._-]`, collapses repeated dots into one and trims leading and trailing dots (so `j..smith` becomes `j.smith` and never forms an invalid email local part). `.local` is not routable; no email is ever sent. Login accepts username or full name as today. The client builds up to three candidate usernames from the input (the input normalized, `generateUsername(input)` = first initial + last name, and first-two-letters + last name) and tries them in order; `auth/invalid-credential`, `auth/invalid-login-credentials`, `auth/user-not-found` or `auth/invalid-email` moves to the next; after the last candidate all of them map to the single "Incorrect username or password." message. Residual: a user whose username got a random numeric suffix must log in with the username, not the full name. Rejected alternative: a public name-to-username index, which would leak the list of people.

### 4.2 Login

1. Validate non-empty fields. 2. `auth.setPersistence(LOCAL)` if Remember me is ticked, else `SESSION`. 3. `signInWithEmailAndPassword(candidateEmail, password)`. 4. Read `usersV2/{uid}` (own profile is always readable by its owner). If missing, or `terminated === true`: `signOut()` and show "Your account has been terminated. Contact admin." (rules also block all data for terminated users; the client check is for the message). If the profile is missing for an otherwise valid Auth user, that is an interrupted registration the client cannot repair: it cannot enumerate claims, and the name, team and registration time of the abandoned attempt are not recoverable. Sign out and show "Account not set up. Contact admin." The Superuser repairs it locally with `migrate.js clear-claim --key K` and `migrate.js delete-auth-user --username x` (section 9), after which the person registers again. A fresh-profile path is deliberately not provided. Failures inside a live registration are already rolled back by the client (4.3 step 4). 5. If `mustResetPassword`: force the set-new-password prompt (4.6) before `unlockApp()`. 6. Two idempotent repairs and one choice:
   - **6a. Team pick (three ordered steps, no SELFMOVE clause).** If `teamId` is absent and `canSelfAssignTeam` (not Admin, not Superuser, **not Manager**) and `teamNames` is non-empty, the user picks team T and the client runs: (1) read own `teamData/unassigned/members/{K}`, `attendance/{K}`, `leaves/{K}` (all self-readable); (2) write `usersV2/{uid}/teamId = T` (first-assignment clause); (3) one multi-path `update()` that writes the copies under `teamData/T/...` and sets the three `unassigned` copies to `null`. Step 3 passes the ordinary `BUCKET(T)` clause because step 2 has already set `teamId`; the removals pass the clause `$teamId === 'unassigned' && !newData.exists() && SELF($memberKey)` (no `BUCKET`, since the caller's bucket is no longer `unassigned`). Copies are written to T only where T does not already hold that leaf, and copy happens before delete in the same update, so an interruption never loses data. The sequence is not atomic across steps 2 and 3; login step 6b repairs an interruption. If there was no roster entry yet, step 6b's entry is written to T directly.
   - **6b. Roster self-heal and move repair.** If `teamData/{bucket}/members/{K}` does not exist, create it `{name, order: Date.now(), uid, addedBy: K}` with `name` equal to the profile `name` (the rules require it for member-created entries); if it exists without `uid`, set `uid`. This repairs an interrupted registration (4.3) and an Admin having deleted the entry. **Move repair:** if `teamId` is set and any own `teamData/unassigned/...` copies still exist, redo step 3 of 6a (copy where absent, then delete).
   - **6c.** Otherwise nothing.
   Failure handling for 6a/6b: `permission_denied` or network error shows "Could not finish setting up your team. Try again." and the user stays signed in with an empty-data view; a failure after 6a step 2 is repaired by login step 6b, and because copies are written before the `unassigned` copies are deleted, nothing is lost; step 3 of 6a is a single multi-path update and 6b is a single write. Logged with `console.error(code)`.
7. Resolve identity from `usersV2/{uid}`; compute roles; `unlockApp()`; attach listeners (5.2).

"Remember me" no longer stores the password. Today `attendance_remembered_pass` keeps the plaintext password in localStorage; secure mode never writes it and removes any existing value at login. User-visible: Remember me keeps you signed in instead of pre-filling the password. This is a security improvement and a necessary change.

Errors: wrong password or unknown user show "Incorrect username or password." (one message). `auth/too-many-requests` shows "Too many attempts. Try again later." Network errors show "Connection error. Please try again." Logged only as `console.error` of the error code, never the password.

The current user is never read from `localStorage` in secure mode. `attendance_current_user` becomes a display hint only; `getCurrentUser()` derives from `auth.currentUser` and the loaded `usersV2/{uid}` profile. Rules use `auth.uid` only, so editing JS or storage in dev tools changes the UI at most, not authority.

### 4.3 Register

Rules evaluate against the state before a write, so a brand new user cannot create a profile and the records that depend on it in one write. Registration is therefore four ordered steps. Each is individually validated by rules and each has a defined failure path.

1. **Validate** name (required, max 100, `memberKey` charset per section 3), password (4.7), confirm, team (required once `teamNames` is non-empty; must exist there).
2. **Create the Auth user.** Candidate usernames in order (`generateUsername`, first-two + last, then base + random 2 digits): `createUserWithEmailAndPassword`; on `auth/email-already-in-use` try the next, up to 10, then fail with "Could not allocate a username. Contact admin." No data written yet.
3. **Claim the name.** `set memberOwners/{K} = uid`. Allowed only when the caller has no profile yet and the key is unclaimed. If denied: read `memberOwners/{K}` (a claimant can read their own claim; anyone else gets a denial, so this does not enumerate). If it equals `uid` (a retry of the same account), continue. Otherwise show "This name is already registered. Please login.", `auth.currentUser.delete()`, stop.
4. **Create the profile.** `set usersV2/{uid} = {name, username, memberKey: K, teamId?: picked, isAdmin:false, isManager:false, terminated:false, registeredAt}`. Allowed only if `memberOwners/{K} === uid` (so the profile is bound to the claim made in step 3), `name` maps to `K`, and the create-time constraints in section 7 hold. On failure: delete the claim (owner may delete it while no profile exists), `auth.currentUser.delete()`, show "Registration failed. Try again." If the claim delete or the Auth delete fails, sign out, `console.error(code)`; the orphan Auth account has no profile and no data access, and an orphan claim burns that name until the Superuser clears it with `migrate.js clear-claim`, and the orphan account is removed with `migrate.js delete-auth-user` (residual, section 14).
5. **Create or claim the roster entry** (now a profile exists, so the caller passes the normal self rules): if `teamData/{bucket}/members/{K}` does not exist, create `{name, order: Date.now(), uid, addedBy: K}`; if it exists without `uid` (an Admin pre-added the member), set `uid`. Failure here is non-fatal: the profile exists, the user proceeds, and login step 6b repairs it.
6. Proceed as login step 7.

The Superuser bootstrap in legacy ("first login creates the Superuser") is removed from secure mode: the Superuser's Auth account and profile are created by the migration script (`--superuser "Akshay Gurav"`), which sets `isSuperAdmin: true` and claims `memberOwners`. Registering that name afterwards fails at step 3.

### 4.4 Logout

`lockApp()` is preserved and extended: detach all listeners (existing `_listeners`), `auth.signOut()`, clear in-memory role state (`MANAGERS`, `MEMBER_TEAMS`, `TEAMS`, new `PROFILE`), clear the `attendance_tracker_data` and `attendance_team_members` caches, add the `auth-locked` class, clear the login-screen controls. `onAuthStateChanged(null)` also calls `lockApp()`, so a token expiry or sign-out in another tab locks this tab (this replaces the `storage` event hack in secure mode; it stays for legacy). In secure mode team data is not cached in localStorage.

### 4.5 Password reset (what is possible without a server)

- **Change own password**: possible. `reauthenticateWithCredential(currentPassword)` then `updatePassword(new)`. Replaces the hash comparison.
- **Admin or Superuser resets another member's password**: not possible from a browser; only the Admin SDK can set another user's password. Today's button sets `Temp@123`. In secure mode the button becomes "Request password reset": it writes `passwordResetRequests/{targetUid}` (rules: Superuser, or Admin of the target's team; target is not a Superuser and not the caller). The Superuser runs `node migrate.js reset-password --pending` (or `--username x`) locally, which sets a random 16-character temporary password per request, sets `mustResetPassword: true` on the profile, deletes the request, and prints username and temporary password to the terminal only (never to files or logs) for the Superuser to hand over. User impact: a team Admin cannot complete a reset alone.
- **Self-service "forgot password"**: not available (no deliverable email). The user contacts the Superuser (same flow). Collecting real email addresses would restore it without any paid feature (Q2).
- A roster-only member without an account has no uid; the button is hidden for them.

### 4.6 First-login set-password fallback

Used for (a) users given a temporary password by the migration (everyone under the default `--rotate-all`, or users whose hash could not be imported, section 8), (b) users with `mustResetPassword`, and (c) accounts after an Admin SDK reset. The account exists with a Superuser-distributed temporary password. At sign-in the client sees `mustResetPassword === true` and runs: prompt new password, confirm, `updatePassword`, then remove `usersV2/{uid}/mustResetPassword`. Rule: the user may only change this field from `true` to removed. This is a soft policy: the user already holds the temporary password, so skipping the prompt via dev tools harms nobody but themselves. If `updatePassword` fails with `auth/requires-recent-login`, the client re-authenticates with the temporary password and retries once. Restore (5.3) sets `mustResetPassword` through the Admin-allowed `true` write, as legacy did; the restored member keeps their existing password until they choose a new one at next login.

### 4.7 Password policy

Firebase Auth requires at least 6 characters; the app currently allows 4. Register and change-password raise the minimum to 6 in secure mode (user-visible, forced by Firebase). Whether sign-in with an imported hash works for a password shorter than 6 is not documented. The scratch-project gate (section 8) tests a 4-character and a 5-character password explicitly. If rejected, those users fall back to 4.6; the script cannot identify them in advance (it holds only hashes), so the announcement tells anyone with a short password to expect a reset. After 3 failed attempts in a session the login screen adds "If your password was shorter than 6 characters, ask the Superuser for a reset." The R7 announcement names `reset-password --username` for this. (Under the default rotate-all in section 9 no old password is imported, so this affects only users who opted out of rotation.)

## 5. Client data access

### 5.1 Pre-auth surface

Before sign-in the client reads only `teamNames` (rendered with `textContent`) and `.info/connected`. `loadTeamOptions()` reads `teamNames`; on a read error it keeps the current fallback (pick team after login).

### 5.2 Listeners by role (secure mode)

Attached in `unlockApp()` after the profile loads; all go through the existing `_listen`, so `stopListeners()` cleans them.

| Role | Listeners |
|---|---|
| Superuser | `teamData` (all), `teams`, `holidays`, `settings`, `usersV2` (whole node; allowed by `usersV2/.read: SU`) |
| Admin (with team) | `teamData/{teamId}/members`, `attendance`, `leaves`, `holidays`, `settings`, `teams`, plus one `usersV2/{uid}` listener per roster entry that has a `uid` (allowed by the same-team read clause; the count is bounded by team size) |
| Manager (with team) | `teamData/{teamId}/members`, `attendance`, `leaves`, `holidays`, `settings`, `teams` (no `usersV2` listener beyond own profile) |
| Employee, `everyoneSeesAll` off | `teamData/{bucket}/members/{myKey}`, `attendance/{myKey}`, `leaves/{myKey}`, `holidays`, `settings`, `teams` |
| Employee, toggle on (with team) | the Admin/Manager set. A `permission_denied` callback falls back to the self-only set. |
| Unassigned user | same as Employee-toggle-off, using `teamData/unassigned/...`. Never the team-wide set, even with the toggle on. |

**Where role data for other members comes from (secure mode).** The Superuser derives `ADMIN_MEMBERS`, `MANAGERS`, `MEMBER_TEAMS` and the terminated list from the `usersV2` listener. An Admin derives role badges and restore/reset eligibility for team members from the per-uid profile listeners. Managers and Employees derive nothing about others, so the UI hides Admin/Manager badges for them; this is a deliberate parity gap if legacy showed them. In secure mode `isAdmin(name)`, `isManager(name)` and `getMemberTeamId(name)` are defined as: for the current user, from `PROFILE`; for others, from the listener data above (Superuser: all profiles; Admin: team profiles by roster `uid`; otherwise `false`/`undefined`). A logic test covers each role (section 13).

**Mid-session `permission_denied` (one rule).** On `permission_denied` from any non-fallback listener, the client re-reads `usersV2/{uid}`: if the profile is terminated, it shows the termination message and calls `lockApp()`; otherwise it re-resolves identity (roles, `teamId`) and re-attaches the listeners once. A second denial after the re-attach shows "Access changed. Please sign in again." and calls `lockApp()`. The `everyoneSeesAll` fallback above is unchanged.

`bucket` is the user's `teamId`, or `unassigned` when absent. The `getVisibleMembers()` and `canAdminMember()` helpers stay as the UI layer, fed from the loaded roster; they are no longer the only barrier. `AttendanceData.data` keeps its in-memory shape (`attendance[name][date]`, `leaves[name][date]`, `holidays[]`) assembled from the new paths so rendering does not change; `markAttendance`, `markLeave`, `removeLeave`, holiday and roster operations are re-pointed to granular writes. In `legacy` mode the current code path is untouched.

### 5.3 Admin roster, terminate and restore

The roster entry (`teamData/{teamId}/members/{key}`) is the source of the Admin's member list, including `uid` once the member has registered. Terminate and restore in secure mode:

- Registered member (roster entry has `uid`): one multi-path `update()` sets `usersV2/{uid}/terminated`, `usersV2/{uid}/terminatedAt` and `teamData/{teamId}/members/{key}/terminated`. The profile flag is the enforcement (rules deny all data to a terminated user); the roster flag is what the Admin's "terminated users" section displays. If they ever diverge, the profile wins for access and the roster for display; `verify` reports divergence. For parity with legacy terminate (which removes the member from the Admin list and leaves the Manager list alone) the same `update()` also sets `usersV2/{uid}/isAdmin` to `false` when it was `true`; the rules let an Admin of the target's team write `isAdmin` only to `false` (7.3). `isManager` is not touched. Auth accounts are never disabled; the profile `terminated` flag is the only enforcement, so restore works entirely from the browser. Restore sets `terminated` to `false`, removes `terminatedAt`, and sets `mustResetPassword: true` (an Admin-allowed `true` write), matching legacy where the restored member is asked to set a new password at next login. Restore does not bring back the Admin flag, as in legacy, where the Superuser re-promotes.
- Roster-only member (no `uid`): only the roster `terminated` flag, as today.
- The Admin writes the profile flags through the `ADMIN_OF` rule (section 7): same team as the target, target not a Superuser, target not self. The Admin can read the profiles in their team by uid (taken from the roster), which is what the restore and password-request buttons need.

## 6. Permission matrix (each cell is enforced by rules)

| Path / action | Superuser | Admin (own team) | Manager (own team) | Employee (with team) | Unassigned | Anonymous |
|---|---|---|---|---|---|---|
| Read `teamNames` | R | R | R | R | R | **R** |
| Read `teams`, `holidays`, `settings/*` | R | R | R | R | R | none |
| Read own roster entry, attendance, leaves | R | R | R | R | R (own `unassigned` bucket) | none |
| Read team roster, attendance, leaves | all teams | own team | own team | own team only while `everyoneSeesAll` is on | **none, toggle or not** | none |
| Read other teams' data | R | none | none | none | none | none |
| Write own attendance and leaves (every type: leave, wfh, wfh-email, exception, planned) | W | W | W | W | W | none |
| Write others' attendance and leaves | all | own team | none | none | none | none |
| Roster add/remove/rename/reorder | all | own team | none | none | none | none |
| Create own roster entry / set own `uid` on an unclaimed entry | W | W | W | W | W | none |
| Set `terminated` on a member | all | own team, not Superuser, not self | none | none | none | none |
| Write `isAdmin`, `isManager`, `teamId` (after first set) | W | none | none | none | none | none |
| Write `isAdmin = false` on a member (terminate parity) | W | own team, not Superuser, not self | none | none | none | none |
| Write `mustResetPassword = true` on a member (restore parity); clear own flag | W | own team (set true only) | own flag (clear only) | own flag (clear only) | own flag (clear only) | none |
| First `teamId` self-assignment and the matching own-data move | n/a | none | **none** (waits for the Superuser) | allowed | allowed | none |
| Write `isSuperAdmin` | none (Admin SDK only) | none | none | none | none | none |
| Write `teams`, `teamNames` | W | none | none | none | none | none |
| Write `holidays` | W | only if `settings/adminCanEditHolidays` is `true` | none | none | none | none |
| Write `settings/*` | W | none | none | none | none | none |
| Create `passwordResetRequests/{uid}` | W | own team's members | none | none | none | none |
| Read `usersV2/{uid}` | all | own team (by uid) | own only | own only | own only | none |
| Claim `memberOwners/{key}` | only before having a profile | same | same | same | same | none |
| Terminated user: any data access | none | none | none | none | none | none |
| Legacy-only nodes (`appData`, old `users`, ...) | none | none | none | none | none | none |

Per-type leave permissions: in the current client every leave type (leave, wfh, wfh-email, exception, planned) is gated by the same `canEdit(member)` check as plain attendance (`app.js`, `markLeave`/`markAttendance`), so there is no type that is Admin-only today. The rules therefore apply the same write rule to every leave type, and the tests cover one write per type per role. An Admin with no team assigned (a state the UI does not normally produce) has no team-wide access; they are treated as Unassigned.

## 7. Security rules (complete)

Written to `database.rules.json` (not deployed by this work). Realtime Database rules have no user-defined functions, so the JSON below uses named macros that the build step expands when producing `database.rules.json`, using a word-boundary regex (`\bNAME\b`) applied longest macro name first (`ADMIN_OF` before `ADM`, then `SELF`, `BUCKET`, `KEYRE`, `SU`, `SI`, `TW`, `MGR`, `ME`). Because some expansions contain other macros (`TW` contains `SU`, `ADM` and `MGR`), the expansion **repeats until no macro name remains (fixpoint), with a limit of 10 passes**, and the build **fails if any macro name still appears in the output or the pass limit is hit**; the tests run against the expanded file. The structure and every rule string below is the complete rule set; nothing is elided.

### 7.1 Macros

`ME` = `root.child('usersV2').child(auth.uid)`

| Macro | Expansion |
|---|---|
| `SI` (signed in, has a profile, not terminated) | `auth != null && ME.child('memberKey').exists() && ME.child('terminated').val() !== true` |
| `SU` (Superuser) | `SI && ME.child('isSuperAdmin').val() === true` |
| `ADM(t)` | `SI && ME.child('isAdmin').val() === true && ME.child('teamId').val() === t` |
| `MGR(t)` | `SI && ME.child('isManager').val() === true && ME.child('teamId').val() === t` |
| `SELF(k)` | `SI && ME.child('memberKey').val() === k` |
| `BUCKET(t)` (the caller's own bucket) | `(ME.child('teamId').val() === t || (!ME.child('teamId').exists() && t === 'unassigned'))` |
| *(removed)* | `SELFMOVE` no longer exists; the team-less self move is a sequence of ordinary clauses (4.2 step 6a, 7.4). |
| `TW(t)` (team-wide read) | `(SU) || (ADM(t)) || (MGR(t)) || (SI && ME.child('teamId').val() === t && root.child('settings').child('everyoneSeesAll').val() === true)` |
| `ADMIN_OF(u)` (caller is an Admin of user `u`'s team) | `(SI && ME.child('isAdmin').val() === true && ME.child('teamId').exists() && ME.child('teamId').val() === root.child('usersV2').child(u).child('teamId').val() && root.child('usersV2').child(u).child('isSuperAdmin').val() !== true && auth.uid !== u)` |
| `KEYRE` | `/^[^$#\[\]\/.\x00-\x1f\x7f]{1,128}$/` (in the JSON file, backslashes are doubled). Test-gated like `replace`: if the emulator rejects the control-character range, fall back to `/^[^$#\[\]\/.]{1,128}$/`, strip control characters in the client `nameKey` and report them in `plan` and `verify` as data-domain violations. If `\d` is rejected in the date regexes, use `[0-9]`. |

Note on finding 2: `TW(t)` compares `ME.teamId` to `t` with `===`. An unassigned caller has no `teamId`, so `val()` is `null` and never equals a team id; the unassigned bucket is therefore not team-readable, even with the toggle on. `BUCKET` (which does treat absent as `unassigned`) is used only for the caller's own key.

### 7.2 Create versus update on `usersV2/{uid}` (cascade semantics)

Realtime Database `.read` and `.write` grants cascade down and a child cannot revoke a grant made by an ancestor. `.validate` rules do not cascade: every `.validate` along the path to the written location is evaluated against the resulting data. The profile is designed around both facts:

- The `.write` at `usersV2/$uid` is **create only**: `auth.uid === $uid && !data.exists() && memberOwners/<memberKey> === auth.uid`. Once the profile exists, this grant is false for every write at or below `$uid`, so the child-level `.write` rules are the only grants and they cannot be bypassed by an ancestor. There is deliberately **no** `SU` grant at `$uid` (the Superuser cannot delete or recreate a profile from the client; the Admin SDK script does that), because such a grant would cascade over the `isSuperAdmin: .write false` child.
- When a profile does not exist, a write below `$uid` (for example a user writing only `usersV2/<me>/isAdmin = true`) is allowed by that `$uid`-level grant, but the `.validate` at `$uid` then evaluates the resulting node, which has no required children, and rejects it. A create must supply the whole valid profile.
- The `.validate` at `$uid` requires the seven mandatory children on every write and applies the privilege constraints **only when `!data.exists()`** (create): `isAdmin === false`, `isManager === false`, no `isSuperAdmin`, `terminated === false`, no `terminatedAt`, no `mustResetPassword`, and `name.replace('.', '___DOT___') === memberKey`. Because those clauses are gated by `data.exists()`, they do not block the Superuser's later child writes (for example `isAdmin = true`), which pass the required-children check against the existing profile and are then checked by the `isAdmin` child rule. A consequence: a required child can never be removed by a child write (it fails `hasChildren`), so flags are set to `false`, not deleted.
- `name.replace(...)` relies on `String.replace` replacing every occurrence. If the emulator test shows it replaces only the first, the clause is weakened to a `memberKey` charset check and `name`↔`memberKey` equality is enforced by the client and `verify` only (documented as a residual risk). This is a test-gated item (13).

### 7.3 The rules

```json
{
  "rules": {
    ".read": false,
    ".write": false,
    "teamNames": {
      ".read": true,
      ".write": "SU",
      "$teamId": {
        ".validate": "$teamId !== 'unassigned' && newData.isString() && newData.val().length > 0 && newData.val().length <= 100"
      }
    },
    "teams": {
      ".read": "SI",
      ".write": "SU",
      "$teamId": {
        ".validate": "$teamId !== 'unassigned' && newData.hasChildren(['id', 'name']) && newData.child('id').val() === $teamId",
        "id": { ".validate": "newData.isString()" },
        "name": { ".validate": "newData.isString() && newData.val().length > 0 && newData.val().length <= 100" },
        "createdBy": { ".validate": "newData.isString() && newData.val().length <= 100" },
        "createdAt": { ".validate": "newData.isString() && newData.val().length <= 40" },
        "$other": { ".validate": false }
      }
    },
    "settings": {
      ".read": "SI",
      "everyoneSeesAll": { ".write": "SU", ".validate": "newData.isBoolean()" },
      "adminCanEditHolidays": { ".write": "SU", ".validate": "newData.isBoolean()" },
      "$other": { ".validate": false }
    },
    "holidays": {
      ".read": "SI",
      ".write": "(SU) || (SI && ME.child('isAdmin').val() === true && root.child('settings').child('adminCanEditHolidays').val() === true)",
      ".validate": "newData.hasChildren()",
      "$date": {
        ".validate": "$date.matches(/^\\d{4}-\\d{2}-\\d{2}$/) && newData.hasChildren(['name'])",
        "name": { ".validate": "newData.isString() && newData.val().length > 0 && newData.val().length <= 100" },
        "$other": { ".validate": false }
      }
    },
    "usersV2": {
      ".read": "SU",
      "$uid": {
        ".read": "auth != null && (auth.uid === $uid || (SU) || (SI && ME.child('isAdmin').val() === true && ME.child('teamId').exists() && data.child('teamId').val() === ME.child('teamId').val()))",
        ".write": "auth != null && auth.uid === $uid && !data.exists() && root.child('memberOwners').child(newData.child('memberKey').val()).val() === auth.uid",
        ".validate": "newData.hasChildren(['name', 'username', 'memberKey', 'isAdmin', 'isManager', 'terminated', 'registeredAt']) && (data.exists() || (newData.child('isAdmin').val() === false && newData.child('isManager').val() === false && !newData.child('isSuperAdmin').exists() && newData.child('terminated').val() === false && !newData.child('terminatedAt').exists() && !newData.child('mustResetPassword').exists() && newData.child('name').val().replace('.', '___DOT___') === newData.child('memberKey').val()))",
        "name": {
          ".write": "(SU) || ADMIN_OF($uid)",
          ".validate": "newData.isString() && newData.val().length > 0 && newData.val().length <= 100"
        },
        "username": {
          ".validate": "newData.isString() && newData.val().matches(/^[a-z0-9._-]{1,64}$/) && (!data.exists() || newData.val() === data.val())"
        },
        "memberKey": {
          ".validate": "newData.isString() && newData.val().matches(KEYRE) && (!data.exists() || newData.val() === data.val())"
        },
        "teamId": {
          ".write": "(SU) || (auth.uid === $uid && !data.exists() && data.parent().exists() && data.parent().child('isAdmin').val() !== true && data.parent().child('isSuperAdmin').val() !== true && data.parent().child('isManager').val() !== true)",
          ".validate": "newData.isString() && root.child('teamNames').child(newData.val()).exists()"
        },
        "isAdmin": { ".write": "(SU) || (ADMIN_OF($uid) && newData.val() === false)", ".validate": "newData.isBoolean()" },
        "isManager": { ".write": "SU", ".validate": "newData.isBoolean()" },
        "isSuperAdmin": { ".write": false, ".validate": "newData.isBoolean()" },
        "terminated": { ".write": "(SU) || ADMIN_OF($uid)", ".validate": "newData.isBoolean()" },
        "terminatedAt": {
          ".write": "(SU) || ADMIN_OF($uid)",
          ".validate": "newData.isString() && newData.val().length <= 40"
        },
        "mustResetPassword": {
          ".write": "(SU) || (ADMIN_OF($uid) && newData.val() === true) || (auth.uid === $uid && data.val() === true && !newData.exists())",
          ".validate": "newData.val() === true"
        },
        "registeredAt": {
          ".validate": "newData.isString() && newData.val().length <= 40 && (!data.exists() || newData.val() === data.val())"
        },
        "$other": { ".validate": false }
      }
    },
    "memberOwners": {
      ".read": "SU",
      "$memberKey": {
        ".read": "auth != null && data.val() === auth.uid",
        ".write": "auth != null && !root.child('usersV2').child(auth.uid).exists() && ((!data.exists() && newData.val() === auth.uid) || (data.val() === auth.uid && !newData.exists()))",
        ".validate": "newData.isString() && $memberKey.matches(KEYRE)"
      }
    },
    "passwordResetRequests": {
      ".read": "SU",
      "$uid": {
        ".write": "(SU) || ADMIN_OF($uid)",
        ".validate": "newData.hasChildren(['requestedBy', 'requestedAt']) && newData.child('requestedBy').val() === auth.uid && newData.child('requestedAt').isString()",
        "$other": { ".validate": false }
      }
    },
    "teamData": {
      ".read": "SU",
      "$teamId": {
        "members": {
          ".read": "TW($teamId)",
          "$memberKey": {
            ".read": "(SELF($memberKey)) && BUCKET($teamId)",
            ".write": "(SU) || (ADM($teamId)) || ((SELF($memberKey)) && ((!data.exists() && BUCKET($teamId)) || ($teamId === 'unassigned' && !newData.exists())))",
            ".validate": "newData.hasChildren(['name']) && (!newData.child('uid').exists() || newData.child('uid').val() === data.child('uid').val() || (SU) || (newData.child('uid').val() === auth.uid && $memberKey === ME.child('memberKey').val())) && (data.exists() || (SU) || (ADM($teamId)) || newData.child('name').val() === ME.child('name').val())",
            "name": { ".validate": "newData.isString() && newData.val().length > 0 && newData.val().length <= 100" },
            "order": { ".validate": "newData.isNumber()" },
            "addedBy": { ".validate": "newData.isString() && newData.val().length <= 100" },
            "terminated": { ".validate": "newData.isBoolean() && (newData.val() === false || (SU) || (ADM($teamId)))" },
            "uid": {
              ".write": "(SELF($memberKey)) && BUCKET($teamId) && !data.exists() && newData.val() === auth.uid",
              ".validate": "newData.isString()"
            },
            "$other": { ".validate": false }
          }
        },
        "attendance": {
          ".read": "TW($teamId)",
          "$memberKey": {
            ".read": "(SELF($memberKey)) && BUCKET($teamId)",
            ".write": "(SU) || (ADM($teamId)) || ((SELF($memberKey)) && (BUCKET($teamId) || ($teamId === 'unassigned' && !newData.exists())))",
            ".validate": "newData.hasChildren()",
            "$date": {
              ".validate": "$date.matches(/^\\d{4}-\\d{2}-\\d{2}$/) && newData.val() === true"
            }
          }
        },
        "leaves": {
          ".read": "TW($teamId)",
          "$memberKey": {
            ".read": "(SELF($memberKey)) && BUCKET($teamId)",
            ".write": "(SU) || (ADM($teamId)) || ((SELF($memberKey)) && (BUCKET($teamId) || ($teamId === 'unassigned' && !newData.exists())))",
            ".validate": "newData.hasChildren()",
            "$date": {
              ".validate": "$date.matches(/^\\d{4}-\\d{2}-\\d{2}$/) && (newData.val() === 'leave' || newData.val() === 'wfh' || newData.val() === 'wfh-email' || newData.val() === 'exception' || newData.val() === 'planned')"
            }
          }
        }
      }
    }
  }
}
```

The `migration` node and everything else not listed fall under the root `.read: false` / `.write: false`; only the Admin SDK (which bypasses rules) touches `migration`.

### 7.4 How the tricky parts work

- **Registration order.** `memberOwners` claim needs no profile; the profile create needs the claim; roster writes need the profile. Each step's precondition is true in the pre-write state of its own write.
- **Self move (login 6a, no SELFMOVE).** The pre-write profile is evaluated per write. Step 2 sets `teamId` through the first-assignment clause. Step 3 is then an ordinary write: the copies under `teamData/T/...` pass `BUCKET(T)` (create-only on `members`, the normal self rule on attendance and leaves), and the `unassigned` removals pass `$teamId === 'unassigned' && !newData.exists() && SELF`. A team-less caller has no clause that writes into any team's tree: `BUCKET(T)` is false for every real team while `teamId` is absent. The earlier residual (a team-less account planting entries in every team) is therefore gone. A member-created roster entry must carry the profile's own `name`, so a spoofed colleague name cannot be created by a member. Rule evaluation order within a multi-path write is not relied on.
- **Roster `uid`.** `uid` may be set only to the caller's own uid and only when the node key equals the caller's own `memberKey`, or kept unchanged, or set by the Superuser. A team Admin cannot attach their own uid (or anyone's) to another member's entry. An Admin who deletes and recreates an entry creates it without `uid`; the member's login step 6b restores it.
- **Terminated users** fail `SI`, so every rule that includes `SI` denies them. They can still read their own profile (`auth.uid === $uid`) so the app can show the message.
- **Superuser** is whoever has `isSuperAdmin: true`, which only the Admin SDK can write.

## 8. Importing existing passwords (verified, with a hard gate)

Verified in this revision by fetching the current Firebase doc "Import users from your app", `https://firebase.google.com/docs/auth/admin/import-users`, and reading the "Import users with MD5, SHA and PBKDF hashed passwords" section. What the page states: the algorithms in this family are `MD5`, `SHA1`, `SHA256`, `SHA512`, `PBKDF_SHA1` and `PBKDF2_SHA256`; "you must provide the number of rounds ... between 1 and 8192 for SHA1, SHA256 and SHA512"; "If a single hashing function was originally applied, rounds must be set to 1"; the Node.js example passes `passwordHash` and `passwordSalt` as byte `Buffer`s and `{ hash: { algorithm: ..., rounds: ... } }` as options; per-user failures come back in `userImportResult.errors` (each with `index` and `error`); and on first successful sign-in "Firebase re-hashes the user's password with the internal Firebase hashing algorithm". **So `importUsers` supports `SHA256` with `rounds: 1`.**

What the page does **not** state, and what is therefore unverified: whether `passwordSalt` may be omitted for `SHA256` (the example shown is PBKDF2 with a salt), the exact byte layout when it is omitted (expected: `SHA256(password)`), and whether sign-in works for a password shorter than 6 characters.

The app's hash (`hashPassword` in `app.js`) is `crypto.subtle.digest('SHA-256', TextEncoder.encode(password))` rendered as lowercase hex: unsalted, one round, which matches "SHA256, rounds 1, no salt" if the omitted-salt behaviour is as expected. The script converts with `Buffer.from(hex, 'hex')` and requires exactly 32 bytes; anything else is unusable and takes the fallback (4.6).

**Scope under the rotation default.** Section 9 never imports a hash for the Superuser, any Admin or any Manager, and the runbook default (`--rotate-all`) imports no hash for anyone. The hash import and the gate below therefore apply only to non-privileged users when the user explicitly opts out of rotation. Old hashes are treated as already disclosed (section 14).

**Hard gate (only if hash import is used).** The emulator is not valid proof (the Auth emulator does not necessarily verify imported hashes the way production does). Before any real import:

1. In a **scratch Firebase project** (not the live project, not the emulator), import one account with a known password via the same `importUsers` call the script uses, then sign in through the real client SDK (`signInWithEmailAndPassword`). Repeat with a 4-character and a 5-character password.
2. Record the result. Only if the normal-length case signs in does the user pass `--hash-test-passed` to `migrate.js run`; **`run` aborts without that flag** unless `--no-hash-import` is given, which skips hash import entirely and puts every user on the 4.6 fallback.
3. The script checks `result.errors` after every batch. It prints a per-user error code (never a hash). If any user fails for a reason other than an expected malformed/missing hash, it stops after the batch and reports; the user decides whether to continue.
4. The script supports `--only <username>` to import and test a single account on the real project first, and the fallback exists for every account the import rejects.

Never print hashes: the script logs only usernames, counts and error codes. Hashes stay in memory and are passed to the SDK.

## 9. Migration plan (non-destructive)

Tool: `tools/migrate-to-secure/migrate.js` (Node, `firebase-admin`), run by the user with their own service-account key via `GOOGLE_APPLICATION_CREDENTIALS`. The agent never runs it against the live project.

**Write guard.** The script writes only under these prefixes: `usersV2/`, `memberOwners/`, `teamNames/`, `teamData/`, `holidays/`, `migration/`. Any other path (including `teams`, `settings` and every legacy-only node) is rejected in code before the call, and the unit tests assert it. It never calls `remove` or `set` on an old or shared path. Auth users are created through the Auth API (a separate system).

**Source of truth and reconciliation (the legacy copies drift).** The live app does not take roles or team from `users/{key}` alone. `isAdmin()` honors the `admins` array, `isManager()` the `managers` array, and the team comes from `memberTeams` with `users/{key}.teamId` as a second copy. They disagree in practice: legacy terminate removes the name from `admins` but leaves `users/{key}.isAdmin` unchanged, and register writes `isAdmin: false` and never `isManager`. Taking only `users/*` would demote or promote people. The migration therefore derives, per user key `K` (the name, `.` encoded):

- `isAdmin` = name is in `admins`, or name equals `SUPER_ADMIN`. (The live UI honors the array; a terminated user is out of `admins`, so they migrate with `isAdmin: false`.)
- `isManager` = name is in `managers`.
- `teamId` = `memberTeams[K]` if present, else `users[K].teamId` if present, else absent (unassigned). A `teamId` that is not a key of `teams` is reported as a conflict.
- Every user where `users/*` and the arrays/`memberTeams` disagree is listed by `plan` (flag, both values, the value that would be used). `run` aborts if there is any disagreement unless `--prefer arrays` is given (arrays and `memberTeams` win, because that is what the live UI honors); the choice is printed. `verify` recomputes the effective roles from the legacy arrays and compares them with the profile flags.

**Roster construction.** `teamMembers` is a flat array of names. A roster entry `teamData/{team}/members/{K}` is `{name, order, uid?, terminated?}` with `order` = the index in `teamMembers`; `addedBy` is omitted. `run` creates roster entries for three groups, so no data is dropped and `verify` can match everything:

1. every name in `teamMembers`, under its `teamId` or `unassigned`;
2. every terminated user (legacy terminate removes them from `teamMembers` but keeps attendance, leaves and the `users` record): `{name, order, terminated: true}` under their `teamId` or `unassigned`, so the Admin's terminated list and restore keep working (5.3);
3. every key that has attendance or leaves but appears in neither group: `{name: decoded key, order}` under its `memberTeams` team or `unassigned`.

Groups 2 and 3 get `order` values after the highest index of group 1, in ascending name order, so reruns are deterministic. No attendance or leave entry is ever skipped. After `run`, the count of attendance/leave keys without a roster entry in the same team bucket must be zero; `verify` fails otherwise.

**Profile defaults.** Legacy `users` records often lack fields the rules require on every profile write (`terminated`, `isManager`, `username`, `registeredAt`). Because the Admin SDK bypasses rules, a gap would import cleanly and then break the first later client write (for example an Admin terminating that user). `run` therefore sets: `name` = `users.name`, else the decoded key; `memberKey` = `nameKey(name)`; `username` = `users.username` if present, else generated as in 4.1 and normalized; `terminated` = `users.terminated === true`; `isAdmin`/`isManager` booleans per the reconciliation; `registeredAt` = `users.registeredAt`, else `users.createdAt`, else the migration timestamp. A username that normalizes to empty (non-ASCII letters are stripped) or collides with another user or an existing Auth email gets a numeric suffix (2, 3, ...) assigned in ascending key order so reruns are stable; an empty base becomes `member`. The resulting username list, with no passwords, is written to `migration-usernames-<timestamp>.csv` and printed by `plan`, and the user includes it in the R7 announcement. `plan` and `verify` fail on any `usersV2` profile that lacks one of the seven mandatory fields with the right type, or whose `username` or `memberKey` violates the rules' patterns.

Commands:

- `plan` (and `--dry-run` on any write command): reads old data, prints exactly what it would create, writes nothing, exits 0. The report includes: counts per team; users to create/import; hash import eligibility (32-byte hex or not); members without a team; attendance or leave entries for names not on the roster; terminated users; duplicate holiday dates; username collisions; the password-rotation count line above; and **data-domain violations that the rules would reject**: attendance values other than `true`, leave values outside `leave|wfh|wfh-email|exception|planned`, dates not `YYYY-MM-DD`, names whose `memberKey` fails the `KEYRE` charset or exceeds 128 characters or whose `name`↔`memberKey` mapping fails, holiday names over 100 characters, `teams` entries failing the shape check. The script writes such data anyway (Admin SDK bypasses rules) only if the user passes `--allow-invalid`; otherwise `run` aborts, because data the client can never rewrite would be created. Out-of-domain legacy values are shown so the user can fix them in the legacy app first.
- `run` (needs `--yes`, and one of `--rotate-all` (the runbook default), `--hash-test-passed` or `--no-hash-import`, and refuses to start if `migration/cutoverAt` exists unless `--force-after-cutover`):
  1. **Password policy (rotation is the default).** The Superuser and every user whose effective role is Admin or Manager **never** get an imported hash; they are created with `createUser` and a random password of at least 16 characters plus `mustResetPassword: true`. This cannot be disabled. `--rotate-all` (the default in the runbook) extends this to every user, so no legacy hash is imported for anyone and the hash gate in section 8 is not needed. Only if the user explicitly opts out (`--no-rotate-all`, which requires `--hash-test-passed`) are non-privileged users created through `importUsers` (SHA256, rounds 1) in batches of up to 1000. Old hashes are treated as already disclosed (section 14). `plan` prints a line **`N users hash-imported, M users rotated (Superuser a, Admins b, Managers c, others d)`**. Users who are not hash-imported (rotated, without a valid hash, with `mustResetPassword`, or whose import was rejected) get `createUser` with a random password and `mustResetPassword: true`. Their temporary passwords go to `migration-temp-passwords-<timestamp>.csv` in the directory given by `--out-dir` (default: the current directory) and are never printed. POSIX file modes are not enforced on Windows, so the script does not rely on them. After writing, it prints the path and the instruction to restrict access (Windows: `icacls <file> /inheritance:r /grant:r "%USERNAME%:F"`; macOS and Linux: `chmod 600 <file>`), and `--encrypt-csv` writes the file AES-256-GCM encrypted with a passphrase read from a prompt (Node `crypto`), readable only through `migrate.js show-passwords <file>`, which prints to the terminal. The script reminds the user to delete the file after distributing the passwords; the file is a local, git-ignored CSV and must be deleted once every temporary password has been handed over. It refuses to run unless the file pattern is in `.gitignore`. **Terminated users are imported enabled**: the script never sets Auth `disabled`, so restore works from the browser (5.3). Enforcement is `terminated: true` on the profile, which makes the rules deny them all data and makes login show the termination message.
  2. The **Superuser** named by `--superuser` (must equal the `SUPER_ADMIN` constant in `app.js`, which the script reads and checks) gets an Auth user even if the legacy data has no record or hash for them (the legacy login allows a Superuser with no `users` entry): a random 16+ character password with `mustResetPassword: true` goes into the CSV (a legacy hash for the Superuser, if any, is never imported). The script sets `isSuperAdmin: true` on that one profile only.
  3. Write `usersV2/{uid}`, `memberOwners/{memberKey}` (one per registered user and per roster entry that has an account), `teamNames` (derived from the existing `teams`), `teamData/*/members|attendance|leaves` (including the roster entries for terminated users and roster-less keys, see "Roster construction"), `holidays`.
  4. **Add-only semantics.** Every write is at leaf level (`teamData/{t}/attendance/{key}/{date}`, `.../leaves/{key}/{date}`, each roster field, each holiday, each profile field). If the new path already holds a **different** value, the script does **not** overwrite it; it records a conflict in the report. Equal values are skipped. This makes `run --resume` safe to repeat and safe against newer data written in secure mode.
  5. `--mirror` (pre-cutover only; refused if `migration/cutoverAt` exists): after the add-only pass, builds the **desired new state with the same transformer as `run`** (including roster `uid`, `terminated`, `order` and roster groups 1 to 3, and the derived `holidays`) and deletes only leaves under `teamData/`, `holidays/` and `teamNames/` that are **absent from that desired state**. Data the migration itself wrote (for example `members/{key}/uid` and the group 2 and 3 entries) is part of the desired state and is never deleted. It exists because legacy edits made after the first run (a toggle off, a rename) cannot propagate through add-only. It requires `--confirm-no-secure-usage`, an explicit statement from the user that nobody has used secure mode against the live project. It still only touches new paths.
  6. **`run --resume --refresh`** (pre-cutover only: refused if `migration/cutoverAt` exists, and requires `--confirm-no-secure-usage`). It carries legacy changes made between R6 and R8 into the new structure. Semantics: (a) recompute the whole desired new state from legacy with the same transformer as `run` (users created in legacy since R6 are created as in `run`); (b) for `usersV2` fields `isAdmin`, `isManager`, `isSuperAdmin`, `teamId`, `terminated`, `terminatedAt`, `mustResetPassword` and `name`, **overwrite** to the desired value, and remove fields that are absent in the desired state (this is the one deliberate exception to add-only, limited to these profile fields of users that exist in legacy; the Admin SDK writes them, and only new paths are touched); a team change also moves the member's roster, attendance and leaf copies to the new team bucket via the same desired-state diff; (c) keep a local `migration-state.json` (git-ignored; the script refuses to run unless the pattern is in `.gitignore`) holding, per user, only `HMAC-SHA256(localSecret, legacyHash)` (never a raw hash). `localSecret` comes from the `MIGRATION_STATE_SECRET` environment variable or a prompt and is never stored in the file. At refresh, for any user whose fingerprint changed: if the user is hash-imported (opted out of rotation, non-privileged), call `importUsers` again with the same `uid` (it upserts by uid); if the hash is unusable, or the user is now Superuser/Admin/Manager (promoted after R6, so a hash must not be kept), set a new random temporary password plus `mustResetPassword` and add it to the CSV. Under the default rotate-all no legacy hash is ever imported, so a legacy password change after R6 is moot (the user still has the temporary password); (d) print each changed user (username only, no values); (e) **`teamNames`**: for `teamNames/{id}`, overwrite the value to the current `teams/{id}.name` (a rename) and delete ids that are absent from `teams` (a deletion); members of a deleted team become unassigned through the `teamId` removal in (b). This is the second deliberate exception to add-only, limited to `teamNames/` and under the same pre-cutover and confirmation conditions; `teams` itself is still never written. `--resume` inherits the R6 password flags (`--rotate-all`) when they are not repeated, and the runbook repeats them for clarity. `--dry-run` shows the same list and writes nothing.
- `verify`: read-only; exits non-zero on any difference. Checks:
  - user count: legacy users vs `usersV2` vs Auth users;
  - roster count per team, and every legacy member, terminated user and attendance/leave key maps to exactly one roster entry in exactly one team; unmatched count must be zero;
  - attendance entry count and a SHA-256 checksum over a canonical sorted serialization of `(teamId, memberKey, date)`; leaves count and checksum of `(teamId, memberKey, date, type)`; holidays count;
  - `teams` shape check and `teams` ids equal `teamNames` ids (sync);
  - **exactly one** `usersV2` profile has `isSuperAdmin: true`, its Auth user exists, and its name equals `SUPER_ADMIN`;
  - roster `terminated` agrees with profile `terminated` for registered members;
  - effective roles recomputed from the legacy arrays and `memberTeams` agree with the profile flags and `teamId` (before cutover);
  - every `usersV2` profile satisfies the seven-field rule and the `username`/`memberKey` patterns; profile `username` equals the Auth email local part (warning only, since it is a display copy);
  - no `memberKey` appears in more than one team's `members` (failure before cutover, where legacy had one namespace; warning after cutover, for the Superuser to reconcile with the move action, see 10.1);
  - `memberOwners` claims whose uid has no profile are listed as orphans (warning, resolved with `clear-claim` and `delete-auth-user`);
  - after `mark-cutover`, entries present only in the new structure are listed as **new-only** (informational, not failures), so post-cutover verify does not report real secure-mode edits as differences.
  Checksums are over attendance data, never passwords.
- `mark-cutover`: writes `migration/cutoverAt`. After it exists, `run` refuses to start without `--force-after-cutover` and `--mirror` is refused outright.
- `clear-cutover --yes`: removes `migration/cutoverAt` and nothing else. It is the supported step for re-cutting over after a rollback (section 11).
- `reset-password`: see 4.5.
- `set-superuser --username x`, `clear-claim --key K` and `delete-auth-user --username x`: Admin SDK recovery commands (a mistyped Superuser, an orphan name claim, an Auth user left behind by an interrupted registration). `delete-auth-user` refuses if the user has a profile.
- `export-new --to-json file`: read-only dump of `teamData` and `holidays`, for manual recovery after a rollback.

Idempotent and resumable: re-running `run` skips users that already exist (matched by email), and the add-only leaf semantics mean it cannot clobber newer data. Old data is never deleted by anything in this work; deleting `appData` and the other old nodes is a manual, explicitly approved step after a stabilization period.

## 10. Rollout and cutover

Feature flag in `firebase-config.js`: `const SECURITY_MODE = "legacy";` (`"legacy"` default | `"secure"`), read through the `MODE` guard in 4.0. In legacy mode the new code is expected to be inert: no Auth SDK calls from our code, no new paths, behaviour and Firebase traffic expected to match today (confirmed by the legacy parity check in section 13, not assumed). Merging the PR is safe on its own. Nothing changes for users until step R10.

**Do not use secure mode against the live project before cutover.** Test secure mode against a scratch/staging Firebase project (own config), where the migration and the rules can be exercised end to end.

This is the single ordered runbook; section 11 and section 12 refer to these step numbers. The user performs the console and script steps; the agent cannot.

| # | Step |
|---|---|
| R1 | **Backup and record.** Realtime Database, Data tab, three-dot menu, Export JSON of the root. Store it securely (it contains password hashes). Screenshot or copy the live Rules tab so rollback can restore the rules that are actually deployed. |
| R2 | **Enable Email/Password** in Authentication, Sign-in method. Leave Email link off. Confirm in Authentication usage that there is no user cap that matters. |
| R3 | **Create a service account key** (Project settings, Service accounts, Generate new private key). Keep it out of the repo. Install Node 18+ and run `npm install` in `tools/migrate-to-secure`. |
| R4 | **Staging gate** in a scratch Firebase project: an explicit `@attendance.local` create-plus-sign-in check (including a username that normalizes with an edge or doubled dot), a sign-in with a rotated temporary password, the hash test of section 8 only if the user opts out of rotation (including 4- and 5-character passwords), the rules tests, and a secure-mode run of the app against it. Optionally turn on email enumeration protection there and confirm registration still works (13, Q10). |
| R5 | **Dry run:** `migrate.js plan` and `migrate.js run --dry-run`. Review the report, including data-domain violations; fix legacy data first if needed. |
| R6 | **Run** the migration on the live project (`run --yes --rotate-all`, the default: every user gets a random 16+ character temporary password with `mustResetPassword`, delivered via the local git-ignored CSV, which must be deleted after distribution), then `migrate.js verify`. Resolve any difference. |
| R7 | **Announce** the freeze window and the short interruption at cutover; tell users the password minimum is now 6 and that everyone receives a temporary password and must choose a new one at first login (the Superuser rotates immediately; users who keep an imported password, if the user opted out of rotation, should change it after first login). **Include: no password, role or team changes in the legacy app after R6** (fallback if `--refresh` is not used). Mention that a user whose password is shorter than 6 characters or who is locked out should ask the Superuser, who runs `reset-password --username`. |
| R8 | **Freeze, final sync:** everyone stops editing. Run `run --yes --rotate-all --resume --refresh --mirror --confirm-no-secure-usage`, then `verify`; it must PASS, including the exactly-one-Superuser check. |
| R9 | **Deploy `database.rules.json`** (`firebase deploy --only database`, or paste into the Rules tab). From this moment every legacy client is denied, which also closes the window in which stale clients could still write `appData`. |
| R10 | **Publish `SECURITY_MODE = "secure"`** (merge the one-line change; GitHub Pages deploy). Immediately run `migrate.js mark-cutover`. Between R9 and R10 users see errors for a few minutes; that is accepted and announced. |
| R11 | **Smoke test** as each role (section 13 manual list). Hand out any temporary passwords out of band from the CSV, then delete the CSV. Optionally enable email enumeration protection if R4 showed it is safe. |
| R12 | **Stabilize** for a period the user chooses (suggest 2 weeks), then, on explicit approval only, remove old nodes. Not part of this change. |

Rejected alternative: flag first, rules second. It leaves a gap in which secure clients write `teamData` while stale legacy clients still write `appData`, and the writes made in that gap exist on only one side. If the user insists on flag-first, R8's sync must be repeated after the rules deploy and secure-mode writes in the gap must be forbidden by announcement. The `mark-cutover` marker and add-only semantics limit damage but do not remove that gap.

### 10.1 Behaviour changes to announce (R7)

| Area | Legacy | Secure mode | Why |
|---|---|---|---|
| Password minimum | 4 characters | 6 | Firebase Auth minimum |
| Passwords at cutover | Existing passwords | Everyone gets a temporary password (default rotate-all) and sets a new one at first login | Old hashes are treated as already disclosed |
| Remember me | Pre-fills a plaintext password stored in localStorage | Keeps you signed in; no password stored | Security |
| Admin password reset | Admin sets a temporary password in the UI | "Request password reset"; the Superuser runs `reset-password` locally and hands over the temporary password | Only the Admin SDK can set another user's password |
| Forgot password | Ask an Admin | Ask the Superuser | No deliverable email |
| Login by full name | Works | Works unless the username got a numeric suffix; the username list is announced | 4.1 |
| Terminate | Marks terminated, removes from team list and from `admins` | Same, plus the profile flag; Auth account stays enabled; `isAdmin` set to `false`; Manager flag untouched | Rules enforce `terminated`; parity |
| Restore | Clears flag, member is told to set a new password at next login, Admin may reset it now | Same prompt at next login; the Admin's "reset now" option becomes a reset request; the old password keeps working until the member changes it; the Admin flag is not restored | An Admin cannot set a password |
| Pre-added roster member who registers under a different team | One name-keyed namespace; `memberTeams` is overwritten, history follows the person | A second roster entry is created in the chosen team and the earlier entry and history stay in the team where the Admin added them; the person sees only the new one | Per-team paths; reading the other team to detect it is correctly denied |
| Team-less Manager | Could pick a team at login and gain team-wide read | No team picker; sees "Waiting for team assignment. Ask the Superuser to assign your team." and an empty view until the Superuser assigns a team | Closes a privilege escalation (Q13) |
| Brief interruption | n/a | Errors between R9 and R10 for a few minutes | Cutover order |

On the pre-added-member row: the design takes the documented-behaviour-change option. `verify` reports any `memberKey` present in more than one team after cutover, and the Superuser's existing move action reconciles it. A public `preAdded/{key}: teamId` hint that would force the registrant into the pre-adding team was considered and not chosen, because it would add a readable name-to-team index and change sign-up behaviour; it can be added later if wanted.

## 11. Rollback

Until R12, nothing old was modified, so rollback is: (1) paste the rules recorded in R1 back into the Rules tab, (2) set `SECURITY_MODE = "legacy"` and republish, (3) users reload. `appData`, `users` (with hashes) and the other legacy nodes are intact, and `teams`/`settings` were never rewritten, so the legacy app works as before. Rollback before R9 changes nothing live.

Data edited in secure mode (new paths) is not copied back automatically, so a rollback after real use loses those edits from the legacy view unless they are re-entered. `migrate.js export-new --to-json file` dumps `teamData` and `holidays` for manual recovery. Auth accounts and the new nodes may remain; they are inert in legacy mode. Passwords changed in secure mode do not propagate back to the old hashes: after a rollback those users use their old password, or the Superuser resets them in the legacy UI.

**Retrying after a rollback.** `mark-cutover` blocks `run --resume` and `--mirror`, so a retry needs an explicit sequence. (1) Before rolling back, run `migrate.js export-new --to-json file` and keep the file (it holds the secure-mode edits). (2) Restore the R1 rules, set `SECURITY_MODE = "legacy"`, republish. (3) When ready to try again, run `migrate.js clear-cutover --yes`. (4) Repeat R5 and R6, then R7 and R8. In R8 use `run --yes --rotate-all --resume --refresh --mirror --confirm-no-secure-usage` only if the export shows no secure-mode-only data worth keeping, because `--mirror` removes new-path leaves that the legacy data lacks; otherwise use `run --resume` (add-only) and reconcile the reported conflicts by hand. (5) R9, R10 and `mark-cutover` again.

The live rules are unverified from here: DEPLOYMENT.md says they are open until 2026-08-21, a date that has passed. R1 records what is actually deployed, and the implementation replaces that stale statement in DEPLOYMENT.md.

## 12. Manual steps the user must perform (Firebase console and machine)

Same numbering as the runbook in section 10.

- R1: export a backup; copy the live rules.
- R2: enable Email/Password; check Authentication usage.
- R3: generate the service account key (keep out of git; on Windows restrict the folder ACL); install Node 18+ and `npm install` in `tools/migrate-to-secure`.
- R4: create a scratch Firebase project; run the hash gate, rules tests and a secure-mode trial there.
- R5, R6, R8: run `plan`/`--dry-run`, `run` (with `--rotate-all`), `run --yes --rotate-all --resume --refresh --mirror --confirm-no-secure-usage`, `verify` (the Superuser check is part of `verify`).
- R7: announce the freeze, the brief interruption, the 6-character minimum, the username list and the behaviour changes in 10.1.
- R9: deploy the rules.
- R10: flip the flag and publish; run `mark-cutover`.
- R11: smoke test; distribute temporary passwords from the local CSV, then delete it; optionally enable enumeration protection; optional hardening: App Check (section 14) and an API-key referrer restriction (not a security boundary).
- R12: decide when to delete the old nodes.

## 13. Test plan

Rules tests (Database emulator needs Java and a one-time download; if it cannot run in the implementation environment the tests are written and reported as **not executed**). `database.rules.test.js` with `@firebase/rules-unit-testing`, seeding one user per role in two teams plus an unassigned user and a terminated user, `assertSucceeds`/`assertFails` for every row of the matrix. Required cases:

- **Escalation boundary (finding 3):** self-create profile with `isAdmin: true` fails; with `isManager: true` fails; with `isSuperAdmin: true` fails; with `terminated: true` fails; with `mustResetPassword` fails; with a `teamId` not in `teamNames` fails; with a `memberKey` the caller has not claimed fails; with a valid profile succeeds. A user `set`ting their whole existing profile fails; deleting and recreating their own profile fails; writing only `usersV2/<me>/isAdmin` (with and without an existing profile) fails; the Superuser changing `isAdmin`, `isManager`, `teamId`, `terminated` on another user succeeds; nobody (including the Superuser) can write `isSuperAdmin`; the Superuser cannot delete a profile from the client.
- **Name replace semantics:** profile with `name` containing `.` and the correctly encoded `memberKey` succeeds, and a mismatched `memberKey` fails (decides whether the 7.2 clause stays).
- **Team isolation:** Admin A reads and writes team A and fails on team B; Manager reads own team, fails writing a colleague, succeeds writing own; Employee reads a colleague with the toggle off (fail) and on (succeed); **an unassigned user A reading unassigned user B's data fails with the toggle on and off (finding 2)**; an unassigned user cannot read `teamData/unassigned/members` as a list.
- **Leave types:** each of `leave`, `wfh`, `wfh-email`, `exception`, `planned` succeeds for self, Admin of own team and Superuser, fails for a Manager writing another member and for cross-team Admin; an out-of-domain value fails; an attendance value other than `true` fails; malformed dates fail.
- **Registration order:** claim without a profile succeeds; a second claim on the same key by another account fails; claim after having a profile fails; owner delete of a claim before a profile succeeds, after fails; reading someone else's claim fails; profile create without a matching claim fails; roster create before the profile exists fails and after succeeds.
- **Self move (7.4, no SELFMOVE):** a team-less user sets own `teamId` (first assignment) and then performs the multi-path copy-and-delete, and both succeed; the same sequence by a user who already has a team fails at `teamId`; a team-less user writing any `members`, `attendance` or `leaves` node under a real team before step 2 fails; a move into a team not in `teamNames` fails at step 2; a move that also tries to write `isAdmin` fails; a self first-assignment as Admin, Superuser or Manager fails; a second `teamId` change by self fails; removal of own `unassigned` copies after `teamId` is set succeeds, removal of another member's copies fails; a member-created roster entry whose `name` differs from the profile `name` fails (Admin/Superuser creates with other names succeed); interrupted-move repair: after step 2 only, login 6b redoes step 3 and no data is lost.
- **Roster `uid` (finding 10):** a team Admin setting their own uid on another member's entry fails; a member setting their own uid on their own key succeeds; a member setting a different uid fails; Admin deleting and recreating an entry without `uid` succeeds.
- **Terminate:** Admin sets `terminated` on a member of own team (succeeds), on a Superuser (fails), on self (fails), on another team's member (fails); terminated users are denied everywhere except reading their own profile.
- **Admin-writable flags (parity):** an Admin of the target's team sets `isAdmin` to `false` and `mustResetPassword` to `true` on a teammate (succeeds); setting `isAdmin` to `true`, setting `isManager`, or clearing a teammate's `mustResetPassword` fails; the same writes on another team's member, on a Superuser, or on self fail; a user clears only their own `mustResetPassword`. `teams/unassigned` and `teamNames/unassigned` writes fail.
- **Node shape (finding 3):** writing a scalar (`true` or a string) at `attendance/{myKey}`, `leaves/{myKey}` fails for self, Admin and Superuser; a scalar at `holidays` fails for an Admin (with `adminCanEditHolidays` on) and for the Superuser; deleting those nodes still succeeds.
- **Other nodes:** anonymous reads `teamNames` only; `teams` and `teamNames` Superuser write only; `holidays` write with and without `adminCanEditHolidays`; `passwordResetRequests` by an Admin of the target's team, by an Admin of another team, with the wrong `requestedBy`; legacy-only nodes denied to everyone.
- **Lookup limits:** the worst-case writes and reads (Admin writing a member's attendance, Manager reading a team, the move write) are accepted; the results and the byte size of the expanded `database.rules.json` are recorded in the PR; any limit or size error stops work and returns to design review (acceptance gate, 2.1).

Other tests:

- Migration script unit tests (no network, mocked Admin SDK): role/team reconciliation conflicts abort `run` and `--prefer arrays` resolves them with the arrays winning; terminated users and roster-less keys get roster entries and the unmatched count is zero; legacy users missing `terminated`, `isManager`, `username` or `registeredAt` get the defaults and pass the seven-field check; empty or colliding usernames get deterministic suffixes; terminated users are imported without `disabled`; `clear-cutover` requires `--yes` and re-enables `run`; `delete-auth-user` refuses when a profile exists; the CSV goes to `--out-dir` and is encrypted with `--encrypt-csv`; hex-to-Buffer conversion and rejection of malformed hashes; username normalization and collisions; canonical checksum; the write guard rejecting `teams`, `settings` and every legacy-only path; dry-run writing nothing; **add-only: a different existing value is reported as a conflict and not overwritten; `run` refusing after `mark-cutover`; `--mirror` refused after `mark-cutover`**; `run` aborting without `--hash-test-passed`; `plan` reporting out-of-domain values; `verify` listing new-only entries separately.
- App logic tests in plain Node with stub `database`/`auth`: `MODE` selection (undefined `SECURITY_MODE`, `"Secure"`, `true`, `"secure"`), login candidate-username fallback, the four-step registration including rollback at each step, the self-move payload, listener set per role (unassigned never gets team-wide), `lockApp` cleanup.
- **Migration refresh and mirror:** terminated-after-R6, promoted-after-R6, team-moved-after-R6 and password-changed-after-R6 are each carried by `run --resume --refresh` and then pass `verify`; refresh is refused after `mark-cutover` and without `--confirm-no-secure-usage`; refresh prints only usernames; `migration-state.json` holds HMAC fingerprints and no raw hash; a promoted-after-R6 user is rotated, never re-imported; `run` then `--mirror` with unchanged legacy data deletes nothing (roster `uid` and group 2/3 entries survive); `--mirror` after a legacy attendance toggle-off deletes exactly that leaf; **a team deleted in legacy after R6 and a team renamed in legacy after R6 are each carried into `teamNames` by `--refresh`/`--mirror` and then pass `verify` (teams/`teamNames` sync) at R8.**
- **Password rotation:** the Superuser, every Admin and every Manager never get `passwordHash` in the import payload (with and without `--rotate-all`); under `--rotate-all` no user does; `plan` prints the hash-imported versus rotated count line with correct numbers; temporary passwords are at least 16 characters.
- **Macro expansion:** the build fails if any macro name remains in the expanded rules, and `ADMIN_OF` is expanded before `ADM`.
- **Legacy parity (acceptance, finding 7):** in legacy mode with the auth script tag present, compare the network panel and console with commit `a7001f7` (same requests apart from the extra script, no new console errors) and confirm login, attendance edits and logout behave identically.
- **Login and session logic tests:** `normalize` collapses dots; `auth/invalid-email` advances the candidate loop; the short-password hint appears after 3 failures; on `permission_denied` a terminated profile locks the app and otherwise the listeners re-attach once; `isAdmin()`, `isManager()` and `getMemberTeamId()` return the expected values for Superuser (from `usersV2`), Admin (from team profiles), Manager and Employee (nothing about others).
- Static checks: `node --check` on `app.js`, `firebase-config.js`, the script and the tests; JSON validity of `database.rules.json`; a check that the expanded rules contain no unexpanded macro name.
- Manual (user, staging then live after R10): log in as each role; confirm an Admin of team A cannot see team B in the UI and that `database.ref('teamData/<B>').once('value')` from the console is denied; edit `attendance_current_user` in localStorage and confirm no change in authority; logout leaves nothing readable; legacy mode (flag reverted in staging) behaves exactly as before the change. Enumeration protection: with it on, register a user whose generated username collides and confirm a suffixed username is still allocated.

## 14. Risks and residual risks

- **Client code is always visible** and the Firebase config is public. That is fine once rules are correct; the correctness of `database.rules.json` is the whole security boundary, which is why the rules tests are mandatory and why the emulator results (not this document's reasoning) are the evidence. The rule semantics in section 7 (cascade, `replace`, lookup counts) were reasoned from the documented model and **not executed here**.
- **Open registration.** Anyone can register and self-select any team (current behaviour). An outsider with the config can join Team A as an Employee; with `everyoneSeesAll` on, that Employee reads Team A's attendance. Recommendation: keep the toggle off, or add approval (Q3). Not changed here because it would change sign-up behaviour. Unlimited scripted creation of Auth accounts is possible with the public config; accounts without a profile have no data access but consume the Auth user list and can be spammed. App Check (below) is the mitigation.
- **Name squatting.** The first registrant of an unclaimed roster name gets it (as today). The `memberOwners` claim also lets an attacker with an Auth account burn any number of unclaimed names (there is no per-account cap, and Auth accounts can be created at will with the public config), although a claim is limited to accounts without a profile and is deletable by its owner. `plan` and `verify` list claims whose uid has no profile. The Superuser clears orphan claims with `clear-claim`. A team-less user can no longer write into any team's tree (7.4).
- **No self-service password reset and no in-app Admin reset** (4.5). Operationally a Superuser dependency.
- **Old hashes are already disclosed.** Until now any holder of the public config could read `users/*/passwordHash` (unsalted single-round SHA-256, passwords possibly 4 characters, trivially crackable offline). Treat every legacy hash, and any backup containing them, as disclosed. For that reason the Superuser, Admins and Managers never have a hash imported, and the recommended default rotates everyone. Any password that is nevertheless imported from a hash (explicit opt-out, non-privileged users only) stays exactly as weak as before. `mustResetPassword` is soft (4.6), so rotation relies on the temporary passwords being random and delivered out of band.
- **Size ceiling.** There is no per-member cap on the number of dates under `attendance/{key}` or `leaves/{key}`; the ceiling is the 1 GB Spark storage limit. A member can fill their own nodes, which is accepted. Node shape is enforced (a scalar cannot replace a member's date map, 7.3).
- **Weak passwords.** Minimum 6 characters. Firebase Auth throttles brute force but does not eliminate it.
- **Username enumeration.** Login uses one error message. Registration reveals taken usernames through `auth/email-already-in-use`, which the candidate loop depends on, and the loop makes this cheap to probe. Email enumeration protection may hide this, but I could not verify whether it changes the create-user error, so it is a staging-tested, post-cutover step (R4, R11, Q10), not a precondition. Team names are public by design (5.1).
- **Soft-enforced `mustResetPassword`** (4.6).
- **Rules complexity.** Inlined expressions are easy to get wrong. Mitigation: tests per matrix row and per escalation case; reviewers should read the JSON, not only the tests.
- **Old hashes remain in the database until the old nodes are deleted.** Clients cannot read them under the new rules, but anyone with the service account, console access, or the pre-cutover backup can. The backup file contains the hashes and must be stored securely. Deleting the old `users` node is the closing step (R12).
- **The Superuser's team move and team delete are single multi-path updates**, so no partial move; a very large team move is a large single payload, which is fine at this data size. A member's own first team pick is not atomic across its steps 2 and 3; copy-before-delete plus the login 6b repair mean nothing is lost (4.2).
- **Stale cached legacy clients** receive permission errors after R9 until they reload.
- **App Check (optional hardening).** Firebase App Check with reCAPTCHA v3 for the web app would let the database reject requests that do not come from the real site, limiting scripted abuse with the public config. It is not required for correctness, determined attackers can bypass it, and enforcement needs console setup and a site key. Not part of this change.
- **Hosting.** GitHub Pages serves unauthenticated static files; the app shell remains public.

## 15. Open questions with recommended defaults

- **Q1. Holiday editing by Admins.** Default: Superuser only (`settings/adminCanEditHolidays` absent = false), matching `ADMIN_CAN_EDIT_HOLIDAYS = false` and the earlier decision. The server flag is authoritative in secure mode; the app constant is used only in legacy mode.
- **Q2. Collect real email addresses to enable self-service reset on the free plan?** Default: no. Firebase can send reset mail on Spark, but it needs the Auth email to be the real address, which means login by email or a public username-to-email lookup (privacy cost).
- **Q3. Require approval for new registrations?** Default: no, to preserve behaviour; the risk is stated in section 14. A later `settings/registrationOpen` switch would be additive.
- **Q4. Password minimum 6 (Firebase-imposed).** Default: yes.
- **Q5. Restored members are asked to choose a new password at next login (parity with legacy) but keep the old one until then.** Default: yes; an Admin cannot set a password for them.
- **Q6. Retention of old nodes after cutover.** Default: keep at least 2 weeks, delete only on explicit approval.
- **Q7. Login by full name for users with numeric username suffixes.** Default: unsupported, username required (4.1).
- **Q8. Peer-Admin management** (REQUIREMENTS Q13). Default: unchanged; same-team Admins can manage each other, never the Superuser (`ADMIN_OF` excludes Superusers and self).
- **Q9. Employees seeing teammates' names while `everyoneSeesAll` is on.** Default: yes, same as today (read-only).
- **Q10. Email enumeration protection.** Default: test in staging (R4); enable after cutover only if registration still allocates suffixed usernames; otherwise leave off and accept the residual.
- **Q11. Self-service team pick after registration (login 6a).** Default: keep, as today, implemented as the three-step self move (only step 3, the copy-and-delete, is a single multi-path update; step 6b repairs an interruption) so the user's own history moves with them. The alternative (Superuser-only assignment) would change visible behaviour and is not chosen.
- **Q12. `--allow-invalid` for out-of-domain legacy data.** Default: not allowed; fix the data in the legacy app first.
- **Q13 (RESOLVED, approved): Manager flagged but with no team (review 2, finding 5).** Decision: a team-less Manager cannot pick a team; the picker is replaced by the message "Waiting for team assignment. Ask the Superuser to assign your team." Applied in the `teamId` self-assignment rule, the matrix, `canSelfAssignTeam`, the tests and the 10.1 table. Original question and options, kept for the record: should such a user be able to pick a team themselves? Today they can (`canSelfAssignTeam` excludes only Admin and Superuser), and the rules as written here would let the first pick give them Manager read access to that whole team. Recommended default: no. Add `isManager !== true` to the `teamId` self-assignment `.write` and to `canSelfAssignTeam`, so a Manager waits for the Superuser to assign a team. This changes what such a user sees (no team picker), and the change was approved. Behaviour-preserving alternative: leave it as is and accept the residual that a team-less Manager can choose a team and read it; the Superuser avoids it by assigning a team before setting the Manager flag.

## 16. Files the implementation will add or change

`database.rules.json` (new), `database.rules.test.js` and `package.json` for tests (new), `tools/migrate-to-secure/` (new: `migrate.js`, `package.json`, README, unit tests), `firebase-config.js` (flag, auth init created only in secure mode, guarded `connectionTest`), `index.html` (auth SDK tag, set-password prompt, request-reset wording), `app.js` (`MODE`, data access layer, auth flows, listeners), `.gitignore` (`migration-temp-passwords-*.csv`, `migration-state.json`, service-account key patterns), and docs: `DOCUMENTATION.md`, `README.md`, `DEPLOYMENT.md` (replace the stale open-until-2026-08-21 statement), `FUTURE-ENHANCEMENTS.md` (mark implemented-in-code-pending-migration, link the runbook).

## 17. Responses to design review findings

### Part A. Iteration 1 review

All 17 findings were addressed. None required a change to what users see beyond what the design already documented, so no behaviour-change approval was needed.

1. **HIGH, `teams`/`settings` shared with legacy: addressed.** Section 3 declares them shared and never written by the migration; the write guard allows only `usersV2`, `memberOwners`, `teamNames`, `teamData`, `holidays`, `migration`; `teamNames` is the only new write derived from `teams`; `verify` checks `teams` shape and `teams`/`teamNames` sync; `adminCanEditHolidays` is created later by the Superuser, not the migration; they are removed from the "legacy denied" list.
2. **HIGH, unassigned users read each other: addressed.** `TW(t)` uses `ME.teamId === t` (never matches an absent team); `BUCKET` is used only for own-key rules; the matrix says unassigned reads none; a named emulator test covers it (13).
3. **HIGH, pseudo-code rules and cascade semantics: addressed.** Section 7 gives the complete rules, macro expansions, and 7.2 spells out create-only `$uid` `.write`, no Superuser grant at `$uid`, `data.exists()`-gated create constraints, and validate-versus-cascade behaviour; section 13 lists the escalation tests. Residual: the semantics were reasoned, not executed (section 14).
4. **HIGH, cutover ordering: addressed.** One ordered runbook (section 10): freeze, final sync, rules first (R9), then flag (R10), accepting and announcing a few minutes of errors. Flag-first is documented as rejected with the extra steps it would need.
5. **HIGH, `--resume` overwriting newer data: addressed.** Leaf-level add-only writes with conflict reporting, `migration/cutoverAt` marker via `mark-cutover`, `run` refusing after it without `--force-after-cutover`, `--mirror` only pre-cutover with an explicit confirmation, and `verify` listing new-only entries separately (section 9).
6. **HIGH, `SECURITY_MODE` cache skew: addressed.** `typeof` guarded `MODE`; only the exact string `"secure"` enables secure mode; `firebase.auth` use guarded; `connectionTest` handled (4.0).
7. **MEDIUM, self team assignment creates no roster/moves nothing: addressed.** Login 6a performs an atomic move of the user's own roster, attendance and leaves with a defined rule clause (`SELFMOVE`, later replaced by a sequence of ordinary clauses, see Part C finding 4); 6b self-heals the roster entry. Behaviour preserved (Q11).
8. **MEDIUM, `memberOwners` unbound and `memberKey` unvalidated: addressed.** The profile create requires `memberOwners/<memberKey> === auth.uid` (pre-write state, hence the sequenced registration); `KEYRE` charset and length limits on `memberKey` and the claim key; `name` maps to `memberKey` on create (test-gated); claims only before a profile exists and deletable by the owner; residual squatting stated.
9. **MEDIUM, Admin cannot enumerate; terminate source of truth: addressed.** The roster is the Admin's list (carries `uid`); terminate writes profile and roster flags in one update, profile governs access, roster governs display, roster-only members use the roster flag only; `ADMIN_OF` and the profile read rule give the needed access (5.3).
10. **MEDIUM, roster `uid` attachment: addressed.** `uid` may be set only to the caller's own uid on the caller's own key, or kept unchanged, or by the Superuser; tests listed.
11. **MEDIUM, SHA256 import unverified: addressed.** I fetched the current doc in this revision and quote exactly what it states; what it does not state is listed as unverified; the emulator is rejected as proof; the scratch-project test (including 4- and 5-character passwords) is a hard gate enforced by `--hash-test-passed`; `result.errors` is checked per batch with a stop condition (section 8).
12. **MEDIUM, Superuser credentials and bootstrap: addressed.** The script creates the Superuser even with no legacy record; `--superuser` must equal `SUPER_ADMIN`; `verify` requires exactly one Superuser profile with an existing Auth user and the right name before R9; `set-superuser` is the recovery command.
13. **MEDIUM, enumeration, open creation, `teams`/`teamNames` sync: partly addressed, with a justified deviation.** `teams`/`teamNames` are written in one update and checked by `verify`; unlimited account creation is documented with App Check as the mitigation. Enumeration protection is a staging-tested step rather than a required precondition, because I could not verify whether it changes the `email-already-in-use` error that the username-allocation loop depends on; making it required could break registration. It is enabled after cutover when staging shows it is safe (R4, R11, Q10).
14. **MEDIUM, value domains and per-type permissions: addressed.** Domains were checked against `app.js` (`markAttendance` writes `true`; `markLeave` types are `leave`, `wfh`, `wfh-email`, `exception`, `planned`, all gated by the same `canEdit`); the matrix states this; `plan` reports out-of-domain values and `run` aborts on them without `--allow-invalid`; a test per type per role (section 13).
15. **NIT, typos: fixed.**
16. **NIT, unsourced limits: fixed.** The date and the "about six lookups" claim are removed; Spark figures are marked unverified with the source pages; lookup limits are test-gated with a stated fallback (2.1).
17. **NIT, misaligned step lists: fixed.** One runbook (section 10); the manual-steps section (12) uses the same R-numbers and includes the Superuser check and the hash gate.

Additional correction found while writing the rules (not in the review): iteration 1 created the profile, claim and roster entry in one multi-path write, which cannot pass because rules evaluate against the pre-write state. Registration is now four sequenced writes with a failure path for each (4.3).


### Part B. Iteration 2 review (15 findings)

1. **HIGH, migration reads roles/teams from the wrong sources: addressed.** Section 9 "Source of truth and reconciliation": `isAdmin` from `admins` (or `SUPER_ADMIN`), `isManager` from `managers`, `teamId` from `memberTeams` then `users.teamId`; `plan` lists every disagreement; `run` aborts unless `--prefer arrays`; `verify` rechecks against the arrays.
2. **HIGH, terminated and roster-less data had no destination: addressed.** "Roster construction": roster entries for `teamMembers`, for every terminated user (`terminated: true`) and for every key with attendance or leaves but no roster entry; `order` from the array index then ascending name; zero unmatched required by `run` and `verify`.
3. **HIGH, disabled Auth accounts cannot be restored: addressed.** Terminated users are imported enabled; the script never sets `disabled`; enforcement is the profile flag (9, 5.3). This also removes the conflict with 2.1.
4. **MEDIUM, lookup/size fallback was not a decision: addressed.** Decision in 2.1: no denormalized summary node, with a recorded acceptance gate (rules byte size plus emulator results for the three worst cases); a failure stops work and returns to design review. Reason given there.
5. **MEDIUM, team-less Manager can self-assign a team: addressed (change approved).** `isManager !== true` added to the `teamId` self-assignment rule, to `canSelfAssignTeam` (`SELFMOVE` was later removed, see Part C finding 4); the team-less Manager sees "Waiting for team assignment" instead of the picker; matrix, tests, 10.1 table and Q13 updated.
6. **MEDIUM, no re-cutover path: addressed.** `clear-cutover --yes` added (9); section 11 "Retrying after a rollback" gives the sequence with `export-new` as the backup.
7. **MEDIUM, interrupted-registration repair unspecified: addressed by dropping the path.** The fresh-profile wording is removed. Login signs out with "Account not set up. Contact admin."; the Superuser repairs with `clear-claim` and the new `delete-auth-user` (4.2, 4.3, 9).
8. **MEDIUM, legacy users lack mandatory profile fields: addressed.** "Profile defaults" in section 9 sets every field, defines username normalization and collision handling, writes the username list for the announcement, and `plan`/`verify` fail on profiles violating the seven-field rule.
9. **MEDIUM, pre-added member registering under another team forks data: addressed with option (a).** Documented as a behaviour change (10.1 table and note); `verify` reports a `memberKey` in more than one team; the Superuser move reconciles. Option (b), a public hint node, is recorded as considered and not chosen.
10. **NIT, squatting wording: fixed** in section 14; `plan` and `verify` list orphan claims.
11. **NIT, username not bound to Auth email: fixed.** Documented as a display copy (section 3); `verify` compares it with the Auth email as a warning.
12. **NIT, Auth init must be gated: fixed** in 4.0 and section 16.
13. **NIT, CSV mode on Windows: fixed.** `--out-dir`, ACL instructions, optional `--encrypt-csv`, delete-after-use reminder (9, 12).
14. **NIT, regex support and `unassigned` team id: fixed.** Fallbacks for `KEYRE` and `\d` stated in 7.1; `teams/$teamId` validate now blocks `unassigned`; test added.
15. **NIT, terminate/restore deltas: addressed with parity rules.** The behaviour table is 10.1. Terminate also sets `isAdmin` false (Admin may write `false` only), restore sets `mustResetPassword` true (Admin may write `true` only), matching legacy. Rules, matrix, tests and Q5 updated. The only remaining differences are that an Admin cannot set a temporary password and that the old password keeps working until the member changes it.

### Part C. Iteration 3 review (11 findings: 2 HIGH, 4 MEDIUM, 5 NIT)

1. **HIGH, legacy changes between R6 and R8 could not be carried over: addressed.** Section 9 item 6 adds `run --resume --refresh` (pre-cutover only, needs `--confirm-no-secure-usage`): recompute desired state with the `run` transformer; overwrite `isAdmin`, `isManager`, `isSuperAdmin`, `teamId`, `terminated`, `terminatedAt`, `mustResetPassword`, `name` (removing absent fields); local git-ignored `migration-state.json` with HMAC-SHA256 fingerprints, never raw hashes (secret from env or prompt, not stored); changed users are re-imported by uid or given a new random temporary password; usernames printed. R7 carries the fallback announcement ("no password, role or team changes in the legacy app after R6"); R8 uses `--refresh`. The four tests are in section 13 (migration refresh and mirror), and the `.gitignore` entry is in section 16.
2. **HIGH, exposed hashes imported for privileged users: addressed by rotation (user decision).** Section 9 step 1: Superuser, Admins and Managers never get an imported hash; `--rotate-all` is the runbook default (R6), so no hash is imported for anyone and delivery is a local git-ignored CSV to be deleted after distribution; random 16+ character passwords with `mustResetPassword`. Old hashes are treated as already disclosed (section 14, section 8 scope note). `plan` prints the hash-imported versus rotated count line; the unit test is in section 13 (password rotation). R7 and 10.1 announce it.
3. **MEDIUM, scalar writes at node level: addressed.** `".validate": "newData.hasChildren()"` added at `attendance/$memberKey`, `leaves/$memberKey` and `holidays` (7.3); scalar-write tests for self, Admin and Superuser in section 13 (node shape); size ceiling stated in section 14.
4. **MEDIUM, SELFMOVE allowed planting data in every team: addressed with the "remove SELFMOVE" option.** Macro and rule clauses removed (7.1, 7.3); the move is now (1) read, (2) first-assignment `teamId`, (3) multi-path copy-and-delete with the removal clause `$teamId === 'unassigned' && !newData.exists() && SELF` (no `BUCKET`); login 6b repairs an interrupted move; member-created roster entries must carry the profile's `name` (name match in the `members/$memberKey` validate). Updated 4.2 step 6a/6b, 7.4, section 13 self-move cases, section 14, and the 10.1/Q13 references.
5. **MEDIUM, source of other members' roles unspecified: addressed.** Section 5.2 adds the Superuser `usersV2` listener and the Admin per-uid listeners (bounded by team size), the derivation of `ADMIN_MEMBERS`, `MANAGERS`, `MEMBER_TEAMS` and the terminated list, the deliberate parity gap for Managers and Employees, the secure-mode definitions of `isAdmin()`, `isManager()`, `getMemberTeamId()`, and a logic test (section 13).
6. **MEDIUM, `--mirror` would delete migration-written data: addressed.** Section 9 item 5 defines mirror against the desired state built by the `run` transformer (uid, terminated, order, groups 1 to 3); tests in section 13 (migration refresh and mirror).
7. **NIT, legacy inertness unverified: addressed.** Reworded to "expected to be inert" in 4.0 and section 10; the legacy parity acceptance check against `a7001f7` is in section 13.
8. **NIT, `auth/invalid-email` and `@attendance.local`: addressed.** 4.1: `normalize` collapses repeated dots and trims edge dots, `auth/invalid-email` advances the candidate loop; R4 gate includes an explicit `@attendance.local` create and sign-in; logic test added.
9. **NIT, short-password users: addressed.** 4.7 adds the hint after 3 failed attempts; R7 names `reset-password --username`.
10. **NIT, mid-session `permission_denied`: addressed.** Single rule in 5.2: re-read the profile, lock if terminated, otherwise re-resolve and re-attach once; logic test added.
11. **NIT, macro expansion and duplicate restore bullet: addressed.** 7 expands with a word-boundary regex, longest name first, and the build fails if a macro name remains (test added); the duplicate last bullet of 5.3 is deleted.

### Part D. Iteration 4 review (`design-review-r2.md`: 0 HIGH, 1 MEDIUM, 3 NIT)

All iteration-3 findings were confirmed resolved by that review. Its four new findings:

1. **MEDIUM, `--refresh`/`--mirror` could not carry a team deleted or renamed in legacy into `teamNames`: addressed.** Section 9 item 6 (e) overwrites `teamNames/{id}` to the current `teams/{id}.name` and deletes ids absent from `teams`; item 5 extends `--mirror` scope to `teamNames/`; `teams` is still never written. Members of a deleted team become unassigned via the `teamId` removal. Two tests (team deleted after R6, team renamed after R6, both passing `verify` at R8) are in section 13 (migration refresh and mirror).
2. **NIT, atomicity wording: fixed.** 4.2 failure handling now says a failure after step 2 is repaired by 6b with copy-before-delete; Q11 and the section 14 bullet say only the copy-and-delete step (and the Superuser's own move/delete) is a single multi-path update; the stale last line of this section is replaced by this Part.
3. **NIT, macro expansion order: addressed.** Section 7 expands to a fixpoint (limit 10 passes) with the build failing on any remaining macro name or on hitting the limit.
4. **NIT, R8 flags: fixed.** R8, the 11 retry sequence and section 12 now read `run --yes --rotate-all --resume --refresh --mirror --confirm-no-secure-usage`, and 9 item 6 states that `--resume` inherits the R6 password flags.
