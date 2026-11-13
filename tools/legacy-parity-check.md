# Legacy parity check (static)

Goal (design 4.0, 13): with `SECURITY_MODE = "legacy"` the app behaves like commit `a7001f7`.

Command: `git diff a7001f7 HEAD -- app.js firebase-config.js index.html`
(result: 3 files, 87 insertions, 4 deletions).

## app.js

Every added line is one of:

- the `MODE` constant (top of file);
- an early `if (MODE === 'secure') ...` guard at the top of, or right after the existing
  permission check in: `saveTeamMembers`, `saveAdminList`, `getCurrentUser`, `isAdmin`,
  `isSuperUser`, `isManager`, `getMemberTeamId`, `canSelfAssignTeam`, `canManageHolidays`,
  `AttendanceData.loadLocal/startListeners/save/saveToFirebase/markAttendance/markLeave/
  removeLeave/addHoliday/removeHoliday/importJSON`, `App.init/unlockApp/lockApp/
  loadTeamOptions/handleLogin/handleRegister/resetPasswordForMember/updateUserDisplay/
  updateUIPermissions/changeOwnPassword/reorderMembers/resetTeamToDefault/setAdminRole/
  setManager/createTeam/renameTeam/deleteTeam/assignTeam/addMember/editMember/
  removeMember/restoreMember`;
- comments.

The 3 removed lines are rewritten with identical legacy behaviour:

| Removed | Replacement in legacy mode |
|---|---|
| one-line `canManageHolidays()` | same expression on the legacy branch |
| reset-password button template | condition gains `(MODE !== 'secure' \|\| ...)` (true in legacy); title is `'Reset password'` in legacy |
| `if (currentUserIsAdmin && typeof database !== 'undefined')` before the `users` read | became `else if (...)` after a secure-only branch; same condition in legacy |

## firebase-config.js

Adds `const SECURITY_MODE = "legacy";`, creates `firebaseAuth` only when the mode is exactly
`"secure"` (so `null` in legacy), and wraps the unchanged `connectionTest` write in a
condition that is true in legacy. The `.info/connected` listener is unchanged.

## index.html

Adds `firebase-auth-compat.js` 9.23.0 and four local scripts that only define globals
(`AuthHelpers`, `DataPaths`, `SecureFlows`, `SecureMode`).

## Executed check

`tools/tests/legacy-mode.test.js` loads the real `firebase-config.js`, the four modules and
`app.js` into a Node `vm` context with a stubbed `firebase` global and asserts: `MODE` is
`legacy`, `firebase.auth()` is never called, `connectionTest` is still written,
`.info/connected` is still listened to, the current user still comes from localStorage,
role checks still use the legacy arrays, and an old cached config without the flag (or a
typo such as `"Secure"`) also runs legacy. PASS.

## Not verified

A real browser comparison of the network panel and console against `a7001f7` was not run.
In particular, whether loading `firebase-auth-compat.js` makes the database SDK create an
internal Auth instance (design 4.0 says "expected harmless, unverified") is unknown. This
is a manual check for the user (design 13, "Legacy parity").
