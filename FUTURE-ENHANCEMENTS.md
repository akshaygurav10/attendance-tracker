# Future Enhancements

## 1. Server-side data isolation between teams (Firebase Auth + restructured data + rules)

Status: **implemented in code, pending migration.** Added 2026-11-12. Code on branch `feature/server-side-team-isolation`. Design: `DESIGN-server-side-isolation.md`.

Nothing has changed for users yet. The app still runs in legacy mode (`SECURITY_MODE = "legacy"` in `firebase-config.js`), no rules have been deployed and no data has been migrated. The steps below are manual and are done by the Superuser.

### Problem (unchanged until cutover)

In legacy mode every permission check is in the browser. All attendance data is one blob (`appData`), the app does not use Firebase Auth, and the `users` node holds password hashes that the browser downloads at login. Anyone with the Firebase config can read or change everything from browser dev tools.

### What the code now provides

- **Firebase Auth (Email/Password)** in secure mode. Users still log in with their username; the account email is `username@attendance.local` (no email is ever sent).
- **Per-team data**: `teamData/{teamId}/members|attendance|leaves/{memberKey}`, profiles in `usersV2/{uid}` (no password hash).
- **`database.rules.json`**: the server enforces who can read and write what. Tested on the Database emulator (`rules/RESULTS.md`).
- **`tools/migrate-to-secure`**: local script that copies the legacy data into the new structure. Add-only; it never changes or deletes `appData`, `users`, `teams`, `settings` or any other legacy node.
- **Free plan only**: Firebase Spark. No Cloud Functions, custom tokens, custom claims or other paid features.

### Runbook (do the steps in order)

| # | Step |
|---|---|
| R1 | **Backup.** Firebase Console → Realtime Database → Data → ⋮ → Export JSON. Store it privately (it contains password hashes). Copy the current Rules tab text somewhere safe for rollback. |
| R2 | **Enable Email/Password** in Authentication → Sign-in method (leave Email link off). Check Authentication usage for any limit that matters. |
| R3 | **Service-account key**: Project settings → Service accounts → Generate new private key. Keep it outside the repo. Install Node 18+ and run `npm install` in `tools/migrate-to-secure`. |
| R4 | **Staging test in a scratch Firebase project** (never the live one): run the migration there, deploy `database.rules.json` there, set `SECURITY_MODE = "secure"` in a local copy pointing at the scratch config, and try login, register, a team pick, an Admin terminate/restore and a password reset request. Check that an `@attendance.local` account with a dotted username signs in. Only if you want to keep old passwords: test the hash import there first (design section 8, including 4- and 5-character passwords). |
| R5 | **Dry run** on the live project: `node migrate.js plan` and `node migrate.js run --dry-run --prefer arrays`. Fix any data-domain violations in the legacy app first. |
| R6 | **Migrate**: `node migrate.js run --yes --rotate-all --prefer arrays --out-dir <private folder>` (add `--encrypt-csv` if you want the password file encrypted). Every user gets a temporary password in a git-ignored CSV. Then `node migrate.js verify`. |
| R7 | **Announce** the freeze window and the changes listed below. Tell users: no password, role or team changes in the legacy app after this point; new minimum password length is 6; everyone receives a temporary password and sets a new one at first login. Share the username list (`migration-usernames-*.csv`). |
| R8 | **Freeze and final sync**: everyone stops editing. Run `node migrate.js run --yes --rotate-all --prefer arrays --resume --refresh --mirror --confirm-no-secure-usage --out-dir <same folder>`, then `node migrate.js verify`. It must print `VERIFY PASSED`. |
| R9 | **Deploy the rules**: paste `database.rules.json` into the Rules tab (or `firebase deploy --only database`). From now on the legacy app is blocked. |
| R10 | **Switch the app**: change `SECURITY_MODE` to `"secure"` in `firebase-config.js`, publish (merge and GitHub Pages deploy), then immediately run `node migrate.js mark-cutover`. A few minutes of errors between R9 and R10 are expected. |
| R11 | **Smoke test** as each role (Superuser, Admin, Manager, Employee, unassigned). From the browser console, `database.ref('teamData/<another team>').once('value')` must be denied for a team Admin. Hand out the temporary passwords in person or by phone, then delete the CSV. Optional: App Check, API-key referrer restriction, email enumeration protection (if R4 showed registration still works). |
| R12 | **Stabilize** (suggested 2 weeks). Delete the old nodes (`appData`, `users`, `teamMembers`, `admins`, `managers`, `memberTeams`) only after explicit approval. Not part of this change. |

**Rollback** (any time before R12): paste the R1 rules back, set `SECURITY_MODE = "legacy"`, publish, users reload. Legacy data was never modified. Before rolling back after real use, run `node migrate.js export-new --to-json <file>` to keep secure-mode edits for manual re-entry. To try again later: `node migrate.js clear-cutover --yes`, then repeat R5 to R10 (use `--mirror` in R8 only if the export shows nothing worth keeping).

### Superuser identification in the migration

The client no longer contains a Superuser name. `migrate.js` takes it from `--superuser "<name>"` or from the single legacy `users/*` record with `isSuperAdmin === true`. If both are present they must match. With no flag and zero or several such records it stops and says what to do. The Superuser (and every Admin and Manager) gets a random temporary password and `mustResetPassword`; after the rules deploy only the Admin SDK can set `isSuperAdmin` (`migrate.js set-superuser`). A legacy Superuser keeps logging in with the existing password until cutover. On a fresh legacy database with no `isSuperAdmin` record, set it by hand in the console first. Legacy mode stays insecure regardless; only secure mode with the deployed rules protects the data.

### Optional hardening after R11 (all manual, all free on Spark)

These are extra layers. The database rules are the security boundary; none of these replace them. Do them one at a time and re-test login after each.

1. **App Check (reCAPTCHA v3).** Register the GitHub Pages site for reCAPTCHA v3 at https://www.google.com/recaptcha/admin to get a site key and secret key. In Firebase Console → App Check → Apps, register the web app with the reCAPTCHA provider and the secret key. Put the **site key** (public) in `APP_CHECK_SITE_KEY` in `firebase-config.js` and publish; the app then loads `firebase-app-check-compat.js` and activates it. Watch App Check metrics for Realtime Database for a few days. Only when almost all requests carry a valid token, enable enforcement for Realtime Database. Enforcing too early locks out users who still have the old page cached; unenforcing in the console is the rollback. With the key empty (default) nothing is loaded. Sources: https://firebase.google.com/docs/app-check/web/recaptcha-provider and https://firebase.google.com/docs/app-check (read for this change).
2. **API-key HTTP-referrer restriction.** Google Cloud Console → APIs & Services → Credentials → the browser API key → Application restrictions → HTTP referrers, add the GitHub Pages origin (and `localhost` for testing). This only stops casual reuse of the key from other sites. Anyone can forge a referrer outside a browser, so it is not a security boundary.
3. **Email enumeration protection.** Authentication → Settings → User actions. Registration picks a free username by catching `email-already-in-use`; test registration of a colliding name in staging before turning this on, as noted in R4.

Cost and quota (Firebase pricing page lists App Check as no-cost, subject to the attestation provider's quotas): the Firebase App Check overview states reCAPTCHA Enterprise is free for 10,000 assessments per month. The v3 provider page does not give its own number, so check the reCAPTCHA admin console quota and the App Check metrics for this app's traffic. Pricing: https://firebase.google.com/pricing.

### What users will notice after cutover

| Area | Before (legacy) | After (secure mode) |
|---|---|---|
| Password minimum | 4 characters | 6 (Firebase Auth minimum) |
| Passwords at cutover | Existing passwords | Everyone gets a temporary password and sets a new one at first login |
| Remember me | Pre-fills a password stored in the browser | Keeps you signed in; no password is stored |
| Admin password reset | Admin sets `Temp@123` | Admin clicks "Request password reset"; the Superuser runs `reset-password --pending` and hands over a temporary password |
| Forgot password | Ask an Admin | Ask the Superuser |
| Login by full name | Works | Works, unless the username got a number suffix; then use the username |
| Terminate | Marked terminated, removed from the team and admin lists | Same; the account stays but cannot read or write anything |
| Restore | Member sets a new password at next login; Admin may reset it now | Same prompt at next login; "reset now" becomes a reset request; Admin rights are not restored |
| Pre-added member registering in a different team | History follows the person | A new entry is created in the chosen team; the earlier entry stays where it was added (the Superuser can move it) |
| Team-less Manager | Could pick a team at login | Sees "Waiting for team assignment" until the Superuser assigns one |
| Roles for people who have not registered yet | Superuser could flag a name in advance | The Superuser sets Admin/Manager after the person registers |
| Renaming yourself as a team Admin | Allowed | Ask the Superuser |
| Admins and Managers badges | Visible to everyone who can see the member | Visible to the Superuser and team Admins only |
| Short interruption | n/a | Errors for a few minutes between R9 and R10 |

### Manual steps only the Superuser can do

R1 backup and rules copy, R2 enable Email/Password, R3 service-account key and `npm install`, R4 scratch-project test, R5/R6/R8 migration commands, R7 announcement, R9 rules deploy, R10 flag flip and `mark-cutover`, R11 smoke test and password hand-over, R12 decision on deleting old nodes. None of these were done by the implementation work; nothing was run against the live project.

### Known limits (residual risks)

- Anyone with the public config can still register an account and pick a team (as today). With "everyone sees everyone" on, such an account can read that team. Keep the toggle off or ask for registration approval as a later change.
- Team names are public (pre-login picker). No person data is public.
- Old password hashes stay in the `users` node until R12. Rules block clients from reading them; the R1 backup also contains them.
- The forced new password after a reset is a soft policy (the user already knows the temporary password).
