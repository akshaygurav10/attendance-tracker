# Hardening verification

Branch `feature/server-side-team-isolation`, Windows, Node v24. Nothing pushed, deployed, or run against a live Firebase project. Emulator uses demo project `demo-attendance-rules`.

## Run (executed)

| Command | Result |
|---|---|
| `cd rules && node build-rules.js` | wrote `../database.rules.json` (29,350 bytes) |
| `git diff --exit-code ../database.rules.json` (after build) | exit 0, no diff |
| `cd rules && node --test build-rules.test.js` | 7 tests, 7 pass, 0 fail |
| `cd rules && npm run test:rules` | 243 tests (227 rules matrix + 16 client-flows), 243 pass, 0 fail |
| `node --test tools/tests/*.test.js` (files passed explicitly; Node 24 does not accept a directory) | 113 tests, 113 pass, 0 fail (includes 6 in `app-check.test.js`) |
| `cd tools/migrate-to-secure && npm test` (run as `node --test test/migrate.test.js`; `npm.ps1` is blocked by execution policy here) | 38 tests, 38 pass, 0 fail |
| `node --check` on every tracked `.js` file outside node_modules | 34 files, 0 failures |
| `JSON.parse(database.rules.json)` | ok |
| `git ls-files` filtered for csv, pem, key, serviceAccount, migration state, node_modules, .env | no matches |

`SECURITY_MODE` is still `"legacy"`; `APP_CHECK_SITE_KEY` is `""`.

## App Check source check (docs read 2026-11, for the runbook)

- https://firebase.google.com/pricing: App Check is "no-cost, subject to quotas and limits that vary based on attestation provider".
- https://firebase.google.com/docs/app-check: reCAPTCHA Enterprise is no-cost for 10,000 assessments per month. The page lists reCAPTCHA Enterprise as the web provider.
- https://firebase.google.com/docs/app-check/web/recaptcha-provider: still documents the reCAPTCHA v3 provider, `firebase.appCheck().activate(siteKey, true)` and a default token TTL of 1 day. It states no separate v3 quota. Free use on Spark is therefore confirmed only for the App Check service itself and the 10,000/month figure for Enterprise; the v3 quota must be checked in the reCAPTCHA console. The code is opt-in and disabled by default for that reason.

## NOT run

- No browser run of either mode, and no App Check run against real reCAPTCHA or Firebase (the test uses a Node vm and a stub).
- No Firebase Auth emulator; Auth is stubbed.
- No production lookup limits, quotas or live deployed rules.
- No migration run against a real project or scratch project.
- No obfuscation or minification is applied by design.
