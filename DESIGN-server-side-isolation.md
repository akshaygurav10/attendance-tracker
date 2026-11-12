# Design: Server-side team isolation (Firebase Auth + per-team data + rules)

Status: design for review (iteration 1). Branch `feature/server-side-team-isolation`, from `a7001f7`.
Implements `FUTURE-ENHANCEMENTS.md` section 1. No code is written by this document.

## 1. Overview

Today every permission check is in browser code. There is no Firebase Auth, the whole attendance dataset is one blob (`appData`), and the `users` node holds password hashes that the browser downloads at login. Anyone with the public Firebase config can read or write everything from dev tools.

The design moves authority to Firebase. Users sign in with Firebase Auth (Email/Password, using a synthetic email derived from the username). Roles and team live in a profile node keyed by `auth.uid`, which no client can promote itself in. Attendance, leaves and the roster move to per-team paths under `teamData/{teamId}/...`, so Realtime Database rules can allow or deny a read by team. Password hashes leave the database and live only in Firebase Auth. A config flag (`SECURITY_MODE`, default `"legacy"`) keeps the live app working exactly as today until the user migrates and flips it to `"secure"`.

Stack, locked on approval: static HTML/JS (no build step), Firebase JS SDK 9.23.0 compat (`firebase-app-compat`, `firebase-database-compat`, plus new `firebase-auth-compat` at the same version), Realtime Database, Firebase Auth Email/Password, `database.rules.json`, Node migration/admin script with `firebase-admin`, rules tests with `@firebase/rules-unit-testing` and the Database emulator. No Cloud Functions.

## 2. Options compared

| | A. Auth email/password + DB roles, rules via `auth.uid` | B. Custom tokens via Cloud Functions | C. Custom claims via Cloud Function |
|---|---|---|---|
| Extra infrastructure | None. Spark plan is enough. | A deployed Function that verifies old logins and mints tokens. | A deployed Function that sets claims when the Superuser changes roles. |
| Plan | Spark (free). Auth Email/Password has no charge to my knowledge; confirm in the console. | Blaze (pay-as-you-go, credit card). Cloud Functions deploy requires Blaze. | Blaze, same reason. |
| Role changes in the app | Instant. Rules read `usersV2/{uid}` flags. | Instant if roles are in the DB, as in A. | Delayed until the user's ID token refreshes (up to 1 hour, or forced refresh). |
| Admin sets another user's password | Not possible from the browser. Needs the Admin SDK (our local script). | Possible via Function. | Possible via Function. |
| Keeps old passwords | Yes, by `importUsers` with SHA256 (section 7). | Yes, and without a hash import. | Same as A. |
| Honest downside | Loses in-app admin password reset (section 4.5). | Cost, deployment, a server to maintain. | Same as B, and claim lag. |

Recommendation: **Option A.** It is the only option that needs no server and no paid plan, and it genuinely enforces access: every rule is evaluated by Firebase against the verified `auth.uid`, and the flags it consults can be written only by the Superuser (or by the Admin SDK script). What A gives up is in-app password reset by an Admin and self-service "forgot password" (there is no deliverable email). Section 4.5 states the replacement and the user impact. **Binding user decision (recorded after this design started): the project stays on the free Spark plan permanently and must still be genuinely secure.** B and C are therefore rejected, not deferred, and nothing in this design depends on Cloud Functions, custom tokens, custom claims or any Blaze feature. Everything is stored in the Realtime Database and enforced by rules on `auth.uid`. Where free-plan rules cannot express a requirement, section 2.1 says so and gives the closest free alternative. The Superuser flag is stored in the DB and is writable only by the Admin SDK script running on the user's own machine (the Admin SDK is a free library; it is not a hosted server).


### 2.1 Free-plan feasibility (Spark, binding)

Limits checked on 2026-11-12 against `https://firebase.google.com/pricing` and `https://firebase.google.com/docs/database/usage/limits`:

- Realtime Database on Spark: 100 simultaneous connections (a connection is a browser tab or device with an open listener), 1 GB stored, 10 GB/month downloaded (the page shows "no-cost up to 360 MB/day, equivalent to about 10 GB/month"). Exceeding a Spark limit does not bill; the service throttles or stops until the quota resets. Impact for this app: attendance data is a few kilobytes per member per year, so 1 GB is far from reached. Each open tab is one connection, so more than 100 people online at once would be refused; the team size here is well below that, but this is a hard ceiling to monitor. The new design reduces download volume: today every client downloads the whole `appData` blob on each change, whereas Employees now listen only to their own paths and Managers and Admins to their team. Per-day bandwidth should drop, not rise. Keep the listener set small and do not attach `teamData` at the root for anyone but the Superuser.
- Authentication, Email/Password: the pricing and quota pages I fetched do not list a charge or user cap for Email/Password, and the Identity Platform quota page lists limits only for email sends and phone sign-in. I did not find a Spark-specific user cap for Email/Password; this must be confirmed in the Firebase console (Authentication, Usage) before cutover. This design sends no email and no SMS, so the email quotas (for example 150 password-reset emails/day) do not apply. Multi-factor, phone, and email-link sign-in are not used.
- Admin SDK (migration script): a free open-source library run on the user''s own machine with their service-account key. It needs no paid plan. `importUsers` is an Auth management API, not a Blaze feature; I did not find a Spark restriction on it, but the throwaway test in section 9 step 4 confirms it works on this project before the real run.
- Cloud Functions, custom tokens minted by a server, and custom claims: all need a server or Blaze and are excluded.
- Security rules and the Database emulator for tests: free.

What free-plan rules can and cannot express, and what we do instead:

| Requirement | Can rules do it on Spark? | Free alternative used |
|---|---|---|
| Team isolation of reads | Yes, if the team is in the path | `teamData/{teamId}/...` per-team paths (section 3) |
| Roles and team come from a trusted place | Yes, from `usersV2/{uid}` which only the Superuser can change | Section 6 |
| Unprivileged self-registration without a server minting roles | Yes, by forcing `isAdmin/isManager/isSuperAdmin` false on create | Section 6 create rule |
| Stop a client changing its own role or team | Yes (per-field write rules) | Section 6 |
| Disable a terminated user's login | No (needs the Admin SDK `disabled` flag) | Rules deny all data when `terminated === true`; the Auth account still exists but is useless |
| One-time "first team assignment only" | Yes (`data.child("teamId").val() === null`) | Section 6 |
| Set or reset another user's password | No (needs a server or Admin SDK) | Local Admin SDK script operated by the Superuser (4.5) |
| Self-service forgot-password email | Not with synthetic emails | None by default; real email optional (Q2) |
| Referential integrity across nodes (for example `memberOwners` matches the profile) | Partly: rules see the pre-write `root`, not the post-write state | Write-once ownership claim plus self checks; residual name-squatting risk (section 13) |
| Rate limiting / registration approval | No | Firebase Auth built-in throttling only; approval is Q3 |
| Aggregations or filtered list reads across teams | No (rules cannot filter) | Per-team paths so the allowed set is the whole path |
| Immutable audit trail | No | Not provided |
| Un-spoofable Superuser flag | Yes, via `.write: false` on `isSuperAdmin` | Only the Admin SDK script can set it |

Conclusion: the requirements are feasible on Spark with the listed trade-offs. The visible losses compared with today are the in-app Admin password reset, self-service forgot-password, the 6-character password minimum, and login by full name for suffixed usernames.
## 3. Data model

New paths (exact). Old nodes (`appData`, `teamMembers`, `admins`, `managers`, `memberTeams`, `teams`, `users`, `settings`) are left untouched by the migration and are used only in legacy mode.

```
usersV2/{uid}                                   // uid = Firebase Auth uid
  name: string                                // full name, e.g. "Akshay Gurav"
  username: string                            // lowercase [a-z0-9._-], unique (enforced by Auth email)
  memberKey: string                           // sanitized name, '.' -> '___DOT___'; immutable identity key
  teamId: string | null                       // Superuser-assigned; null = unassigned
  isAdmin: boolean
  isManager: boolean
  isSuperAdmin: boolean                       // writable only by Admin SDK script (rules: .write false)
  terminated: boolean
  terminatedAt: string (ISO) | absent
  mustResetPassword: boolean | absent
  registeredAt: string (ISO)
  // NO passwordHash. Credentials live in Firebase Auth only.

memberOwners/{memberKey}: uid                 // write-once claim; not readable by clients (Admin SDK / Superuser only)

teamNames/{teamId}: string                    // PUBLIC read. Name only. Used by the pre-login team picker.
teams/{teamId}: { id, name, createdBy, createdAt }   // signed-in read, Superuser write

teamData/{teamId}/members/{memberKey}: { name, order, uid?, terminated?, addedBy }
teamData/{teamId}/attendance/{memberKey}/{yyyy-mm-dd}: true
teamData/{teamId}/leaves/{memberKey}/{yyyy-mm-dd}: "leave" | "wfh" | "wfh-email" | "exception" | "planned"
teamData/unassigned/...                       // same shape; bucket for users whose teamId is null

holidays/{yyyy-mm-dd}: { name }               // shared; signed-in read; Superuser write (see rules)
settings/everyoneSeesAll: boolean             // signed-in read; Superuser write
settings/adminCanEditHolidays: boolean        // signed-in read; Superuser write; absent = false
passwordResetRequests/{uid}: { requestedBy: uid, requestedAt: string }
```

Decisions and reasons:

- **`memberKey` is the existing sanitized name and never changes.** Attendance is already keyed by name, so migration keeps keys, and a rename only changes `name`. Roster-only members (added by an Admin before they register) already exist in `teamMembers`; they get a roster entry without `uid`, and a user who registers with that name claims it. This preserves current behaviour, including its known caveat that the first person to register a name gets it.
- **`teamId` in the path, not only in a field.** Rules cannot filter a list by a field. A Manager or Admin must be able to read "everything for my team" with one listener, which requires the team in the path. An Employee reads only `.../attendance/{ownKey}`.
- **Why not `attendance/{uid}`?** Roster-only members have no uid, and legacy data is keyed by name.
- **Holidays keyed by date**: legacy is an array of `{date, name}`. The migration reports duplicate dates instead of silently dropping them (section 8).
- **`teamNames` is a deliberate public node** (see 5.1). Choice made: keep the pre-login picker rather than moving team selection after login, because the sign-up flow is part of the existing UX. Cost: anyone with the config can read team names. Team ids are opaque push ids. No person data is public.
- Moving a member between teams (Superuser only) is one multi-path `update()` that copies the member's roster, attendance and leaves to the new team path and removes the old copies. Deleting a team moves its members to `teamData/unassigned` the same way (current behaviour: members become Unassigned; no user is deleted).
- Writes become granular (`.../attendance/{key}/{date}`) instead of rewriting a whole blob. This also removes the existing "never overwrite with empty data" guard concern in `saveToFirebase`.

## 4. Authentication flow

Client changes live in `app.js` and `index.html`; `firebase-config.js` gains the auth init and the flag. All Auth calls are behind `SECURITY_MODE === "secure"`.

### 4.1 Identity mapping

Auth email = `normalize(username) + "@attendance.local"`. `normalize` lowercases and strips characters outside `[a-z0-9._-]`. `.local` is not routable; no email is ever sent. Login accepts username or full name as today. The client builds up to three candidate usernames from the input (the input itself normalized, `generateUsername(input)` = first initial + last name, and first-two-letters + last name) and tries them in order; an `auth/invalid-credential` or `auth/user-not-found` moves to the next. Residual: a user whose username got a random numeric suffix must log in with the username, not the full name. Alternative rejected: a public name-to-username index, which would leak the list of people.

### 4.2 Login

1. Validate non-empty fields. 2. `auth.setPersistence(LOCAL)` if Remember me is ticked, else `SESSION`. 3. `signInWithEmailAndPassword(candidateEmail, password)`. 4. Read `usersV2/{uid}`. If missing, or `terminated === true`: `signOut()` and show "Your account has been terminated. Contact admin." (rules also block all data for terminated users, so the client check is only for the message). 5. If `mustResetPassword`: force the set-new-password prompt (4.6) before `unlockApp()`. 6. Team pick at login: only if `usersV2/{uid}.teamId` is null and `canSelfAssignTeam` (not Admin or Superuser): `update usersV2/{uid}/teamId` (rules allow only this null-to-valid transition by self). 7. Resolve identity from `usersV2/{uid}`; compute roles; `unlockApp()`; attach listeners (5.2).

"Remember me" no longer stores the password. Today `attendance_remembered_pass` keeps the plaintext password in localStorage; secure mode removes it and relies on Auth `LOCAL` persistence. User-visible: Remember me keeps you signed in instead of pre-filling the password. This is a security improvement and a necessary change.

Errors: wrong password or unknown user show "Incorrect username or password." (one message; avoids enumeration). `auth/too-many-requests` shows "Too many attempts. Try again later." Network errors show "Connection error. Please try again." Not logged beyond `console.error` of the error code (never the password).

The current user is never read from `localStorage` in secure mode. `attendance_current_user` becomes a display hint only; editing it in dev tools changes nothing because `getCurrentUser()` derives from `auth.currentUser` and the loaded `usersV2/{uid}` profile. Rules use `auth.uid` only.

### 4.3 Register

1. Validate name (required, max 100), password (see 4.7), confirm, team (required once `teamNames` is non-empty and must exist there). 2. Candidate usernames in order (`generateUsername`, first-two + last, then base + random 2 digits): `createUserWithEmailAndPassword`; on `auth/email-already-in-use` try the next, up to 10 attempts, then fail with "Could not allocate a username. Contact admin." 3. Now signed in, write in one multi-path `update()`: `memberOwners/{memberKey} = uid`, `usersV2/{uid} = {...}` with `isAdmin:false, isManager:false, terminated:false, teamId: picked` and `teamData/{teamId}/members/{memberKey}` (create, or claim an unclaimed one by setting `uid`). Rules (section 6) reject any attempt to set privileged fields. 4. If the `update()` fails because `memberOwners/{memberKey}` exists ("This name is already registered. Please login."): delete the just-created Auth user with `auth.currentUser.delete()` and show the message. If that delete fails, sign out and log `console.error`; the orphan Auth account has no profile and no data access and the Superuser can delete it from the console. 5. Proceed as login step 7.

The Superuser name bootstrap in the legacy "first login creates the Superuser" path is removed from secure mode: the Superuser account is created by the migration script (`--superuser "Akshay Gurav"`), which sets `isSuperAdmin: true`. Registering that name afterwards fails at the `memberOwners` claim.

### 4.4 Logout

`lockApp()` is preserved and extended: detach all listeners (existing `_listeners`), `auth.signOut()`, clear in-memory role state (`MANAGERS`, `MEMBER_TEAMS`, `TEAMS`, new `PROFILE`), clear `attendance_tracker_data` and `attendance_team_members` caches, add the `auth-locked` class, and clear the login-screen controls. `onAuthStateChanged(null)` also calls `lockApp()`, so a token expiry or sign-out in another tab locks this tab (replaces the `storage` event hack for secure mode, which stays for legacy). In secure mode team data is not cached in localStorage at all.

### 4.5 Password reset (what is possible without a server)

- **Change own password**: possible. `reauthenticateWithCredential(currentPassword)` then `updatePassword(new)`. Replaces the hash comparison.
- **Admin or Superuser resets another member's password**: not possible from a browser; only the Admin SDK can set another user's password. Today's button sets `Temp@123`. In secure mode the button becomes "Request password reset": it writes `passwordResetRequests/{targetUid}` (rules: Superuser or Admin of the target's team). The Superuser runs `node migrate.js reset-password --pending` (or `--username x`) locally, which sets a random 16-character temporary password per request, sets `mustResetPassword: true` on the profile, deletes the request, and prints username and temporary password to the terminal only (never to files or logs) for the Superuser to hand over. User impact: a team Admin cannot complete a reset alone anymore.
- **Self-service "forgot password"**: not available. There is no deliverable email, so `sendPasswordResetEmail` is useless. The user contacts the Superuser (same flow as above). collecting real email addresses would restore it without any paid feature (open question Q2).

### 4.6 First-login set-password fallback

Used for (a) users whose hash could not be imported (section 7), (b) users with `mustResetPassword`, and (c) accounts after an Admin SDK reset. The account exists with a Superuser-distributed temporary password. At sign-in the client sees `mustResetPassword === true` and runs: prompt new password, confirm, `updatePassword`, then `update usersV2/{uid}/mustResetPassword = null`. Rule: the user may only change this field from `true` to removed. This is a soft policy: the user already holds the temporary password, so skipping the prompt via dev tools harms nobody but themselves. Terminated-then-restored members keep their existing password in secure mode (they are not asked to reset; an Admin can additionally request a reset).

### 4.7 Password policy

Firebase Auth requires at least 6 characters; the app currently allows 4. Register and change-password raise the minimum to 6 in secure mode (user-visible, forced by Firebase). Imported users with an existing 4 or 5 character password: whether Firebase accepts sign-in with an imported hash for a password shorter than 6 is not documented and I could not verify it. The rollout therefore tests this with a throwaway account in a non-production project (section 9, step 4). If rejected, the migration script reports those users (it can detect short passwords only by a user report, since it has only hashes), and the first-login fallback applies to them.

## 5. Client data access

### 5.1 Pre-auth surface

Before sign-in the client reads only `teamNames` (names, rendered with `textContent`). `connectionTest` write in `firebase-config.js` is skipped in secure mode (it would be denied and is useless); the connection indicator uses `.info/connected` only. `loadTeamOptions()` reads `teamNames`; on a read error it keeps the current fallback (pick team after login).

### 5.2 Listeners by role (secure mode)

Attached in `unlockApp()` after the profile loads; all go through the existing `_listen`, so `stopListeners()` cleans them.

| Role | Listeners |
|---|---|
| Superuser | `teamData` (all), `teams`, `holidays`, `settings` |
| Admin, Manager (with team) | `teamData/{teamId}` (members, attendance, leaves), `holidays`, `settings` |
| Employee, `everyoneSeesAll` off | `teamData/{teamId}/members/{myKey}`, `attendance/{myKey}`, `leaves/{myKey}`, `holidays`, `settings` |
| Employee, toggle on | the Admin/Manager set (rules allow it only while the toggle is on; a `permission_denied` callback falls back to the self-only set) |
| Unassigned user | same as Employee, using `teamData/unassigned/...` |

The `getVisibleMembers()` and `canAdminMember()` helpers stay as the UI layer and are fed from the loaded roster; they are no longer the only barrier. `AttendanceData.data` keeps its current in-memory shape (`attendance[name][date]`, `leaves[name][date]`, `holidays[]`) assembled from the new paths so rendering code does not change; `markAttendance`, `markLeave`, `removeLeave`, holiday and roster operations are re-pointed to granular writes. In `legacy` mode the current code path is untouched.

## 6. Security rules

Written to `database.rules.json` (not deployed by this work). Notation below: `ME` is `root.child('usersV2').child(auth.uid)`.

Expressions (inlined in the JSON, since RTDB rules have no functions):

- `signedIn` = `auth != null && ME.exists() && ME.child('terminated').val() !== true`
- `isSuper` = `signedIn && ME.child('isSuperAdmin').val() === true`
- `myTeam` = `ME.child('teamId').val()`
- `isTeamAdmin($t)` = `signedIn && ME.child('isAdmin').val() === true && myTeam === $t`
- `isTeamMgr($t)` = `signedIn && ME.child('isManager').val() === true && myTeam === $t`
- `isSelf($k)` = `signedIn && ME.child('memberKey').val() === $k`
- `inMyBucket($t)` = `myTeam === $t || (myTeam === null && $t === 'unassigned')`

Key rule shapes:

```
"teamData": { "$teamId": {
  "members": {
    ".read": "isSuper || isTeamAdmin($teamId) || isTeamMgr($teamId) || (signedIn && inMyBucket($teamId) && root.child('settings/everyoneSeesAll').val() === true)",
    "$memberKey": {
      ".read": "isSelf($memberKey) && inMyBucket($teamId)",
      ".write": "isSuper || isTeamAdmin($teamId) || (isSelf($memberKey) && inMyBucket($teamId) && (!data.exists() || data.child('uid').val() === null))",
      ".validate": "newData.hasChildren(['name']) && newData.child('name').isString() && newData.child('name').val().length <= 100 && (!newData.child('uid').exists() || newData.child('uid').val() === data.child('uid').val() || newData.child('uid').val() === auth.uid || isSuper)"
    } },
  "attendance": {
    ".read": "<same team-wide read clause as members>",
    "$memberKey": {
      ".read": "isSelf($memberKey) && inMyBucket($teamId)",
      ".write": "isSuper || isTeamAdmin($teamId) || (isSelf($memberKey) && inMyBucket($teamId))",
      "$date": { ".validate": "$date.matches(/^\\d{4}-\\d{2}-\\d{2}$/) && newData.val() === true" } } },
  "leaves": { "...": "same shape; $date value must be one of leave|wfh|wfh-email|exception|planned" }
} }
```

`usersV2/$uid` (validation rejects any child not listed, via `"$other": {".validate": false}`):

- `.read`: `auth.uid === $uid` (even if terminated, so the app can show the message), or `isSuper`, or `isTeamAdmin(team of $uid)` where the team is `root.child('usersV2/'+$uid+'/teamId').val()`.
- Create: `auth.uid === $uid && !data.exists()`; `isAdmin === false`, `isManager === false`, `isSuperAdmin` absent, `terminated === false`, `memberKey` equal to a value for which `root.child('memberOwners/'+memberKey).exists() === false` (pre-write state), `teamId` null or present in `teamNames`.
- `isAdmin`, `isManager`, `teamId` (other than self first-assignment): write only `isSuper`. Self first-assignment: `auth.uid === $uid && data.child('teamId').val() === null && data.child('isAdmin').val() !== true && data.child('isSuperAdmin').val() !== true && root.child('teamNames/'+newData.val()).exists()`.
- `isSuperAdmin`: `.write: false`. (Admin SDK bypasses rules.) `memberKey`, `username`, `registeredAt`: immutable after create.
- `terminated`, `terminatedAt`: `isSuper`, or a team Admin for a user in their own team who is not `isSuperAdmin` and is not themselves.
- `mustResetPassword`: `isSuper` (set); self may only remove it when currently `true`.
- `name`: `isSuper` or Admin of the target's team.

Other nodes:

- `memberOwners/$memberKey`: `.read: false`, `.write: auth != null && !data.exists() && newData.val() === auth.uid` (write-once; Superuser cannot change it either, but the Admin SDK script can).
- `teamNames`: `.read: true`, `.write` Superuser. `teams`: `.read` signed in, `.write` Superuser, validated shape.
- `holidays`: `.read` signed in; `.write` Superuser, or an Admin while `settings/adminCanEditHolidays === true`. `$date` key must match the date regex, value `{name: string <= 100}`.
- `settings/everyoneSeesAll`, `settings/adminCanEditHolidays`: `.read` signed in, `.write` Superuser, boolean.
- `passwordResetRequests/$uid`: `.read` Superuser; `.write` Superuser, or a team Admin of `$uid`'s team; shape `{requestedBy === auth.uid, requestedAt string}`.
- Legacy nodes (`appData`, `teamMembers`, `admins`, `managers`, `memberTeams`, `teams` as it is today, `users` as it is today) are covered below.
- Everything else, including the root: `.read: false`, `.write: false`.

Profile path: new profiles live at **`usersV2/{uid}`**, not `users/{uid}`. The old `users/{sanitizedName}` node holds password hashes and is name-keyed; writing to a new path means migration never modifies an old node. The new rules make every old node unreadable and unwritable (`.read: false`, `.write: false`), which removes the hash exposure from clients. The hashes still sit in the database (unreadable by clients, readable via the Admin SDK) until the user approves deleting the old nodes (section 9, last step); this is a residual risk (section 13). Rollback restores the old rules (section 10).

Rule evaluation cost: each rule that consults `ME` does a data lookup. RTDB limits the number of lookups per evaluation; every rule above uses at most about six and the emulator tests assert that the worst cases (Admin writing a member's attendance, Manager reading a team) are accepted. If the emulator shows a limit error, the free-plan fallback is to denormalize `teamId`, `isAdmin` and `isManager` into a single `usersV2/{uid}/auth` child that rules read once, or to shorten the longest rule; custom claims are not an option (they need a server).

### Permission matrix (each cell is enforced by rules)

| Path / action | Superuser | Admin (own team) | Manager (own team) | Employee | Unassigned | Anonymous |
|---|---|---|---|---|---|---|
| Read `teamNames` | R | R | R | R | R | **R** |
| Read `teams`, `holidays`, `settings/*` | R | R | R | R | R | none |
| Read own attendance/leaves/roster entry | R | R | R | R | R | none |
| Read team attendance/leaves/roster | all teams | own team | own team | own team only while `everyoneSeesAll` on | none | none |
| Read other teams' data | R | none | none | none | none | none |
| Write own attendance/leaves | W | W | W | W | W | none |
| Write others' attendance/leaves | all | own team | none | none | none | none |
| Roster add/remove/rename/reorder | all | own team | none | none | none | none |
| Set `terminated` on a member | all | own team, not Superuser, not self | none | none | none | none |
| Write `isAdmin`, `isManager`, `teamId` (after first set) | W | none | none | none | none | none |
| First `teamId` self-assignment (null to valid) | n/a | none | allowed | allowed | allowed | none |
| Write `isSuperAdmin` | none (Admin SDK only) | none | none | none | none | none |
| Write `teams`, `teamNames` | W | none | none | none | none | none |
| Write `holidays` | W | only if `adminCanEditHolidays` | none | none | none | none |
| Write `settings/*` | W | none | none | none | none | none |
| Create `passwordResetRequests` | W | own team members | none | none | none | none |
| Read `usersV2/{uid}` | all | own team | own only | own only | own only | none |
| Terminated user: any data access | none | none | none | none | none | none |
| Legacy nodes (`appData`, old `users`, ...) | none | none | none | none | none | none |

Tests (section 12) cover each row for allow and for the deny edge, including cross-team Admin attempts, a Manager writing another member, an Employee escalating their own flags, anonymous reads of everything except `teamNames`, and malformed shapes.

## 7. Importing existing passwords (verified)

Checked against the current Firebase doc "Import users from your app" (`https://firebase.google.com/docs/auth/admin/import-users`, fetched during this design): **`importUsers` supports SHA256.** The page lists "MD5, SHA and PBKDF hashing algorithms: MD5, SHA1, SHA256, SHA512, PBKDF_SHA1 and PBKDF2_SHA256". For these you must provide `rounds` (between 1 and 8192 for SHA1/SHA256/SHA512; "If a single hashing function was originally applied, rounds must be set to 1"). The Node example uses `getAuth().importUsers(users, { hash: { algorithm: 'SHA256', rounds: 1 } })` with `passwordHash` supplied as a `Buffer` (and optional `passwordSalt`). I did not guess the exact option spelling beyond that; the implementer must check the `firebase-admin` typings in the installed version when writing the script.

Compatibility with this app's hashes (from `hashPassword` in `app.js`): `crypto.subtle.digest('SHA-256', TextEncoder.encode(password))`, hex lowercase, unsalted, a single round. That matches "SHA256, rounds 1, no salt". Script conversion: `Buffer.from(hexHash, 'hex')` (must be 32 bytes, otherwise treat as unusable and use the fallback).

What I could not confirm from the docs: (1) the exact byte layout when no salt is given; the expected behaviour is `SHA256(password)`, but this is verified empirically by the throwaway account test in the rollout, not assumed; (2) the minimum-password-length interaction (4.7). Because of these, the script supports `--only <username>` so one account can be imported and signed into before the rest, and the fallback (4.6) exists for every account the import rejects.

Never print hashes: the script logs only usernames, counts and error codes; hashes are held in memory and passed to the SDK.

## 8. Migration plan (non-destructive)

Tool: `tools/migrate-to-secure/migrate.js` (Node, `firebase-admin`), run by the user with their own service-account key via `GOOGLE_APPLICATION_CREDENTIALS`. The agent never runs it against the live project. Commands:

- `migrate.js plan --superuser "Akshay Gurav"` or `--dry-run` on any write command: reads old data, prints exactly what it would create (counts per team, users to create/import, hash import eligibility, duplicate holiday dates, members without a team, attendance entries for names not on the roster, terminated users), writes nothing, exit code 0.
- `migrate.js run` (refuses without prior `--dry-run` output confirmation flag `--yes`): (1) refuses to run if `usersV2` or `teamData` is non-empty unless `--resume`; (2) for each old user: create the Auth user via `importUsers` (SHA256, rounds 1) in batches of up to 1000; users without a valid hash, `mustResetPassword`, or an import rejection get `createUser` with a random password, flagged `mustResetPassword: true`, and their temporary passwords go to a local file `migration-temp-passwords-<timestamp>.csv` created with mode 0600 (git-ignored; the script adds that pattern to the check) and are never printed. Terminated users are imported with `terminated: true` (and Auth `disabled: true`). (3) Write `usersV2/{uid}`, `memberOwners`, `teamNames`, `teams`, `teamData/*/members|attendance|leaves`, `holidays`, `settings`. (4) Set `isSuperAdmin: true` on the named Superuser only. Writes are `update()` calls to new paths only. It never calls `remove`/`set` on any old path; a guard in the script rejects any write path that does not start with one of the new prefixes.
- Email collisions: two users with the same normalized username would collide; the script reports and assigns the same suffix rule as the app (first-two + last, then number).
- `migrate.js verify`: read-only. Compares old and new: user count (old users vs `usersV2` vs Auth users), roster count per team, attendance entry count and SHA-256 checksum over a canonical sorted serialization of `(memberKey, date)` per team, leaves count and checksum of `(memberKey, date, type)`, holidays count, and that every old member maps to exactly one new roster entry. Prints PASS or the list of differences and exits non-zero on any difference. Checksums are over attendance, never passwords.
- `migrate.js reset-password`: see 4.5.

Idempotent and resumable: re-running `run --resume` skips users that already exist (matched by email) and rewrites the same new paths with the same values. Old data is never deleted by anything in this work; deleting `appData` and the other old nodes is a manual, explicitly approved step after a stabilization period (section 9, last step).

Attendance data written by the app between the migration run and the cutover will exist only in the old blob. The cutover runbook handles that with a freeze plus a final `run --resume` and `verify` (section 9).

## 9. Rollout and cutover

Feature flag: a new constant in `firebase-config.js`:

```
const SECURITY_MODE = "legacy"; // "legacy" (default, current behaviour) | "secure"
```

Default `"legacy"`. In legacy mode the new code is inert: no Auth SDK calls, no new paths, identical behaviour and identical Firebase traffic to today. The Auth SDK script tag loads in both modes and is harmless in legacy.

Merging the PR is safe on its own. Nothing changes for users until step 8 below. Steps, in order (the user performs the console and script steps; the agent cannot):

1. **Backup.** Firebase console, Realtime Database, Data tab, three-dot menu, Export JSON of the root. Store it somewhere safe. Also screenshot the current Rules tab.
2. **Enable Email/Password** in Authentication, Sign-in method. Leave Email link off. Optionally turn on email enumeration protection.
3. **Create a service account key** (Project settings, Service accounts, Generate new private key). Keep it out of the repo.
4. **Throwaway test.** In a scratch Firebase project (or the live project with `--only` and a test user created in the old data), import one account whose password you know, then sign in with the real app code in secure mode against the emulator or scratch project. This confirms SHA256 import behaviour (section 7) including a 4 or 5 character password.
5. **Dry run** `migrate.js run --dry-run`, review the report.
6. **Run** the migration, then `migrate.js verify`. Fix any difference and re-run with `--resume`.
7. **Rules, deployed before the flag is flipped but only as a staged check.** Deploy the new rules to the live database only at cutover (step 9). Before that, test them in the Rules Playground (Firebase console) with simulated users.
8. **Announce a short freeze window**, ask everyone to stop editing, run `run --resume` and `verify` again to catch last-minute data.
9. **Cutover**, in this order: set `SECURITY_MODE = "secure"` in `firebase-config.js` and publish (GitHub Pages) → deploy `database.rules.json` (`firebase deploy --only database`, or paste into the Rules tab). The app version still cached in a browser in legacy mode will start getting `permission_denied`; users reload. Doing rules first would lock out the legacy app for everyone, doing the flag first would show a secure-mode login that cannot read data for a few minutes; the order above (publish first, then rules) keeps legacy-mode clients working until the rules change, and the gap is minutes.
10. **Communicate** to users: sign in with your existing username and password; anyone given a temporary password must set a new one at first login; password minimum is now 6.
11. **Stabilize** for a period the user chooses (suggest 2 weeks), then, on explicit approval only, remove old nodes. This is not part of this change.

Rollback (section 10) is available at every step until step 11.

## 10. Rollback

Before step 11 nothing old was modified, so rollback is: (1) paste the saved old rules (or the legacy open rules) back in the Rules tab, (2) set `SECURITY_MODE = "legacy"` and republish, (3) users reload. The old `appData`, `users` (with hashes) and the other old nodes are intact, so the legacy app works as before. Data edited in secure mode (new paths) is not copied back automatically, so a rollback after real use loses those edits unless `migrate.js` gains a reverse command; this design provides `migrate.js export-new --to-json file` (read-only dump of `teamData`, `holidays`) for manual recovery and states this limitation in the runbook. Auth accounts and the new nodes may remain; they are inert in legacy mode. Passwords changed in secure mode do not propagate back to the old hashes: after a rollback those users use their old password, or the Superuser resets them in the legacy UI.

The saved legacy rules: DEPLOYMENT.md says the current rules are open until 2026-08-21, a date that has passed; the live rules are unverified. Step 1 records what is actually deployed, and the implementation replaces that stale statement in DEPLOYMENT.md.

## 11. Manual steps the user must perform (Firebase console and machine)

- Export a backup of the Realtime Database (step 1). 
- Authentication, Sign-in method, enable Email/Password (step 2). Optionally enable email enumeration protection.
- Project settings, Service accounts, generate a private key for the migration (step 3). Keep it out of git.
- Install Node 18 or newer and run `npm install` in `tools/migrate-to-secure`.
- Run dry-run, run, verify (steps 5, 6) and the throwaway test (step 4).
- Distribute temporary passwords (if any) from the local CSV, out of band, then delete the CSV.
- Test rules in the Rules Playground (step 7).
- Flip the flag and publish, then deploy the rules (step 9), in that order.
- Optional hardening: enable App Check (section 13); restrict the API key to the GitHub Pages referrer in Google Cloud console credentials (referrer restrictions are not a security boundary).
- Decide when to delete the old nodes (step 11).

## 12. Test plan

Unit/emulator (offline-capable once the Firebase CLI and emulator jar are installed; the Database emulator needs Java and a one-time download, which may not be available in this environment; if it cannot run here the tests are written and clearly reported as not executed):

- `database.rules.test.js` with `@firebase/rules-unit-testing`: seed users for each role in two teams, then `assertSucceeds`/`assertFails` for every row of the matrix, including: Admin A reading/writing team B; Manager writing a colleague; Employee reading a colleague with the toggle off and on; Employee writing `isAdmin`, `isManager`, `teamId`, `isSuperAdmin`; self first-assignment of a team and a second change; Admin as self-assigner; terminated user denied everywhere; anonymous reading `teamNames` only; malformed dates, leave types, extra fields; `memberOwners` write-once; holiday write with and without `adminCanEditHolidays`; legacy nodes denied.
- Migration script unit tests (no network): hex-to-Buffer conversion and rejection of malformed hashes, username normalization and collisions, canonical checksum, write-path guard rejecting any old path, dry-run writing nothing (mock Admin SDK).
- App logic tests in plain Node with a stub `database`/`auth`: login candidate-username fallback, register rollback when the claim fails, listener set per role, `lockApp` cleanup.
- Static checks: `node --check` on `app.js`, `firebase-config.js`, the script and the tests; JSON validity of `database.rules.json`.
- Manual (user, secure mode, staging project or after cutover): log in as each role; confirm Admin of team A cannot see team B in the UI and that a console call such as `database.ref('teamData/<B>').once('value')` returns permission denied; edit `attendance_current_user` in localStorage and confirm no change in authority; logout leaves nothing readable; legacy mode still behaves exactly as before the change.

## 13. Risks and residual risks

- **Client code is always visible** and the Firebase config is public. That is fine once rules are correct; correctness of `database.rules.json` is the whole security boundary, which is why the rules tests are mandatory.
- **Open registration.** Anyone can register and self-select any team (current behaviour, decision d). An outsider with the config can therefore join Team A as an Employee. With `everyoneSeesAll` on, that Employee reads Team A's attendance. Recommendation: keep the toggle off, or add approval (Q3). Not solved by this change because it would change sign-up behaviour.
- **Name squatting.** First registrant of an unclaimed roster name gets it (same as today); the `memberOwners` write-once claim also lets an attacker burn names. A Superuser can fix it with the Admin SDK.
- **No self-service password reset and no in-app Admin reset** (4.5). Operationally a Superuser dependency.
- **Weak passwords.** Minimum 6 characters. Brute force is limited by Firebase Auth rate limiting but not eliminated.
- **Username enumeration.** `auth/invalid-credential` for both cases; the optional enumeration-protection setting hides existence further. Team names are public by design (5.1).
- **Soft-enforced `mustResetPassword`** (4.6).
- **Rules complexity.** Hand-inlined expressions are easy to get wrong. Mitigation: tests per matrix row; reviewers should read the JSON, not only the tests.
- **Old hashes remain in the database until the old nodes are deleted.** Clients cannot read them under the new rules, but anyone with the service account, console access, or the pre-cutover backup can. Deleting the old `users` node is the closing step; the backup file contains the hashes and must be stored securely.
- **Moves are client-driven** (team change, team delete): a failed multi-path `update()` is atomic, so no partial move.
- **Stale cached legacy clients** receive permission errors after cutover until they reload.
- **App Check (optional hardening).** Firebase App Check with reCAPTCHA v3 for the web app would let the database reject requests that do not come from the real site. It limits scripted abuse with the public config but is not required for correctness and can be bypassed by determined attackers; enforcement needs console setup and a site key. Not part of this change.
- **Hosting.** GitHub Pages serves unauthenticated static files; the app shell remains public.

## 14. Open questions with recommended defaults

- **Q1. Holiday editing by Admins.** Default: Superuser only (`settings/adminCanEditHolidays` absent = false), matching `ADMIN_CAN_EDIT_HOLIDAYS = false` and decision (h). The server flag is authoritative in secure mode; the app constant is used only in legacy mode.
- **Q2. Collect real email addresses to enable self-service reset on the free plan?** Default: no. Firebase can send reset mail on Spark, but it needs the Auth email to be the real address, which means login by email or a public username-to-email lookup (privacy cost).
- **Q3. Require approval for new registrations?** Default: no, to preserve behaviour; the risk is stated in section 13. A later `settings/registrationOpen` switch would be additive.
- **Q4. Password minimum 6 (Firebase-imposed).** Default: yes.
- **Q5. Restored members keep their password (no forced reset).** Default: yes, since an Admin cannot set one.
- **Q6. Retention of old nodes after cutover.** Default: keep at least 2 weeks, delete only on explicit approval.
- **Q7. Login by full name for users with numeric username suffixes.** Default: unsupported, username required (4.1).
- **Q8. Peer-Admin management** (REQUIREMENTS Q13). Default: unchanged; same-team Admins can manage each other, never the Superuser.
- **Q9. Employees seeing teammates' names while `everyoneSeesAll` is on.** Default: yes, same as today (read-only).
