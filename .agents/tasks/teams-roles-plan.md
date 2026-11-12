# Implementation Plan: Teams and Roles

Requirements: `REQUIREMENTS-teams-roles.md` (repo root). Work on the current branch. Preserve commit 605054d (`lockApp`/`unlockApp`, listener cleanup). The app has no build step or test framework: verify by opening `index.html` in a browser (or `npx --yes http-server . -p 8080` and load http://localhost:8080) plus `node --check app.js` for syntax. No code is split across features; it is one file (`app.js`) edited sequentially, so no FEAT decomposition.

Decision: use helper functions plus module-level state (`TEAMS`, `MEMBER_TEAMS`, `MANAGERS`) following the existing `ADMIN_MEMBERS` pattern, synced by `_listen` in `AttendanceData.startListeners` and reset in `lockApp`. Rationale: matches existing code and keeps password-hash-bearing `users` out of the client after login.

- [ ] 1. Add permission state and helpers in app.js (near `isAdmin`, ~line 70-146).
      Add `TEAMS`, `MEMBER_TEAMS`, `MANAGERS`; `isSuperUser`, `isManager`, `getMyTeamId`, `getMemberTeamId`, `getVisibleMembers`, `canViewMember`, `canManageHolidays`, `canManageTeam`, `canManageTeams`, `canAssignRoles`. Rewrite `canEdit(member)` to: Admin or self. All helpers tolerate missing data (null team, empty lists).
      Files: app.js
      Verify: `node --check app.js` passes; in browser console after login, helpers return expected values for Superuser and an Employee.

- [ ] 2. Sync and reset the new state.
      In `startListeners` add `_listen` for `teams`, `memberTeams`, `managers` (updating state, localStorage not required, then `onDataLoaded`). In `lockApp` reset `TEAMS={}`, `MEMBER_TEAMS={}`, `MANAGERS=[]` and clear the team dropdown contents. Do not alter existing `lockApp` clearing logic.
      Files: app.js
      Verify: login then logout in browser; console shows state emptied; login page shows no names.

- [ ] 3. Team picker UI on login and register forms.
      Add `<select id="loginTeam">` and `<select id="registerTeam">` to the forms in index.html; add `loadTeamOptions()` in app.js (one `teams` `once('value')`, names only, built with `createElement`/`textContent`). Call when forms are shown and on init. `handleRegister` saves `teamId` to `users/{key}` and `memberTeams/{key}` (required when teams exist). `handleLogin` sets team only if the user has none. Clear selects in `lockApp`. Add minimal styles in styles.css reusing `.auth-input`.
      Files: index.html, app.js, styles.css
      Verify: with no teams, register still works; with a team created, register stores `teamId` (check Firebase console or `MEMBER_TEAMS`); login page shows team names only and no attendance data.

- [ ] 4. Superuser team and role administration.
      Add a "Teams" section in the Manage Team view (index.html + `renderTeamManagement`), visible only if `canManageTeams()`: create/rename/delete team (delete clears members' teamId), per-member team dropdown, "Manager" and "Admin" toggles. Implement `createTeam`, `renameTeam`, `deleteTeam`, `assignTeam`, `setManager`, `setAdminRole`, each starting with a `canManageTeams()`/`canAssignRoles()` guard and writing `users/{key}`, `memberTeams`, `managers`, `admins` consistently. Make `makeAdmin`/`removeAdmin` Superuser-only and route them through `setAdminRole`. Show role/team tags on member rows.
      Files: index.html, app.js, styles.css
      Verify: as Superuser create two teams, assign users, grant Manager/Admin/both; as Admin the controls are absent and direct calls to the functions alert and do nothing.

- [ ] 5. Apply scoping to views.
      `renderTeamList`, `renderSummary`, `onDataUpdate`, and the member-selection click handler use `getVisibleMembers()`/`canViewMember`; reject selecting hidden members. Make the `everyoneSeesAll` toggle team-scoped for non-Admins. `renderViewingInfo` and the calendar click handlers (~lines 2248, 2284) use `canEdit()` instead of inline `ADMIN_MEMBERS` checks; Manager viewing others shows "View Only".
      Files: app.js
      Verify: log in as Manager of team A: sidebar and Summary list only team A; team B members cannot be selected; calendar for others is view-only.

- [ ] 6. Enforce restrictions in code and in nav.
      Add guards to `markLeave`, `removeLeave`, `markAttendance` (via the selected member's `canEdit`), `addHoliday`, `removeHoliday`, `addMember`, `editMember`, `removeMember`, `restoreMember`, `resetTeamToDefault`, `resetPasswordForMember`, the reorder handler, and the report/sync modal openers. Update `updateUIPermissions` so Holidays, Manage Team, Sync, Report are shown by `canManageHolidays()`/`canManageTeam()`; Summary shown for Admin, Manager, or toggle. Make `showView` redirect to Calendar when a view is not permitted.
      Files: app.js
      Verify: as Manager, Holidays and Manage Team buttons are hidden and calling `app.data.addHoliday(...)` or switching view from the console is refused; as Admin+Manager everything an Admin can do works.

- [ ] 7. Lifecycle and regression pass.
      Call permission recomputation (`updateUIPermissions`, `renderTeamList`) in `handleLogin`, `handleRegister`, and init; confirm logout clears state. Check legacy data: user without `teamId`, empty `teams`, missing `managers` node must not throw. Confirm the 605054d behavior: after logout and reload the login screen shows no attendance.
      Files: app.js
      Verify: `node --check app.js`; in browser run the scenario matrix from REQUIREMENTS section 3 (Superuser, Admin, Manager, Admin+Manager, Employee, Unassigned) and confirm no console errors.

- [ ] 8. Update docs.
      README.md, DOCUMENTATION.md: new roles, team flow, permission matrix, troubleshooting rows. DEPLOYMENT.md: new Firebase nodes (`teams`, `memberTeams`, `managers`), the open-rules limitation, and the recommendation to adopt Firebase Auth + rules.
      Files: README.md, DOCUMENTATION.md, DEPLOYMENT.md
      Verify: docs render and match behavior verified in item 7.
