# Verification: server-side team isolation (implementation)

Branch `feature/server-side-team-isolation` (based on `a7001f7`). Environment: Windows,
Node v24.13.0, npm via `npm.cmd`, OpenJDK 25 (Temurin-25+36), firebase-tools 15.36.0,
Database emulator jar v4.11.2. Nothing was pushed, merged, deployed, or run against a live
Firebase project. The emulator used demo project ids only.

## Commits

| Commit | Slice |
|---|---|
| `d53e70d` feat(rules): add rules source, macro build and generated database.rules.json | 1 |
| `da8fe1b` test(rules): emulator tests for the permission matrix | 2 |
| `88e861f` fix(rules): let a member read own unassigned copies for login move repair | 2 (fix found while building slice 5) |
| `5134d2d` feat(app): secure mode behind SECURITY_MODE flag (Firebase Auth, per-team paths) | 3, 4, 5 (one commit; all edit `app.js`) |
| `5bce254` feat(migration): migrate-to-secure plan, run, refresh, mirror, verify and recovery commands | 6, 7 (one commit) |
| `27241bd` docs: secure mode, deployment rules, migration runbook and status update | 8 |
| this file + `tools/legacy-parity-check.md` | 9 |

## Commands run and results (all EXECUTED)

| Command | Result |
|---|---|
| `node --check` on all 26 JS files (root app files, `rules/*`, `tools/tests/*`, `tools/migrate-to-secure/**`) | 26/26 OK |
| `node -e "JSON.parse(...database.rules.json)"` | valid JSON, 25,870 bytes |
| `cd rules && node build-rules.js && node --test build-rules.test.js` | 6/6 pass; no macro name left in output; `ADMIN_OF` not rewritten by `ADM` |
| `cd rules && npm run test:rules` (`firebase emulators:exec --only database ... node --test database.rules.test.js client-flows.test.js`) | **89/89 pass** (73 rules matrix tests + 16 client-flow tests), exit 0 |
| `node --test tools/tests/auth-helpers.test.js tools/tests/data-paths.test.js tools/tests/secure-flows.test.js tools/tests/legacy-mode.test.js` | 52/52 pass |
| `cd tools/migrate-to-secure && npm install && npm test` | install OK (firebase-admin 14.5.1); 35/35 pass |
| `node tools/migrate-to-secure/migrate.js --help` | lists every command used in the docs |
| `git diff a7001f7 HEAD -- app.js firebase-config.js index.html` | only `MODE` guards and equivalent rewrites; see `tools/legacy-parity-check.md` |
| `git ls-files` | no CSV, service-account key, `migration-state.json` or `node_modules` tracked |
| grep of DEPLOYMENT.md for the stale expiry date / custom-claims rules | none left |

### What the emulator tests cover

Every bullet of design section 13 "Rules tests": escalation boundary (self-created profile
with each privileged flag, unclaimed key, whole-profile overwrite, delete, `isAdmin` child
write with and without profile, Superuser changes, nobody writes `isSuperAdmin`), `replace`
semantics, team isolation (Admin, Manager, Employee toggle off/on, unassigned vs
unassigned with toggle on and off), all five leave types per role, registration order,
self move without SELFMOVE (including Manager/Admin blocked, second change blocked,
interrupted move), roster `uid`, terminate, Admin-writable flags, node shape, other
nodes, legacy nodes denied, and the three lookup-limit worst cases (all accepted; no
lookup or size error). `client-flows.test.js` runs the real `secure-flows.js` and
`data-paths.js` writes (register, post-sign-in 6a/6b, granular attendance writes,
terminate/restore, team create/rename/move/delete, listener plan reads per role) as each
role against the rules.

### Findings from the tests that changed code (documented in `rules/RESULTS.md`)

1. `KEYRE` control-character range is evaluated as non-matching by the emulator; the
   design's test-gated fallback was applied (`/^[^$#\[\]\/.]{1,128}$/`), with control
   characters stripped by the client and reported by the migration.
2. `String.replace` replaces all occurrences; the `name`/`memberKey` clause is kept. `\d` works.
3. `passwordResetRequests/$uid` rejected every request because `$other` matched the
   unnamed children; named `requestedBy`/`requestedAt` rules added.
4. Login step 6b move repair could not read the user's own leftover `unassigned` copies
   once `teamId` was set; the per-key `.read` now also allows the user's own key in
   `unassigned` (own data only). Tested.
5. Team delete cannot write `teamData/{team}` as a whole (no grant there); the payload now
   removes per member key. Tested.

## NOT executed / NOT verified

- **No browser run of either mode.** Secure-mode DOM glue (`secure-mode.js`: login form,
  prompts, listeners, re-rendering, permission-denied handling, `onAuthStateChanged`) was
  only syntax-checked and loaded in a Node `vm`; it was never clicked through.
- **Legacy parity in a browser** (network panel and console vs `a7001f7`, and whether
  loading `firebase-auth-compat.js` instantiates Auth internally): not checked. Static
  diff review and the `vm` test passed.
- **Firebase Auth**: no Auth emulator and no real Auth. Sign-in, account creation,
  `setPersistence`, `reauthenticateWithCredential`, `updatePassword` and error codes are
  exercised only against stubs.
- **Migration against any real or emulated database**: the script ran only against a
  mocked Admin SDK. `importUsers` with SHA256/rounds 1 (design 8 hard gate), the 4- and
  5-character password case, `listUsers` paging and real Admin SDK error shapes are unverified.
- **Production limits**: Spark plan quotas, rule lookup limits on the live service and
  email enumeration protection behaviour are unverified (emulator only).
- The currently deployed live rules were not read (no console access).

## Known gaps and behaviour notes (not silently changed)

- No in-app control writes `settings/adminCanEditHolidays`; absent means Superuser-only
  holidays, which is today's default. The Superuser could set it from the console.
- Consequences of the approved design that users will see in secure mode (listed in
  FUTURE-ENHANCEMENTS.md): roles can be set only after a person registers (roles live on
  the uid profile); a team Admin cannot rename themselves (profile `name` is writable by
  the Superuser or an Admin of another member's team only); Admin/Manager badges are shown
  only to the Superuser and team Admins; Superuser import skips names that have no roster
  entry.
- Slices 3 to 5 and 6 to 7 were committed together rather than one commit per slice.

## Manual steps left for the user

Runbook R1 to R12 in FUTURE-ENHANCEMENTS.md: backup and copy live rules, enable
Email/Password, service-account key and `npm install`, scratch-project staging test
(including a browser run of secure mode and, only if keeping old passwords, the hash
gate), `plan`/dry run, `run --rotate-all`, `verify`, announce, freeze and final sync,
deploy `database.rules.json`, flip `SECURITY_MODE` and `mark-cutover`, smoke test per
role, hand out temporary passwords and delete the CSV, decide later on deleting old nodes.
