# Verification: team-scoped Admin (2026-11-12)

## What was run

- `node --check app.js`, `firebase-config.js`, `.agents/tasks/teams-roles-permission-test.js`: all exit 0.
- `node .agents/tasks/teams-roles-permission-test.js`: 89 PASS, 0 FAIL, prints `ALL PASSED`, exit 0.

## What the test covers (vm harness, no Firebase, no DOM)

- Visibility: Adm A sees only team A (+self); Adm B sees only team B; unassigned Adm U sees only self; Super sees all; Manager/Employee unchanged; toggle on does not widen Admins.
- Admin+Manager: union inside own team only (no other-team edit, no holidays).
- `canAdminMember` / `canAdminTeamId` / `getAdminScopeMembers`, including Superuser account protection even when assigned to the Admin's team, and empty `TEAMS`/`MEMBER_TEAMS` (no throw).
- Data layer: Admin cannot mark attendance, set/remove leave for other-team members; cannot import; holiday writes denied unless `ADMIN_CAN_EDIT_HOLIDAYS` is flipped (checked via `canManageHolidays` / `isViewAllowed`); filtered export contains only scoped members.
- Direct calls by Adm A on other-team members are rejected with an alert and roster/team/admin state is unchanged: `editMember`, `removeMember`, `resetPasswordForMember`, `restoreMember`, `reorderMembers`, plus `editMember` on the Superuser and removing self.
- `addMember`: unassigned Admin refused; Admin always lands in own team even when `'tb'` is passed; Superuser may choose a team; new Team B member is visible to Adm B and not Adm A.
- `resetTeamToDefault`, `syncImport` refused for Admin. Existing Manager/Employee/Superuser-only rows still pass. Old assertions that encoded global Admin were changed to the new behavior.

## Matrix rows traced through code

Visible/edit/manage rows follow `getVisibleMembers` (Super global; others self + same non-null team when Admin, Manager or toggle on) and `canAdminMember` (checked by `canEdit`, `editMember`, `removeMember`, `resetPasswordForMember`, `reorderMembers`, `renderTeamManagement`, `getAdminScopeMembers` for reports/export). Restore uses `canAdminTeamId` on the recorded team. Holidays use `canManageHolidays`. Label: `getMyTeamLabel` returns `All Teams` only for Super.

## Could not be tested

- No Firebase credentials: real `database` writes in `addMember`, `resetPasswordForMember`, `restoreMember` (including the terminated-user list filter in `renderTeamManagement`) were not exercised; harness runs with `database` undefined.
- No browser: DOM rendering (Manage Team buttons, team select for Superuser, notice for team-less Admin, hidden import card, reports HTML subtitle, drag-drop events) and the logout/login lifecycle (605054d) were not run. `lockApp` was not changed and no new module state caches scope, by code reading only.
- Report HTML (`generateDashboardReport` / `generateEmailHTML`) not run; they now use `getAdminScopeMembers()` by code reading. The plan's team-name subtitle in reports was not added.
- Manual browser checklist in DOCUMENTATION.md / README.md is still to be done.

## Security honesty

Firebase rules are NOT deployed, there is no Firebase Auth, and `appData` is one blob keyed by member name. All scoping is client-side; a user with the Firebase config can read everything. Team-scoped reads cannot be enforced by rules without restructuring.

## Open questions for the user

1. Should team Admins edit global holidays? Default no (`ADMIN_CAN_EDIT_HOLIDAYS = false`).
2. (Resolved in review iteration) Admins no longer pick a team at login/register; `canSelfAssignTeam` gates both. Harness row added; `node .agents/tasks/teams-roles-permission-test.js` -> ALL PASSED, `node --check app.js` and `firebase-config.js` clean. The inline login/register handlers themselves (Firebase writes) were not run.
3. Peer-Admin management (Admin can manage another same-team Admin) is current behavior, now documented (REQUIREMENTS open question 13). Keep?
4. Browser/Firebase manual checklist still pending before release.
