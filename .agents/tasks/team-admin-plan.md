# Implementation Plan: Team-scoped Admin

Branch: `main` (no worktree). Plain JS, no build step. Verification = run the permission test with node, then `node --check app.js`, then a manual browser pass (items listed in step 9). Preserve commits 605054d (lockApp/unlockApp, listener cleanup), 88de19b, 0162eda, db3561f.

Line numbers below refer to `app.js` as read today and will drift as edits land. Locate by function name.

## Findings from reading the code

- Admin globality comes from a handful of places: `isAdmin()` (l.79) is true for Super and anyone in `ADMIN_MEMBERS`. `getVisibleMembers()` (l.141) returns `[...TEAM_MEMBERS]` for any `isAdmin()`. `canEdit()` (l.221) returns true for any `isAdmin()`. `getMyTeamLabel()` (l.128) returns 'All Teams' for any `isAdmin()`.
- Everything else gates on `canManageTeam()`, `canUseReports()`, `canManageHolidays()` (all `= isAdmin()`) or on raw `isAdmin()`. None of them look at the target member.
- Functions that act on a target member without a team check:
  - `resetPasswordForMember`, `editMember`, `removeMember`, `restoreMember`, `addMember`
  - `resetTeamToDefault`, the drag-drop `drop` handler (uses index into the global `TEAM_MEMBERS`)
  - `renderTeamManagement` (iterates all `TEAM_MEMBERS`; terminated section reads every `users/*` record)
  - `generateDashboardReport`, `generateEmailHTML` (iterate all `TEAM_MEMBERS`; average divides by `TEAM_MEMBERS.length`)
  - `syncExport` / `exportJSON` (dumps the whole blob)
  - `importJSON` (REPLACES the whole `appData` blob, so a team admin could overwrite other teams' attendance)
  - the `toggleVisibility` change handler (writes the global `settings/everyoneSeesAll`)
  - `renderTeamList` (`teamTag` shown for any admin)
  - `markAttendance`, `markLeave`, `removeLeave` (via `canEdit`)
- Calendar click handlers (l.2576-2622) already call `canViewMember` + `canEdit`, so fixing those two helpers is enough there.
- `addMember` only pushes to `TEAM_MEMBERS`. It writes no team, so a team admin could not see the member they just added. It must write `memberTeams/{key}` and `users/{key}/teamId`. `handleRegister` already honours an existing `users/{key}.teamId` over the picker, so a later self-registration keeps the admin-assigned team.
- Superuser flows (`createTeam`, `renameTeam`, `deleteTeam`, `assignTeam`, `setManager`, `setAdminRole`) are already Superuser-only. No change except the confirm text in `setAdminRole`, which says "edit everyone's attendance".

## Decisions

1. **Scope model.**
   - Superuser: global.
   - Admin (non-Super): own team plus self.
   - An Admin whose team is null or missing sees and administers only themselves.
   - Rationale: the user said "visibility specific to team only", and a missing `teamId` must never fall back to global.
2. **Admin+Manager.** Same team scope, union of capabilities inside the team. Falls out of `getVisibleMembers` because both roles scope to the team.
3. **Superuser team filter dropdown: skipped.** Superuser stays global, and a filter would add UI state and extra renders for no stated requirement. Record it as a possible follow-up in the requirements doc.
4. **Holidays.**
   - Add `let ADMIN_CAN_EDIT_HOLIDAYS = false;` near the top of `app.js`, next to the role helpers (`let` so the test can flip it).
   - `canManageHolidays() = isSuperUser() || (ADMIN_CAN_EDIT_HOLIDAYS && isAdmin())`.
   - Why Superuser-only by default: holidays live in one global `appData.holidays` list, so a team admin edit would change every team's working-day maths, which breaks the "never affect other teams" intent.
   - Admins still see holidays on the calendar. Only the Holidays nav and edit actions are hidden.
   - Document as an open question: "Should team Admins be allowed to edit global holidays?" The answer is a one-line flag flip.
5. **`everyoneSeesAll` toggle.**
   - Superuser only (global setting, affects other teams' employees).
   - `adminSettings` panel shown only to Superuser. The change handler denies non-Super.
   - Admins still see the toggle's effect on their team's Employees. Flag in open questions.
6. **Import/Export.**
   - `syncImport` and `DataStore.importJSON` become Superuser-only via a new `canImportData() = isSuperUser()`. Import replaces the whole blob.
   - `syncExport` stays available to Admin (`canUseReports`) but exports a filtered copy: only the scoped members' `attendance` and `leaves`, plus global `holidays`.
   - Hide the import button for Admins if one is separate in the modal.
7. **Add member.**
   - Admin: always created in own team. The UI gives no team choice, and `addMember` ignores any team argument from a non-Super.
   - Admin with no team: refused with an alert ("Ask the Superuser to assign you to a team first").
   - Superuser: `addMember(name, teamId)` may pass a team. If the add-member form has no team select, add a small `<select id="memberTeam">` for the Superuser only (populated like `renderTeamsAdmin` options). If `teamId` is omitted, the member is Unassigned as today.
8. **Protected accounts.**
   - A non-Super can never edit, remove, rename or reset the password of `SUPER_ADMIN`, even if the Superuser was assigned to their team.
   - An Admin cannot remove themselves.
   - The existing Super guard in `removeMember` stays.
9. **Reorder.** Drag-reorder is scoped to the visible subset, by member name, not by index. Move the dragged name to the dropped name's position inside the global array.
10. **`resetTeamToDefault`.** Superuser only. It rewrites the global roster.
11. **Rules / security.** No code can make this secure. See the doc steps.

## Plan

- [ ] 1. Add the scoping helpers and rewrite the core permission functions in `app.js` (about l.60-165 and l.221).

  Add or change, in this order (no behavior reads from the later ones before they are defined, since they are function declarations):
  - `let ADMIN_CAN_EDIT_HOLIDAYS = false;` near the top of the file, with a comment pointing at the requirements doc open question.
  - `isTeamAdmin()`: `isAdmin() && !isSuperUser()`.
  - `getAdminScopeMembers()`: the members the current user administers. Rules:
    - no user: `[]`
    - Super: `[...TEAM_MEMBERS]`
    - Admin: `TEAM_MEMBERS.filter(m => m === user || (myTeam && getMemberTeamId(m) === myTeam))`
    - not Admin: `[]`
  - `canAdminMember(name)`:
    - falsy name or no user: false
    - Super: true
    - `name === SUPER_ADMIN`: false
    - not Admin: false
    - `name === user`: true
    - otherwise: true only if `myTeam` is non-null and `getMemberTeamId(name) === myTeam`
  - `canAdminTeamId(teamId)`: Super true; Admin true only if `teamId && teamId === getMyTeamId()`.
  - `canImportData()` = `isSuperUser()`.
  - `getVisibleMembers()`:
    - Super returns all.
    - Everyone else (Admin, Manager, Employee, and Admin+Manager) uses the same team rule: self always, plus own-team members when `myTeam` is set and (`isAdmin() || isManager() || everyoneSeesAllEnabled()`).
    - This replaces the `if (isAdmin()) return [...TEAM_MEMBERS]` line.
  - `canEdit(member)`: `currentUser === member || canAdminMember(member)`. Manager gets no extra rights (unchanged).
  - `getMyTeamLabel()`: Super returns 'All Teams'. Everyone else returns the team name or 'No team'. Remove the `isAdmin()` shortcut.
  - `canManageHolidays()` as in decision 4.
  - `canViewSummary()`: unchanged expression; its output is now team-scoped via `getVisibleMembers`.
  - Keep `canManageTeam()`, `canUseReports()` as `isAdmin()` (the capability stays, the scope shrinks).

  Files: `app.js`
  Verify: `node --check app.js`, then the node permission test (step 8) for the helper rows.

- [ ] 2. Enforce `canAdminMember` inside every action function that targets a member.

  All of these go in `app.js`. Each checks first, calls `denyAction(...)` and returns (or returns false) on failure:
  - `resetPasswordForMember(member)`: replace `!isAdmin()` with `!canAdminMember(member)`. `restoreMember` calls it, so it stays consistent.
  - `editMember(oldName)`: require `canAdminMember(oldName)`. Also refuse when `oldName === SUPER_ADMIN` and the actor isn't Super.
  - `removeMember(name)`: require `canAdminMember(name)`, refuse `name === getCurrentUser()` (alert "You cannot remove yourself"), and keep the SUPER_ADMIN guard.
  - `restoreMember(name)`: require `canManageTeam()` and a team match for the terminated record. Use `canAdminTeamId(MEMBER_TEAMS[nameKey(name)] || null)`. A terminated member with no team is restorable by Super only. Removal doesn't clear `memberTeams`, so the team is still known.
  - `addMember(name, teamId)`:
    - Require `isAdmin()`.
    - If `isTeamAdmin()`: deny when `getMyTeamId()` is null. Force `teamId = getMyTeamId()`.
    - If Super: use `teamId` only if `TEAMS[teamId]` exists, else null.
    - After the existing terminated-user check, push to `TEAM_MEMBERS`. When `teamId` is set, also write `memberTeams/{nameKey}` and `users/{nameKey}/teamId` in one `database.ref().update()` (same shape as `assignTeam`), guarded by `typeof database !== 'undefined'`.
    - Also update the in-memory `MEMBER_TEAMS[nameKey(name)]` so the new member shows up before the listener fires.
    - Reject a name that is the key of an existing user in another team. The existing duplicate check on `TEAM_MEMBERS` already covers active members; a terminated member in another team goes through the existing "restore" prompt, which then hits the `restoreMember` team check.
  - `resetTeamToDefault()`: `isSuperUser()` only.
  - The drag `drop` handler in `setupDragDrop`: keep the `canManageTeam()` check. Resolve by `data-member`, not `data-index`. Ignore the drop unless `canAdminMember` is true for both names. Do `from = TEAM_MEMBERS.indexOf(dragged)`, `to = TEAM_MEMBERS.indexOf(target)`, then splice.
  - Data methods `markAttendance`, `markLeave`, `removeLeave` already call `canEdit`; no change beyond step 1.
  - `addHoliday`, `removeHoliday`: already call `canManageHolidays`; the message text becomes 'Only the Superuser can manage holidays.' (or generic "You do not have permission to manage holidays.", to stay correct when the flag flips).
  - `syncExport`: filtered export (decision 6). Add `exportJSON(memberFilter)`; with a filter, copy `attendance` and `leaves` for those members only, keep `holidays`. Pass `getAdminScopeMembers()` for team admins and nothing for Super.
  - `syncImport` and `importJSON`: use `canImportData()` instead of `canUseReports()`. Keep the denial alert text "Only the Superuser can import data."
  - `setAdminRole`: change the confirm text to "Admins can edit attendance and manage members of their own team only."
  - The `toggleVisibility` change handler: `isSuperUser()` only. Revert the checkbox and `denyAction` otherwise.

  Files: `app.js`
  Verify: node test (step 8) covering direct calls on other-team members.

- [ ] 3. Scope the rendering paths (`app.js`).

  - `renderTeamManagement()`: iterate `getAdminScopeMembers()` instead of `TEAM_MEMBERS`. Use the member's name for `data-member` and drag. Keep `data-index` as a visual index only.
  - The terminated section: filter the `users` snapshot to `terminated === true` and `canAdminTeamId(user.teamId || MEMBER_TEAMS[key] || null)`. Super sees all. Admin without a team sees none.
  - Edit, reset-password and Remove buttons: render only when `canAdminMember(member)`. Hide Remove and Reset for the actor's own row (self) and for `SUPER_ADMIN`.
  - The empty-state text: for an Admin with no team, show "You are not assigned to a team yet. Ask the Superuser to assign you." instead of "No team members added yet."
  - Add-member form: for an Admin without a team, disable the Add button or show a notice. For Super, show the team select (decision 7).
  - `renderTeamList()`: show `teamTag` only when `isSuperUser()`; update the comment.
  - `generateDashboardReport()` and `generateEmailHTML()`: replace `TEAM_MEMBERS` with `const scope = getAdminScopeMembers()`. KPI counts, the average denominator (guard `scope.length === 0`) and the footer all use `scope.length`. Add the team name in the subtitle for team admins, built with `escapeHtml`.
  - `applyRoleVisibility()`: `show('adminSettings', isSuperUser(), 'block')`. The Holidays nav follows `canManageHolidays()` (already). Hide the sync Import control for non-Super if it is a separate element in `index.html`.
  - `updateUIPermissions()`: drop the now-unused `admin` var.
  - `renderHolidays()` is unchanged (already guarded by `canManageHolidays`).
  - `renderViewingInfo()`: the 'Admin Editing' label already follows `canEdit`; no change.

  Files: `app.js`, `index.html` (only if the import button or a Superuser-only team select for add-member needs markup; reuse existing classes from `styles.css`).
  Verify: `node --check app.js`, then the manual browser pass in step 9.

- [ ] 4. Audit for missed global reads.

  Grep `app.js` for `TEAM_MEMBERS` and `isAdmin()` one last time. Every remaining read must be one of:
  - load/save of the roster
  - the Super-only path
  - the login/register push of the user's own name
  - the `canAdminMember`-guarded helper

  Anything else gets scoped. Also check the `showEmailModal` path and its caller `generateEmailHTML` for the scoped list.

  Files: `app.js`
  Verify: `node --check app.js`; node test passes.

- [ ] 5. Make sure logout and login lifecycle still hold.

  No new module state is added except the `ADMIN_CAN_EDIT_HOLIDAYS` constant. Confirm that `lockApp()` still resets `TEAMS`, `MEMBER_TEAMS`, `MANAGERS` and the visibility toggle, and that nothing new caches scope (always compute from `getCurrentUser()` and the live maps). If any scoped list is cached in a variable, clear it in `lockApp()`.

  Files: `app.js` (only if a cache was introduced)
  Verify: manual: log in as Admin A, log out, log in as an unassigned user; nothing from Team A remains in the sidebar or calendar.

- [ ] 6. Update `REQUIREMENTS-teams-roles.md`.

  - Section 1: the roles and visibility lines (l.8, l.10) describe the pre-change state; add "(superseded by the 2026-11-12 team-admin change, see sections 3 and 4)".
  - Requirement 9: "Where Admin is allowed, Admin rules apply (global view...)" becomes "Admin rules apply within the user's own team".
  - Requirement 10: rewrite to "Admin is team-scoped: sees, edits and manages only members whose `teamId` equals the Admin's. Holidays, `everyoneSeesAll`, import and reset-roster are Superuser-only (see decisions). An Admin with no team sees only themselves."
  - Section 3 matrix: Admin and Admin+Manager columns:
    - view team data: "Yes (own team)"
    - edit others, password reset, add/remove/rename/restore, Manage Team, Monthly Report, Sync/export: "Yes (own team)"
    - Holidays: "No (flag-controlled, see open question)"
    - toggle, import, reset roster: "No"
    - Superuser column unchanged ("all")
  - Replace the toggle note: the toggle is Superuser-controlled and team-scoped for Employees and Managers.
  - Section 4: change decision (b) to "Admin is team-scoped (own team + self), not global. Reverses the earlier decision after user request on 2026-11-12." Add new decisions: holiday flag default, toggle Superuser-only, import Superuser-only, filtered export, add-member forced to own team, no team means self only, Super account protected.
  - Section 6: update helper descriptions and add `isTeamAdmin`, `getAdminScopeMembers`, `canAdminMember`, `canAdminTeamId`, `canImportData`, `ADMIN_CAN_EDIT_HOLIDAYS`.
  - Section 7: "every function checks the target member is in the actor's team". Note the limitation in the existing paragraph: data is one `appData` blob keyed by member name, so rules cannot enforce team-scoped read without restructuring (for example `attendanceByTeam/{teamId}/{member}`).
  - Section 9, open questions: (1) holidays flag default; (2) should Admins control the `everyoneSeesAll` toggle for their own team (would need a per-team setting); (3) Superuser team filter dropdown; (4) should Admins be able to edit Admin/Manager flags (still no); (5) restore of a terminated member with no team is Superuser-only.
  - Add a short "Changelog" or "Revision" note at the bottom: 2026-11-12, Admin changed from global to team-scoped.

  Files: `REQUIREMENTS-teams-roles.md`
  Verify: read-through; no remaining "Admin stays global", "global view" or "(All)" for Admin in the file (`Select-String`/grep is acceptable for this doc-consistency check only, not as code verification).

- [ ] 7. Update `DOCUMENTATION.md`, `README.md`, `DEPLOYMENT.md`.

  - `DOCUMENTATION.md`:
    - Features headings "(Admin only)" at l.55, 64, 70, 75: change wording to "Admin, own team" for Team Management and Reports. Holidays: "Superuser only by default (`ADMIN_CAN_EDIT_HOLIDAYS`)". Visibility Settings: "Superuser only".
    - User Roles (l.94-121): Admin section replaces "Global scope: not limited to a team" with team scope. Admin+Manager line says "within their own team".
    - Permission Matrix (l.130-146): same changes as the requirements matrix. Add a line: "An Admin with no team sees only themselves until the Superuser assigns one."
    - Sidebar and Team Name Display sections (l.337 and l.430-445): `All Teams` is shown for the Super Admin only; Admins see their own team name; the `[Team]` tag on each member is Super-only.
    - Teams & Roles manual test checklist (l.370-390): append items (1) Team A admin cannot see Team B members in sidebar, Summary, Manage Team, Monthly Report; (2) unassigned admin sees only self; (3) calling `app.editMember`/`removeMember`/`resetPasswordForMember`/`data.markAttendance` from the console on an other-team member is rejected with an alert and changes nothing; (4) Admin adding a member lands in own team; (5) Admin cannot open Holidays, toggle, or import; (6) Superuser still sees all teams.
    - Known limitations (l.420): add that team scoping is client-side only, `appData` is a single blob, and rules cannot enforce team-scoped reads without restructuring.
    - Changelog (l.463) under `### 2026-11-12`, add: `- **feat:** Admin visibility is team-scoped (own team only); holidays, visibility toggle and import are Superuser-only; Admin with no team sees only self`.
  - `README.md` Roles table (l.47-55): Admin row says own team only; Holidays and toggle noted as Super. Add one sentence below the table about unassigned Admins.
  - `DEPLOYMENT.md` (l.67-115): the rules snippet notes. State again that nothing is deployed. Where the snippet assumes Admins read all `appData`, add a note that Admin reads must be team-limited, which the current single-blob `appData` cannot express. Suggest the follow-up restructure. Update "Admin Responsibilities" (l.161) to "own team".

  Files: `DOCUMENTATION.md`, `README.md`, `DEPLOYMENT.md`
  Verify: read-through of the changed sections; every doc states Admin = own team and that rules are not deployed.

- [ ] 8. Extend the permission test `.agents/tasks/teams-roles-permission-test.js` (created in commit 88de19b; run with `node .agents/tasks/teams-roles-permission-test.js`, exit 0 means pass).

  The harness loads `app.js` into a `vm` context and drives it with `as(user, code)`. Changes:
  - **Fixture** (the `run(...)` seed): add `'Adm B'` (team tb, Admin), `'Adm U'` (no team, Admin) and `'Emp B2'` (tb) to `TEAM_MEMBERS`. Add `'Adm B'` and `'Adm U'` to `ADMIN_MEMBERS`, and `'Adm B': 'tb'`, `'Emp B2': 'tb'` to `MEMBER_TEAMS`.
  - **Rows**: add `'Adm B'`, `'Adm U'` to `users`. Add to `row()`: `adminOtherTeam` (`canAdminMember('Emp B1')`), `resetOther`, and `imp` (`canImportData()`).
  - **Fix existing assertions that encode the old behavior:**
    - 'Admin sees all' becomes: Adm A sees `['Adm A','Mgr A','Both A','Emp A']` (order follows `TEAM_MEMBERS`).
    - 'Both sees all' becomes the same list.
    - 'Admin+Manager edit others' keeps editOther as false (Emp B1 is in tb) and adds editTeammate true.
    - `'Admin can mark anyone'` (Adm A marks Emp B1) becomes 'Admin cannot mark other-team member' (not present, one alert) plus 'Admin can mark teammate' (Emp A).
  - **New cases:**
    - Adm A cannot see Emp B1, Mgr B or Adm B.
    - Adm B sees `['Adm B','Emp B1','Mgr B','Emp B2']` only.
    - Adm U (no team) sees `['Adm U']` and `canEdit('Emp A')` is false. No throw.
    - Super still sees all and `canEdit` is true for all.
    - Super's `getMyTeamLabel()` is 'All Teams'; Adm A's is 'A'; Adm U's is 'No team'. Logged-out is ''.
    - Direct calls on an other-team member by Adm A are rejected with an alert and no state change: `editMember('Emp B1')`, `removeMember('Emp B1')`, `resetPasswordForMember('Emp B1')` (stub `database` is absent in the harness, so assert the alert/early return), `restoreMember` of a tb member, `data.markAttendance/markLeave/removeLeave('Emp B1', ...)`, and a drag-style reorder helper if it was extracted.
    - `addMember('Zed')` as Adm U is refused. As Adm A it appends to `TEAM_MEMBERS` and sets `MEMBER_TEAMS['Zed'] === 'ta'` even if a team argument `'tb'` is passed. As Super, passing `'tb'` is honoured. This needs a minimal `database` stub in the harness (`ref().update/once`), or else assert the pure in-memory part by exposing nothing new and only checking `MEMBER_TEAMS` after the call with a stub that resolves empty.
    - SUPER_ADMIN protection: an Admin in the same team as 'Akshay Gurav' (set `MEMBER_TEAMS['Akshay Gurav']='ta'` for one case, then reset) cannot `canAdminMember('Akshay Gurav')`.
    - `isViewAllowed('holiday')`: false for Adm A while `ADMIN_CAN_EDIT_HOLIDAYS` is false, true after `run('ADMIN_CAN_EDIT_HOLIDAYS = true')`; reset it to false afterwards. Super is always true.
    - `canImportData()`: Super true, Adm A false. `importJSON` as Adm A is denied with an alert.
    - Toggle on (`toggle.checked = true`): Adm A still sees only team A plus self; Emp A sees team A only; Adm U sees only self.
    - Report scoping: if `generateDashboardReport` can run in the harness, assert the returned HTML for Adm A contains 'Mgr A' and does not contain 'Emp B1'. Otherwise skip it and cover it in the manual pass.
    - Empty-state no-crash: `TEAMS={}; MEMBER_TEAMS={}; MANAGERS=[]` then Adm A sees only self and `getAdminScopeMembers()` is `['Adm A']`.
  - Keep the existing Manager, Employee, superuser-only function and logged-out cases as they are; they should still pass.
  - The existing 'Non-admin cannot run admin-only app functions' loop uses `Mgr A`; leave it.

  Files: `.agents/tasks/teams-roles-permission-test.js`
  Verify: `node .agents/tasks/teams-roles-permission-test.js` prints `ALL PASSED` and exits 0. Also run `node --check app.js`.

- [ ] 9. Manual browser verification (no automated browser tests exist in this repo).

  Open `index.html` against the live Firebase config in a throwaway browser profile, or the same app with test users.
  - Super: create Team A and Team B, register or assign users to each, flag one user in each team as Admin.
  - Admin A: sidebar, Summary, Manage Team and Monthly Report list only Team A members. The heading shows 'Team Members - A' (not 'All Teams'). No `[Team]` tags. Holidays nav hidden, visibility toggle hidden, import absent, export contains only Team A members.
  - Admin A adds a member: it lands in Team A and appears right away. Sign in with Admin B and confirm it is invisible there.
  - Admin with no team: sees only self and gets the "ask the Superuser" notice. No console errors.
  - Console attempts as Admin A on a Team B member (`app.editMember`, `app.removeMember`, `app.resetPasswordForMember`, `app.data.markAttendance`) show a denial alert and change nothing.
  - Manager (no Admin): unchanged read-only team view, no Holidays or Manage Team.
  - Logout then login as a different user: nothing from the previous session is visible behind the login modal (605054d regression check).
  - Super: still sees all teams, all `[Team]` tags and 'All Teams'.

  Files: none
  Verify: all of the above observed; record results in the PR or commit message.

## Notes for the implementer

- Do not commit unless asked. Commit style so far: `fix:` / `feat:` / `docs:` prefixes.
- Don't delete or rewrite earlier plan, review or verification files in `.agents/tasks/`.
- Be honest in all docs: rules are NOT deployed, the database is open, there is no Firebase Auth, and all of this scoping is client-side. A user with the Firebase config can read everything, so this feature limits honest-use visibility only. Real enforcement needs Firebase Auth plus an `appData` restructure (per-team nodes).
