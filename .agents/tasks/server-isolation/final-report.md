# Final report: server-side team isolation

Branch: `feature/server-side-team-isolation` (based on `a7001f7`). Nothing was pushed, merged, deployed or run against the live Firebase project.

## Outcome

Secure mode is implemented behind a flag. `firebase-config.js` still ships `SECURITY_MODE = "legacy"`, so deployed behavior is unchanged until you run the cutover below. Secure mode uses Firebase Auth (Email/Password, free Spark plan only), per-team data under `teamData/{team}`, a generated `database.rules.json`, and an Admin SDK migration tool. No Cloud Functions, custom claims or other paid features are used.

Build review verdict: APPROVED (see `build-review.md`).

## Commits (since a7001f7, oldest first)

- 39968e8 docs: design for server-side team isolation
- 1ed84a4, 0b19aba, 6cd8e23, 95925b1, 2defc32 docs: design revisions after four review rounds
- d53e70d feat(rules): rules source, macro build, generated database.rules.json
- da8fe1b test(rules): emulator tests for the permission matrix
- 88e861f fix(rules): let a member read own unassigned copies for login move repair
- 5134d2d feat(app): secure mode behind SECURITY_MODE flag
- 5bce254 feat(migration): migrate-to-secure plan, run, refresh, mirror, verify and recovery commands
- 27241bd docs: secure mode, deployment rules, migration runbook and status update
- 6feb0d5 chore: record verification results
- final-report commit (this file)

## Files changed (`git diff --stat a7001f7 HEAD`: 44 files, +17,960 / -148, before this report)

- Client: `app.js` (MODE guards), `firebase-config.js` (flag), `index.html` (script tags); new `auth-helpers.js`, `data-paths.js`, `secure-flows.js`, `secure-mode.js`
- Rules: `database.rules.json` (generated), `rules/` (source, macros, build script and test, rules matrix tests, client-flow tests, `firebase.json`, `RESULTS.md`, package files)
- Migration: `tools/migrate-to-secure/` (CLI, lib/*, tests, README, package files)
- Client tests and parity notes: `tools/tests/*`, `tools/legacy-parity-check.md`
- Docs: `DESIGN-server-side-isolation.md`, `DEPLOYMENT.md`, `DOCUMENTATION.md`, `FUTURE-ENHANCEMENTS.md`, `README.md`, `.gitignore`
- Task records: `.agents/tasks/server-isolation/verification.md` (and this report)

## Verified (executed, per verification.md)

- `node --check` on all 26 JS files: OK. `database.rules.json` is valid JSON.
- Rules build tests: 6/6.
- Database emulator (`npm run test:rules`): 89/89 pass (73 rules matrix + 16 client-flow tests).
- Client tests (auth-helpers, data-paths, secure-flows, legacy-mode): 52/52.
- Migration tests (mocked Admin SDK): 35/35.
- `migrate.js --help` lists every command the docs use.
- Static diff of `app.js`, `firebase-config.js`, `index.html` against a7001f7: only MODE guards and equivalent rewrites (`tools/legacy-parity-check.md`).
- `git ls-files`: no CSV, service-account key, `migration-state.json` or `node_modules` tracked.
- Independent build review read the rules and found the escalation, cross-team and hash-exposure cases hold. The reviewer did not re-run suites.

## NOT verified

- No browser run of either mode. Secure-mode UI (`secure-mode.js`: login form, prompts, listeners, permission-denied handling) was only syntax-checked and loaded in a Node `vm`.
- Legacy parity in a browser (network and console vs a7001f7, and whether loading `firebase-auth-compat.js` creates Auth internally) was not checked.
- Firebase Auth: no Auth emulator or real Auth. Sign-in, account creation, persistence, reauthentication, password update and error codes only ran against stubs.
- Migration against any real or emulated database. Only a mocked Admin SDK was used. Password hash import (SHA256, rounds 1), the 4- and 5-character password case, `listUsers` paging and real SDK error shapes are untested.
- Production limits (Spark quotas, rule lookup limits on the live service, email enumeration protection) and the currently deployed live rules were not checked.

## Open review items (decide before or after cutover)

1. RESOLVED (0ee137f rules, c733e34 client): a team Admin can no longer terminate, restore, demote, rename, force-reset, reorder, delete or write attendance/leaves of an Admin, Manager or the Superuser. Only the Superuser can.
2. RESOLVED (0ee137f rules, c733e34 client): the Superuser cannot terminate, demote, rename or delete their own profile or roster entry.
3. `mustResetPassword` is enforced only in the client.
4. `teamNames` is publicly readable (registration dropdown) and `teams`, including `createdBy`, is readable by any signed-in user.
5. Registration is first come on a roster name, so someone can claim an unclaimed name before its owner.
6. Anyone with the public config can still register and pick a team. Keep "everyone sees everyone" off until registration approval exists.
7. Slices 3 to 5 and 6 to 7 were committed together.

## Hardening

- Rules (0ee137f): privileged-target protection and Superuser self-protection (macros `TGT`, `ORD`); emulator 243/243.
- Client (c733e34, d86bae9, d456524): permission checks and hidden controls for privileged targets; secure-mode permissions never read localStorage or DOM; the hardcoded Superuser name is gone (legacy derives it from the `isSuperAdmin` record).
- Migration (a85fb5f): Superuser from `--superuser` or the single legacy `isSuperAdmin` record.
- Optional App Check (1d8232a): off while `APP_CHECK_SITE_KEY` is empty; manual enablement steps are in FUTURE-ENHANCEMENTS.md. Docs now carry the permission matrix, the "Can someone override this from dev tools?" FAQ and why obfuscation is not security. Evidence: `hardening-verification.md`.
- Legacy mode remains insecure by design; `SECURITY_MODE` is still `"legacy"`.

## Manual steps you must do (in order, matching the runbook in FUTURE-ENHANCEMENTS.md and DEPLOYMENT.md)

Run migration commands from `tools/migrate-to-secure`. Do not push or merge before R4 passes.

1. R1 Backup. Firebase Console, Realtime Database, Data, menu, Export JSON. Store it privately (it contains password hashes). Copy the current Rules tab text somewhere safe for rollback.
2. R2 Authentication, Sign-in method: enable Email/Password (leave Email link off).
3. R3 Project settings, Service accounts: generate a private key and keep it outside the repo. Install Node 18+ and run `npm install` in `tools/migrate-to-secure`.
4. R4 Scratch-project gate (never the live project). Run the migration there, deploy `database.rules.json` there, set `SECURITY_MODE = "secure"` in a local copy pointing at the scratch config. Try login, register, team pick, Admin terminate and restore, password reset request, and a dotted username sign-in. This is also the first browser run of secure mode. Only if you want to keep old passwords, test the hash import there first. Do not continue until this passes.
5. R5 Dry run on live: `node migrate.js plan` and `node migrate.js run --dry-run --prefer arrays`. Fix any data-domain violations in the legacy app first.
6. R6 Run: `node migrate.js run --yes --rotate-all --prefer arrays --out-dir <private folder>` (add `--encrypt-csv` if wanted), then `node migrate.js verify`.
7. R7 Announce the freeze window: no password, role or team changes in the legacy app after this point, minimum password length is now 6, everyone gets a temporary password and sets a new one at first login. Share the username list (`migration-usernames-*.csv`).
8. R8 Freeze and final sync: everyone stops editing. Run `node migrate.js run --yes --rotate-all --prefer arrays --resume --refresh --mirror --confirm-no-secure-usage --out-dir <same folder>`, then `node migrate.js verify`. It must print `VERIFY PASSED`.
9. R9 Deploy rules: paste `database.rules.json` into the Rules tab or run `firebase deploy --only database`. The legacy app is blocked from now on.
10. R10 Flip the flag: set `SECURITY_MODE` to `"secure"` in `firebase-config.js`, publish (merge, GitHub Pages deploy), then immediately run `node migrate.js mark-cutover`. Expect a few minutes of errors between R9 and R10.
11. R11 Verify: smoke test as Superuser, Admin, Manager, Employee and unassigned. In the browser console, `database.ref('teamData/<another team>').once('value')` must be denied for a team Admin. Hand out the temporary passwords in person or by phone, then delete the CSV. Optional hardening: App Check, API-key referrer restriction, email enumeration protection.
12. R12 After about two weeks of stable use, and only with explicit approval, delete the old nodes (`appData`, `users`, `teamMembers`, `admins`, `managers`, `memberTeams`). Not part of this change.

Rollback (any time before R12): paste the R1 rules back, set `SECURITY_MODE = "legacy"`, publish, users reload. Legacy data is never modified by the migration. If real use happened in secure mode, first run `node migrate.js export-new --to-json <file>` to keep those edits for manual re-entry. To retry later: `node migrate.js clear-cutover --yes`, then repeat R5 to R10 (use `--mirror` in R8 only if the export shows nothing worth keeping).
