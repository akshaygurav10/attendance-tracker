# Future Enhancements

## 1. Server-side data isolation between teams (Firebase Auth + restructured data + rules)

Status: not started. Added 2026-11-12.

### Problem

Team-scoped visibility (Admin and Manager see only their own team, Superuser sees all) is enforced only in the browser code. All attendance data is stored as one blob (`appData`, keyed by member name), and the app uses its own login instead of Firebase Auth. Anyone who has the Firebase config can open browser dev tools and read the whole database, including other teams' attendance and leave data.

The `users` node also holds password hashes. The browser reads it during login, so it is exposed in the same way.

Note: `DEPLOYMENT.md` says the database rules are fully open until 2026-08-21. That date has passed. The current rules have not been checked in the Firebase console, so confirm them before relying on any assumption about them.

### Do we need it?

It depends on how sensitive the data is.

- If teams are friendly colleagues and the data is low-risk, the current behavior can be accepted as a documented limitation.
- If teams must not see each other's data, or real security is required, this enhancement is needed.

### Why rules alone cannot fix it

Firebase rules restrict access by the signed-in user's identity. The app does not use Firebase Auth, so Firebase does not know who anyone is. Real enforcement needs all three of these:

1. **Firebase Auth**, so each user has an identity Firebase can check.
2. **Data split by team**, for example `teams/{teamId}/attendance/...`, instead of one blob keyed by member name.
3. **Rules** that let a user read only their own team's path, plus Superuser access.

### Doing it without data loss

The change can be made without losing existing data if it is staged:

1. Export a full backup of the database first.
2. Add the new structure alongside the old one and copy the data across. Do not move or delete anything at first.
3. Run both side by side and check that the numbers match.
4. Switch the app to the new structure.
5. Keep the old blob until the new setup is confirmed. Delete it only on explicit approval.
6. Deploy the rules last, once the app works with them. Deploying them too early would lock everyone out.

### Open points

- **User accounts.** Existing passwords are stored as hashes. Whether they can be imported into Firebase Auth has not been checked. If not, each user would need a one-time password reset.
- **Rollback plan.** Needs to be written before any data or rules change.
- **Superuser access.** Needs a rule or claim that allows reading all teams.

### Suggested next step

1. Check the current database rules in the Firebase console.
2. Decide whether real security is worth the larger change.
3. If yes, write a migration plan (backup, rollback, user impact) and get it approved before changing any data or rules.
