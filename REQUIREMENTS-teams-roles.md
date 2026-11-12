# Requirements: Teams and Role-Based Access (Superuser / Admin / Manager)

Status: draft for review. Source: user request "convert into points, write down, start implementing".

## 1. Current state (from reading the code)

- Plain HTML/JS/CSS. Firebase **Realtime Database** (`database.ref(...)`), no Firebase Auth. Login is custom: SHA-256 password hash stored in `users/{name}` and compared in the browser.
- Roles today: **Superuser** (`SUPER_ADMIN = "Akshay Gurav"` constant in `app.js`) and **Admin** (names in `ADMIN_MEMBERS`, stored at `admins` and in `localStorage`). `isAdmin()` is true for both. Everyone else is an Employee.
- Data: `appData` (one blob: `attendance`, `leaves`, `holidays`, keyed by member name with `.` encoded as `___DOT___`), `teamMembers` (flat array of names), `admins` (array), `users/{key}` (name, username, passwordHash, isAdmin, terminated...), `settings/everyoneSeesAll` (boolean).
- Visibility today: Admin sees all. Employee sees only self unless `everyoneSeesAll` is on (then sees all, read-only). Employees edit only their own data (`canEdit`, plus inline checks near the calendar click handlers).
- Database rules (DEPLOYMENT.md): fully open read/write until 2026-08-21. **Consequence: all permission checks are client-side only.** Anyone with the config can read/write any path. See section 7.
- Prior login privacy fix (commit 605054d: `lockApp`/`unlockApp`, listener cleanup on logout, `auth-locked` body class) must be preserved.

## 2. Functional requirements

1. **Teams.** A team has an id, a name, and a creator. Only the Superuser can create, rename, and delete teams.
2. **Team selection at registration.** The register form shows a team dropdown (team names only). A new user picks a team during sign-up and is stored with that `teamId`.
3. **Team selection at login.** The login form shows the same dropdown, as a convenience for users who are still unassigned. Selecting a team there is allowed only if the user has no team yet (first assignment). A user who already has a team sees it applied and cannot switch it by login (see decision d).
4. **Pre-auth data exposure.** The pre-login screens read only `teams` and render only team names. They never read `users`, `appData`, or `teamMembers` for display. (The existing login code still reads `users` for credential lookup; that is unchanged and out of scope.)
5. **Role assignment.** Only the Superuser can grant or revoke the Manager flag and the Admin flag on any user. Both flags can be set independently, so a user can be Employee, Manager, Admin, or Admin+Manager.
6. **Team assignment.** Only the Superuser can change a user's team after registration. Users with no team are shown as "Unassigned" and the Superuser can assign them.
7. **Manager view.** A Manager sees the member list, calendar, and Summary for all members of their own team, read-only. They never see members of other teams or unassigned users (other than themselves).
8. **Manager restrictions.** A Manager (without Admin) cannot edit any other member's attendance or leaves, cannot see or open Holidays, cannot see or open Manage Team, and cannot add/remove/rename/restore/reset-password for members. A Manager can still view and edit their own attendance exactly like an Employee.
9. **Admin+Manager.** A user with both flags gets the union of capabilities. Where Admin is allowed, Admin rules apply (global view, edit all, holidays, manage team).
10. **Admin unchanged.** Admin behavior stays as it is today (global scope, edit anyone, Holidays, Manage Team, Monthly Report, Sync to Teams, password reset), with one exception: Admins can no longer grant/revoke Admin (Superuser only, per req 5).
11. **Superuser.** Distinct from Admin. Has all Admin capabilities plus create/manage teams, assign teams, assign roles. Superuser cannot lose Admin or be removed (existing guard stays).
12. **Enforcement in code.** Every edit, holiday, and manage-team function checks permission itself and returns early with an alert when denied. Hiding buttons is not sufficient.
13. **Session lifecycle.** Permissions (role flags, team, manager scope) are recomputed from stored data on every login/unlock and cleared in `lockApp()` on logout.
14. **Backward compatibility.** Existing users, admins, and data keep working with no migration step. Users without `teamId` are Unassigned. The app never throws when `teams`, `teamId`, or `isManager` are missing.

## 3. Role / permission matrix

Scope key: self = own record; team = members whose `teamId` equals the user's `teamId`; all = everyone.

| Capability | Superuser | Admin | Manager | Admin+Manager | Employee |
|---|---|---|---|---|---|
| Create / rename / delete teams | Yes | No | No | No | No |
| Assign teams to users | Yes | No | No | No | No |
| Assign Manager / Admin roles | Yes | No | No | No | No |
| View own data | Yes | Yes | Yes | Yes | Yes |
| View team data | Yes (all) | Yes (all) | Yes (own team) | Yes (all) | No (see toggle note) |
| View all data | Yes | Yes | No | Yes | No (see toggle note) |
| Edit own attendance | Yes | Yes | Yes | Yes | Yes |
| Edit others' attendance | Yes | Yes | No | Yes | No |
| Holidays (view/add/remove) | Yes | Yes | No | Yes | No |
| Manage Team (add/remove/rename/restore/reset password/reorder) | Yes | Yes | No | Yes | No |
| Summary view | Yes (all) | Yes (all) | Yes (own team) | Yes (all) | Only if toggle on (own team) |
| Monthly Report / Sync to Teams | Yes | Yes | No | Yes | No |

Toggle note: `everyoneSeesAll` currently shows all members to everyone. To honour "never other teams", the toggle becomes team-scoped for non-Admin users: when on, Employees and Managers see members of their own team (read-only). Unassigned users see only themselves.

## 4. Decisions

- (a) **Admin keeps existing behavior unchanged; Manager adds a team-scoped read-only view.** Only change to Admin is losing role assignment.
- (b) **Admin stays global**, not team-scoped.
- (c) **Existing users with no team are Unassigned.** Superuser can assign them. Unassigned users behave as Employees with no team view. Code treats missing `teamId` as `null`; no crash on any missing node.
- (d) **Only the Superuser can change a team after registration.** Login-time selection only fills an empty team.
- (e) **A Manager's view of their own data stays available** and own-data editing is unchanged.
- (f) Manager does not get Monthly Report / Sync to Teams (not requested; avoids scope creep). Open question 2.
- (g) Roles are stored as independent flags, not a single enum, so Admin+Manager needs no extra role.

## 5. Data model

New / changed nodes (all additive):

```
teams/{teamId}: { id, name, createdBy, createdAt }          // teamId = push id or slug
users/{sanitizedName}: { ...existing, teamId?: string, isManager?: boolean, isAdmin?: boolean }
memberTeams/{sanitizedName}: teamId                        // mirror of users.teamId, readable without loading users
managers: [ "Full Name", ... ]                             // mirror of isManager, same pattern as `admins`
```

- `users/{key}` is the canonical record for `teamId` / `isManager`. `memberTeams` and `managers` are mirrors written in the same helper so the client can sync them with listeners and never has to read `users` (which contains password hashes) after login. `admins` stays the source for Admin; `users.isAdmin` is kept in step when the Superuser toggles it.
- Superuser is identified by `SUPER_ADMIN` as today (and `users.isSuperAdmin`), distinct from the Admin list.
- `appData` and `teamMembers` are not restructured.

## 6. Permission helpers (in `app.js`)

`isSuperUser()`, `isAdmin()` (unchanged semantics: Super or in `ADMIN_MEMBERS`), `isManager()` (in `MANAGERS`), `getMyTeamId()`, `getMemberTeamId(name)`, `getVisibleMembers()` (Admin: all; Manager: same-team plus self; other: self, or own team if toggle on), `canViewMember(name)`, `canEdit(member)` (Admin: all; otherwise self only; Manager gets no extra edit rights), `canManageHolidays()` (= isAdmin), `canManageTeam()` (= isAdmin), `canManageTeams()` and `canAssignRoles()` (= isSuperUser). Module-level state (`MANAGERS`, `MEMBER_TEAMS`, `TEAMS`) is reset in `lockApp()` and rebuilt by listeners after `unlockApp()`.

## 7. Enforcement plan

- Add the permission check at the top of: `markLeave`, `removeLeave`, `markAttendance` (via the callers at the calendar click handlers, and also inside the data methods using the selected member), `addHoliday`, `removeHoliday`, `addMember`, `editMember`, `removeMember`, `restoreMember`, `resetTeamToDefault`, `resetPasswordForMember`, `makeAdmin`, `removeAdmin`, new team and role functions, drag-reorder handler, Monthly Report and Sync modals.
- Replace the duplicated inline `ADMIN_MEMBERS.indexOf(...)` checks (calendar click handlers, `renderViewingInfo`) with `canEdit(member)`.
- `showView('holiday'|'team')` refuses and falls back to Calendar when not permitted (blocks console or stale-DOM access).
- `renderTeamList`, `renderSummary`, calendar member selection, and `selectedMember` all go through `getVisibleMembers()`/`canViewMember`; selecting a hidden member is rejected.
- Permissions recomputed in `unlockApp()` and after the `admins`/`managers`/`memberTeams` listeners fire; cleared in `lockApp()`.
- **Known limitation:** the Realtime Database rules are open and there is no Firebase Auth, and `appData` is one blob downloaded in full by every client. Team scoping and role checks therefore protect against UI use and honest clients only, not against a user calling Firebase directly. Real enforcement needs Firebase Authentication plus rules, and splitting `appData` per team. Recommend as a follow-up; not part of this change.

## 8. Team picker on login / sign-up

Rules are open, so reading `teams` before authentication works. The picker does a one-time `once('value')` on `teams`, renders names only (via `textContent`/option text, escaped), and shows "No teams yet" with the selection optional when none exist. It runs when the register/login forms are shown, and its contents are cleared in `lockApp()`. If the rules are tightened later so `teams` is not publicly readable, fall back to choosing the team on first login after authentication; document this in DEPLOYMENT.md.

Register: team is required once at least one team exists. Login: dropdown shown, applied only when the user has no team.

## 9. Assumptions / open questions

1. Assumed team membership is one team per user.
2. Manager gets no Monthly Report or Sync to Teams. Confirm if a team-scoped report is wanted.
3. Manager can edit own attendance (treated as Employee for own data). Confirm.
4. Admin can no longer promote/demote admins (Superuser only), following "privileges assignable by Superuser only". Confirm.
5. Deleting a team leaves its members Unassigned (teamId cleared), never deletes users.
6. `everyoneSeesAll` becomes team-scoped for non-Admins, as explained in section 3. Confirm.
7. Security hardening (Firebase Auth + rules) is out of scope but flagged.
