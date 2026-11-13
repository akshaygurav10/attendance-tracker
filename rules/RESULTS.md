# Rules test results

Environment: Windows, Node v24.13.0, OpenJDK 25 (Temurin-25+36), firebase-tools 15.36.0,
Database emulator `firebase-database-emulator-v4.11.2.jar` (downloaded by firebase-tools),
`@firebase/rules-unit-testing` 6.0.0, `firebase` 13.3.0. Emulator only, demo project id
`demo-attendance-rules`; no live Firebase project was contacted.

## Commands

```
cd rules
npm install
node build-rules.js            # writes ../database.rules.json
node --test build-rules.test.js
npm run test:rules             # firebase emulators:exec --only database ... node --test database.rules.test.js
```

## Result

- `build-rules.test.js`: 7 tests, 7 pass.
- `database.rules.test.js` (emulator): **227 tests, 227 pass, 0 fail** (EXECUTED). The
  original 73 plus 154 from hardening FEAT-001 (see below).
- `client-flows.test.js` (emulator; the real `secure-flows.js` / `data-paths.js` client
  writes run as each role against these rules): **16 tests, 16 pass** (EXECUTED).
  Auth is a local stub there (uids only); Firebase Auth itself is not emulated.
- Expanded `database.rules.json` size: **29,350 bytes** (25,870 before FEAT-001).

## Hardening FEAT-001: privileged targets and Superuser self-protection

- New macros `TGT(k)` (profile that owns roster key `k`, via `memberOwners`) and `ORD(k)`
  (key is unregistered, or its owner has none of `isAdmin`, `isManager`, `isSuperAdmin`).
  `ADMIN_OF` now also requires the target's `isAdmin` and `isManager` to be not true.
- A team Admin can no longer terminate, restore, demote, rename (profile or roster),
  force-reset, request a reset for, reorder, delete, or write attendance/leaves of an Admin,
  Manager, Admin+Manager or the Superuser. Only the Superuser can.
- The Superuser cannot terminate, demote (`isAdmin`), rename or delete their own profile
  or roster entry, nor set their own roster `terminated` true. `isSuperAdmin` stays
  `.write: false` for everyone.
- Fallback: **none needed**. The `ORD($memberKey)` guard on `attendance` and `leaves`
  (two extra lookups) was accepted by the emulator with no lookup-limit error.
- `client-flows.test.js`: the case "Admin terminating another Admin also clears isAdmin"
  is now "only the Superuser can terminate an Admin": the Admin payload is denied and the
  same payload from the Superuser succeeds and clears `isAdmin`. Count unchanged (16).

## Hardening FEAT-004: re-run and what it covers

- Rules were not changed by FEAT-004. Re-run at the end of hardening: `build-rules.test.js`
  7/7; emulator `database.rules.test.js` + `client-flows.test.js` **243 tests, 243 pass, 0 fail**
  (EXECUTED, emulator only). `node build-rules.js` leaves `database.rules.json` unchanged
  (29,350 bytes).
- The permission matrix for privileged targets is documented in
  `DESIGN-server-side-isolation.md` section 6.1. App Check is a client-side extra and is not
  part of these tests; the rules remain the only authorization.
- Not exercised: production lookup limits, real Firebase Auth, App Check enforcement.

## Lookup-limit acceptance gate (design 2.1)

The three worst cases were accepted by the emulator with no lookup-limit or size error:

| Case | Result |
|---|---|
| Admin writing a member's attendance | pass |
| Manager reading a team (`members`, `attendance`, `leaves`) | pass |
| Move as one multi-path update (Superuser move, and the self move step 3) | pass |

Caveat: the emulator is the evidence here; production limits were not exercised.

## Test-gated items (design 7.1, 7.2)

| Item | Outcome | Action |
|---|---|---|
| `String.replace` replaces every occurrence (`name` -> `memberKey`) | Replaces all (`'a.b.c'.replace('.', '_') === 'a_b_c'` evaluated true; profile `A.B.C` with key `A___DOT___B___DOT___C` accepted) | Clause kept as designed |
| `\d` in date regexes | Accepted | Kept |
| `KEYRE` control-character range `\x00-\x1f\x7f` | **Rejected**: with the range present, `matches` evaluated false for a plain key (`NewU`), so every claim was denied | **Fallback applied**: `KEYRE = /^[^$#\[\]\/.]{1,128}$/`. Control characters are stripped by the client key function in secure mode and reported by the migration (`plan`/`verify`) as data-domain violations |

## Deviation from the design rules text (found by the tests)

`passwordResetRequests/$uid` had `"$other": { ".validate": false }` but no named
`requestedBy`/`requestedAt` children, so `$other` matched them and every request was
rejected. Added `requestedBy` (`isString()`) and `requestedAt` (`isString()`, length <= 40)
child rules. This makes the designed behaviour work; it grants nothing new.

Login step 6b ("move repair", design 4.2) must re-read a user's own leftover
`teamData/unassigned/...` copies after `teamId` has been set. As written, the per-key
`.read` was `SELF($memberKey) && BUCKET($teamId)`, and `BUCKET('unassigned')` is false once
`teamId` exists, so the repair could never read what it has to copy. The per-key `.read`
on `members`, `attendance` and `leaves` is now
`SELF($memberKey) && (BUCKET($teamId) || $teamId === 'unassigned')`. This only lets a user
read their own claimed key in the `unassigned` bucket (their own data); it gives no list
read of `unassigned` and nothing about anyone else. A test covers it (own copies readable,
another unassigned user's copies and other teams still denied).
