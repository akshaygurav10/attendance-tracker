# Verification: Teams and Roles (iteration 1)

No `teams-roles-review.json` existed, so this was a from-scratch implementation.

## What I ran

| Check | Result |
|---|---|
| `node --check app.js` | exit 0 |
| `node --check firebase-config.js` | exit 0 |
| `node --check .agents/tasks/teams-roles-permission-test.js` | exit 0 |
| `node .agents/tasks/teams-roles-permission-test.js` (app.js loaded in a Node `vm` with stubbed `localStorage`/`document`/`alert`, no Firebase) | ALL PASSED (about 50 assertions) |

The harness checks, for Superuser, Admin, Manager (team A), Admin+Manager, Employee and Unassigned:
- `getVisibleMembers()`, `canEdit` (own, teammate, other team), `canManageHolidays`, `canManageTeam`, `canViewSummary`, `canManageTeams`, `canAssignRoles`, `canUseReports`.
- The `everyoneSeesAll` toggle is team-scoped for Employees; Unassigned users see only themselves.
- Console-style calls as a Manager are refused with an alert and change no data: `markAttendance`/`markLeave`/`removeLeave` on another member, `addHoliday`, `removeHoliday`, `addMember`, `removeMember`, `editMember`, `resetTeamToDefault`, `restoreMember`, `showSyncModal`, `syncExport`, `syncImport`, `showEmailModal`, and `isViewAllowed('holiday'|'team')`.
- As Admin and as Admin+Manager, `createTeam`, `renameTeam`, `deleteTeam`, `assignTeam`, `setManager`, `setAdminRole`, `makeAdmin`, `removeAdmin` are refused.
- Manager can mark own attendance; Admin can mark anyone's.
- Empty `TEAMS`/`MEMBER_TEAMS`/`MANAGERS` and logged-out state do not throw.

## Permission matrix trace (REQUIREMENTS section 3)

| Row | Where enforced |
|---|---|
| Create/rename/delete teams (Superuser only) | `createTeam`/`renameTeam`/`deleteTeam` start with `canManageTeams()` (= `isSuperUser()`); UI block `#teamsAdmin` shown only via `applyRoleVisibility` |
| Assign teams / Manager / Admin (Superuser only) | `assignTeam`, `setManager`, `setAdminRole` (`makeAdmin`/`removeAdmin` route to it) check `canAssignRoles()`; per-member controls render only for the Superuser |
| View own data | `getVisibleMembers()` always includes self |
| View team data | Admin: all; Manager: same `teamId` + self; others: self (+ own team when toggle on) |
| Edit own attendance | `canEdit(member)` true for self; checked inside `markAttendance`/`markLeave`/`removeLeave` |
| Edit others' attendance | `canEdit` true only for `isAdmin()`; calendar click and contextmenu handlers also require `canViewMember` + `canEdit` |
| Holidays | `addHoliday`/`removeHoliday`/`renderHolidays` check `canManageHolidays()`; nav hidden; `switchView` falls back to calendar |
| Manage Team | `addMember`, `editMember`, `removeMember`, `restoreMember`, `resetTeamToDefault`, `resetPasswordForMember`, drag-reorder drop, `renderTeamManagement` all check admin; nav hidden; `switchView` guard |
| Summary | `renderSummary` returns unless `canViewSummary()`; lists `getVisibleMembers()` only |
| Monthly Report / Sync | `showEmailModal`, `generateDashboardReport`, `generateEmailHTML`, `showSyncModal`, `syncExport`, `syncImport`, `importJSON` check `canUseReports()` (= admin); buttons hidden; `checkEmailReminder` skips non-admins |
| Admin+Manager | `isAdmin()` wins for scope/edit/holidays/manage; Manager flag adds nothing extra |

## Privilege escalation and lifecycle

- `handleRegister` writes fixed fields only (`isAdmin:false`; `isManager` is never written; team comes from the dropdown, validated against the real `teams` node). An existing Superuser-assigned `teamId` is kept, not overwritten. It uses `update()` instead of the old `set()` so Superuser-set flags on a pre-flagged record survive registration.
- `handleLogin` can only set a team when the user has none in `users/*/teamId` and `memberTeams/*`. The Superuser is excluded. No other client code writes `teamId`, `isManager` or `isAdmin` except the Superuser-guarded functions.
- Login-privacy fix (605054d) preserved: `lockApp`/`unlockApp`, `auth-locked`, `_listen`/`stopListeners` untouched. New listeners (`teams`, `memberTeams`, `managers`) go through `_listen`, so logout detaches them. `lockApp` resets `TEAMS`, `MEMBER_TEAMS`, `MANAGERS`, clears the new containers/inputs/selects, then reloads team names only for the picker.
- Permissions are recomputed on each login (listeners re-fire, `applyRoleVisibility`, `ensureViewAllowed`, `ensureSelectedVisible`) and on every data update, so role changes made by the Superuser apply live.
- Pre-auth screens read only `teams` and render names via `textContent`. If that read fails (tightened rules) the pickers stay empty.
- Added `escapeHtml` for team names, member names in the team list, summary, team management and viewing info (names are user-entered).

## Behavior changes to be aware of (all per requirements)

- Admins (non-Super) can no longer grant/revoke Admin (requirement 10).
- `everyoneSeesAll` is now team-scoped for non-Admins.
- Monthly-report reminder popup and report/sync are admin-only (they previously opened for any user on the 20th/last day).

## What could NOT be tested

- Anything against a real Firebase database: no credentials. Not exercised: team picker population, registration/login writes (`update()` multi-path), `teams`/`memberTeams`/`managers` listeners, live re-render after the Superuser changes a role, multi-tab logout.
- No browser run: DOM rendering, CSS appearance of the new controls, and the login-screen privacy check after logout/reload were reviewed in code only.
- Rules: the snippet in DEPLOYMENT.md is a design target, not deployed or tested. It needs Firebase Auth custom claims and a per-member `appData` split.

## Known limitations

- Client-side checks only. Anyone with the config can read/write Firebase directly; `appData` is one blob every client downloads.
- Roles are keyed by display name: a Manager flag set on a name that has not registered yet applies to whoever registers that name.
- `editMember` (rename) does not migrate `memberTeams`/`managers`/`users` keys (it did not migrate `users` or `admins` before either); a renamed member shows as Unassigned until the Superuser re-assigns.
