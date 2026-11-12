# Teams, Manager role and Superuser role assignment

Adds a `teams` model, a Manager flag independent of Admin, and Superuser-only controls for creating teams, assigning teams and granting Manager/Admin. Permissions are enforced inside the data and action functions, not only through hidden UI. A team picker is added to the register and login forms. The coder's verification evidence exists and covers the permission matrix with a Node harness (about 50 assertions). No builds or tests were re-run for this review. Watch for: all enforcement is client-side against an open Realtime Database (confirmed, documented as a known limitation); a Manager/Admin flag on a not-yet-registered name is inherited by whoever registers it first (confirmed, documented); renaming a member orphans team/manager mirrors (confirmed, documented).

**Verdict**: APPROVED

## High-level view

Roles are independent flags. `isAdmin()` keeps its old meaning, and `isManager()` only widens read scope to the manager's own team. Admin+Manager therefore resolves to Admin everywhere, which is the union the requirements ask for. `getVisibleMembers()` is the single read gate used by the member list, summary, calendar selection and click handlers.

Every edit, holiday, team-management, report and sync function now starts with its own permission check and alerts on denial. `switchView` also falls back to Calendar for views the user may not open. A Manager calling these from the console is refused.

Role, team and manager assignment is Superuser-only. Sign-up writes fixed fields: `isAdmin:false`, no `isManager`, and a team validated against the real `teams` node. Login can only fill an empty team. Permissions re-render on every listener update and are cleared in `lockApp()`.

The pre-login picker reads only `teams` and renders names with `textContent`. The login-page privacy fix (`lockApp`/`unlockApp`, `_listen` cleanup) is untouched, and the new listeners go through `_listen`.

<details>
<summary>Issues (4)</summary>

1. **Client-side-only enforcement** (confirmed, non-blocking, documented) — A user with the Firebase config can read the whole `appData` blob or write any path directly. Real enforcement needs Firebase Auth plus rules and a per-member data split, as DEPLOYMENT.md already says.
2. **Pre-registration role inheritance** (confirmed, non-blocking, documented) — A Manager or Admin flag on a name that has no password yet applies to whoever registers it. Register users before flagging them.
3. **Rename orphans mirrors** (confirmed, non-blocking, documented) — `editMember` does not migrate `memberTeams`, `managers` or `users`, so a renamed member shows as Unassigned. Migrate the keys or warn in the UI later.
4. **Superuser-name registration** (likely, pre-existing, out of scope) — If `SUPER_ADMIN` is not yet registered, anyone can register that name. The change does not alter this.

</details>

<details>
<summary>Details</summary>

### Manager read scope and the shared visibility gate

`getVisibleMembers()` returns all members for Admin and the Superuser. For others it returns self plus same-team members, but only when the user has a team and is a Manager or `everyoneSeesAll` is on. An unassigned user, or a Manager with no team, sees only themselves. Missing `TEAMS`, `MEMBER_TEAMS` or `MANAGERS` default to empty, so nothing throws.

`canViewSummary()` lets Manager and the toggle open Summary, and `renderSummary` iterates `getVisibleMembers()` only. The team list click handler and `ensureSelectedVisible()` reject hidden members. This covers the case where a stale selection survives a role or team change.

The limit is on the data side. `appData` is one blob that every client downloads, so a Manager could read other teams' attendance from the console or network. The UI scoping is real but is not a confidentiality boundary. DEPLOYMENT.md says this clearly and presents the rules snippet as "NOT deployed, NOT active", so the doc does not claim rules are in place.

### Edit, holiday and manage-team paths

Checks sit inside `markAttendance`, `markLeave`, `removeLeave` (via `canEdit`, which is true for Admin, otherwise self only), `addHoliday`, `removeHoliday`, `importJSON`, `restoreMember`, `showSyncModal`, `syncExport`, `syncImport`, `showEmailModal`, and the report generators. The drag-reorder drop handler is guarded as well. The existing `isAdmin()` guards in `addMember`, `editMember`, `removeMember`, `resetTeamToDefault` and `resetPasswordForMember` are kept. `renderHolidays` and `renderTeamManagement` return early when not permitted. The visibility toggle handler also checks `isAdmin()` and reverts the checkbox.

Calendar click and contextmenu handlers use `canViewMember` and `canEdit` in place of the duplicated `ADMIN_MEMBERS.indexOf` checks, which removes a drift risk. A Manager keeps own-data edit, as in requirement 8.

### Role and team assignment, and sign-up escalation

`setAdminRole`, `setManager`, `assignTeam`, `createTeam`, `renameTeam` and `deleteTeam` all check `canAssignRoles()` or `canManageTeams()`, which are Superuser-only. `makeAdmin` and `removeAdmin` route through `setAdminRole`, so an Admin who could grant admin before cannot now. This is the intended change in requirement 10.

`handleRegister` switched from `set()` to a multi-path `update()` with fixed fields. It never writes `isManager`, forces `isAdmin:false`, validates the team against the `teams` node, and keeps an existing Superuser-assigned `teamId`. `handleLogin` assigns a team only when neither `users/*/teamId` nor `memberTeams/*` has one, and excludes the Superuser. A user can therefore self-select a team once, at sign-up or first login. That matches requirements 2, 3 and (d). It is not an escalation to Manager, Admin or Superuser.

The Superuser check relies on `getCurrentUser()` from `localStorage`, so a console user can fake identity. That falls under the client-side-only limitation, not a new gap.

### Lifecycle and the login-page privacy fix

`lockApp()` resets `TEAMS`, `MEMBER_TEAMS` and `MANAGERS`, empties the new containers (`teamsAdminList`, `newTeamName`), calls `applyRoleVisibility()` to hide permission UI, and repopulates only the team-name picker. `loadTeamOptions()` re-checks `getCurrentUser()` after the async read, so a login in the meantime cannot get login-screen controls filled. New listeners use `_listen`, so `stopListeners` detaches them on logout. `unlockApp` and the listeners recompute visibility and selection, so a Superuser change applies live.

Team names are shown through `textContent` in the picker and `escapeHtml` elsewhere. The added escaping of member names in templates is a small hardening gain against stored markup.

### Test coverage

The harness exercises the role matrix, console-style denial for every sensitive function as Manager, denial of role/team functions for Admin and Admin+Manager, the team-scoped toggle, and empty or logged-out state. Not tested, and acknowledged by the coder: anything against real Firebase (picker population, the `update()` writes, live re-render, multi-tab logout) and any browser rendering or reload privacy check. This is a gap worth a manual smoke test before release but does not block.

</details>

<details>
<summary>File map</summary>

- app.js: permission helpers, guards, team and role functions, picker, lifecycle changes
- index.html: team admin block, login and register team selects
- styles.css: styles for the new controls
- DEPLOYMENT.md: data model plus a clearly labeled, undeployed rules design
- DOCUMENTATION.md, README.md: role descriptions
- REQUIREMENTS-teams-roles.md: requirements
- .agents/tasks/*: plan, verification, test harness

Full diff: `git -C c:/DEV/attendance-tracker-app diff 605054d..HEAD`

</details>
