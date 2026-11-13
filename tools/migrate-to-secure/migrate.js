#!/usr/bin/env node
'use strict';
// migrate-to-secure: one-way, add-only copy of the legacy data into the secure
// structure (design 9). Run by the Superuser on their own machine with their
// own service-account key. It never writes or deletes a legacy node, `teams`
// or `settings` (lib/guard.js). See README.md for the exact runbook commands.

const readline = require('readline');
const C = require('./lib/commands');

const HELP = `Usage: node migrate.js <command> [flags]

Connection (required for every command except help/show-passwords):
  --database-url <url>        Realtime Database URL (or env FIREBASE_DATABASE_URL)
  GOOGLE_APPLICATION_CREDENTIALS=<service-account.json>   (never commit this file)

Commands:
  plan                                   read-only report of what run would do
  run --dry-run                          same as run but writes nothing
  run --yes --rotate-all                 first migration (runbook R6); every user gets a temporary password
      [--hash-test-passed --no-rotate-all]  import legacy hashes for non-privileged users (design 8 gate)
      [--no-hash-import]                 never import hashes
      [--prefer arrays]                  resolve users/* vs arrays disagreements with the arrays
      [--allow-invalid]                  write data the rules would reject (not recommended)
      [--only <username>]                create/import a single account only
      [--out-dir <dir>] [--encrypt-csv]  where the git-ignored CSV files go; AES-256-GCM option
      [--superuser "<name>"]             Superuser's exact name; default: the single legacy users/* record with isSuperAdmin
      [--force-after-cutover]            allow run after mark-cutover
  run --yes --rotate-all --resume --refresh --mirror --confirm-no-secure-usage
                                         final sync before cutover (runbook R8)
  verify                                 read-only comparison; non-zero exit on any difference
  mark-cutover                           write migration/cutoverAt (runbook R10)
  clear-cutover --yes                    remove migration/cutoverAt (retry after rollback)
  reset-password --pending | --username <u>   temporary password printed to this terminal only
  set-superuser --username <u>           fix a mistyped Superuser
  clear-claim --key <memberKey>          remove an orphan name claim
  delete-auth-user --username <u>        remove an Auth user that has no profile
  export-new --to-json <file>            dump teamData and holidays (rollback recovery)
  show-passwords <file.csv.enc>          decrypt an --encrypt-csv file to the terminal
  help`;

function parseArgs(argv) {
    const flags = {};
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const name = a.slice(2);
            const next = argv[i + 1];
            if (['database-url', 'prefer', 'only', 'out-dir', 'superuser', 'username', 'key', 'to-json'].includes(name) && next !== undefined && !next.startsWith('--')) {
                flags[name] = next; i++;
            } else flags[name] = true;
        } else positional.push(a);
    }
    return { cmd: positional[0] || 'help', args: positional.slice(1), flags };
}

function prompt(question) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, answer => { rl.close(); resolve(answer); });
    });
}

function connect(flags) {
    const url = flags['database-url'] || process.env.FIREBASE_DATABASE_URL;
    if (!url) throw new Error('Missing --database-url (or FIREBASE_DATABASE_URL). There is deliberately no default.');
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error('Set GOOGLE_APPLICATION_CREDENTIALS to your service-account key file (kept outside git).');
    const admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: url });
    return { db: admin.database(), auth: admin.auth(), app: admin.app() };
}

async function main(argv) {
    const { cmd, args, flags } = parseArgs(argv);
    if (cmd === 'help' || flags.help) { console.log(HELP); return 0; }
    const ctx = {
        out: line => console.log(line),
        now: () => new Date().toISOString(),
        cwd: process.cwd(),
        env: process.env,
        prompt
    };
    if (cmd === 'show-passwords') return C.showPasswords(ctx, flags, args[0]);
    const conn = connect(flags);
    Object.assign(ctx, { db: conn.db, auth: conn.auth });
    try {
        switch (cmd) {
            case 'plan': return await C.plan(ctx, flags);
            case 'run': return await C.run(ctx, flags);
            case 'verify': return await C.verify(ctx, flags);
            case 'mark-cutover': return await C.markCutover(ctx, flags);
            case 'clear-cutover': return await C.clearCutover(ctx, flags);
            case 'reset-password': return await C.resetPassword(ctx, flags);
            case 'set-superuser': return await C.setSuperuser(ctx, flags);
            case 'clear-claim': return await C.clearClaim(ctx, flags);
            case 'delete-auth-user': return await C.deleteAuthUser(ctx, flags);
            case 'export-new': return await C.exportNew(ctx, flags);
            default: console.log(HELP); return 2;
        }
    } finally {
        await conn.app.delete();
    }
}

if (require.main === module) {
    main(process.argv.slice(2)).then(code => process.exit(code || 0), e => {
        console.error('Error: ' + C.redact(e.message));
        process.exit(1);
    });
}

module.exports = { parseArgs, main, HELP };
