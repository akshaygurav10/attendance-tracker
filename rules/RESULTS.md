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
- `database.rules.test.js` (emulator): **72 tests, 72 pass, 0 fail** (EXECUTED).
- Expanded `database.rules.json` size: **25,780 bytes**.

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
