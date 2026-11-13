# migrate-to-secure

One-way, **add-only** copy of the legacy attendance data into the secure per-team
structure (`DESIGN-server-side-isolation.md` section 9). The Superuser runs it on their
own machine with their own service-account key. It is free (Firebase Admin SDK, no Cloud
Functions, Spark plan).

What it never does:

- write, change or delete `appData`, `teamMembers`, `admins`, `managers`, `memberTeams`,
  `users`, `teams` or `settings` (enforced in code by `lib/guard.js`);
- print or store a password hash (`migration-state.json` holds only HMAC fingerprints);
- disable an Auth account (terminated users are enforced by the profile flag and the rules).

## Setup (runbook R3)

```
cd tools/migrate-to-secure
npm install
```

Windows PowerShell:

```
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\keys\attendance-sa.json"   # outside the repo
$env:FIREBASE_DATABASE_URL = "https://<project>-default-rtdb.<region>.firebasedatabase.app"
$env:MIGRATION_STATE_SECRET = "<a long random string you keep>"     # never stored in files
```

macOS/Linux: the same with `export NAME=value`. `--database-url <url>` works instead of
the environment variable. There is deliberately no default database URL.

All output files (`migration-temp-passwords-*`, `migration-usernames-*.csv`,
`migration-state.json`) go to `--out-dir` (default: the current directory) and must be
covered by `.gitignore`; `run` refuses to start otherwise.

## Commands, in runbook order

| Step | Command |
|---|---|
| R5 dry run | `node migrate.js plan` then `node migrate.js run --dry-run --prefer arrays` |
| R6 first run | `node migrate.js run --yes --rotate-all --prefer arrays --out-dir <private dir> [--encrypt-csv]` then `node migrate.js verify` |
| R8 final sync | `node migrate.js run --yes --rotate-all --prefer arrays --resume --refresh --mirror --confirm-no-secure-usage --out-dir <same dir>` then `node migrate.js verify` (must print `VERIFY PASSED`) |
| R10 cutover | `node migrate.js mark-cutover` (right after publishing `SECURITY_MODE = "secure"`) |
| R11 | hand out the temporary passwords from the CSV, then delete the CSV |

`--prefer arrays` is only needed when `plan` lists role/team disagreements between
`users/*` and the `admins`/`managers`/`memberTeams` data (the live app honors the
arrays). Data-domain violations make `run` stop; fix them in the legacy app first.

Superuser identification: the tool does not read the client code. The Superuser is
the single legacy `users/*` record with `isSuperAdmin === true`, or the exact name given
with `--superuser "<name>"`. If both are present they must match. With no flagged record
and no flag, or several flagged records and no flag, the command stops with
instructions. `verify` and `set-superuser` use the same rule.

Password policy: `--rotate-all` (the default in the runbook) gives every user a random
16+ character temporary password and `mustResetPassword`. The Superuser, Admins and
Managers are always rotated. Importing legacy hashes for other users needs
`--no-rotate-all --hash-test-passed`, and only after the scratch-project test in design
section 8. `--no-hash-import` never imports a hash.

Temporary passwords: the CSV is plain text unless `--encrypt-csv` is given (AES-256-GCM,
passphrase from a prompt or `MIGRATION_CSV_PASSPHRASE`). Read an encrypted file with
`node migrate.js show-passwords <file>`. Restrict the file right away:

```
icacls "<file>" /inheritance:r /grant:r "%USERNAME%:F"     # Windows
chmod 600 "<file>"                                          # macOS / Linux
```

## Operating commands

| Need | Command |
|---|---|
| Admin requested a password reset in the app | `node migrate.js reset-password --pending` |
| One user is locked out | `node migrate.js reset-password --username <username>` |
| Wrong account marked Superuser | `node migrate.js set-superuser --username <username>` |
| Name claimed by an abandoned registration | `node migrate.js clear-claim --key <memberKey>` |
| Auth account left without a profile | `node migrate.js delete-auth-user --username <username>` |
| Rollback: keep secure-mode edits | `node migrate.js export-new --to-json <file>` |
| Retry after a rollback | `node migrate.js clear-cutover --yes`, then repeat R5 to R10 |

`reset-password` prints `username` and the temporary password to the terminal only.

## Tests

```
npm test
```

Unit tests use a mocked Admin SDK; they never contact Firebase.
