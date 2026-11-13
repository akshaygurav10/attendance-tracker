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

- `build-rules.test.js`: 6 tests, 6 pass.
- `database.rules.test.js` (emulator): **73 tests, 73 pass, 0 fail** (EXECUTED).
- `client-flows.test.js` (emulator; the real `secure-flows.js` / `data-paths.js` client
  writes run as each role against these rules): **16 tests, 16 pass** (EXECUTED).
  Auth is a local stub there (uids only); Firebase Auth itself is not emulated.
- Expanded `database.rules.json` size: **25,870 bytes**.

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
