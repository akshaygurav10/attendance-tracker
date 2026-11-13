# Attendance Tracker - Complete Documentation

## Overview

A real-time team attendance tracking application with a Jira-style dark/light UI. Built with vanilla HTML, CSS, and JavaScript, powered by Firebase Realtime Database for cloud sync across all team members.

**Live URL:** Your GitHub Pages URL  
**Repository:** `https://code.saba.com/users/agurav/repos/attendance-tracker/`

---

## Features

### Core Features
- **Monthly Calendar View** — Click days to mark attendance for each team member
- **Real-time sync** — All team members see the same data instantly via Firebase
- **Auto-excludes weekends** (Saturday & Sunday) from working day calculations
- **60% Attendance Threshold** — Visual indicators (green/orange/red) for compliance
- **Summary Dashboard** — View all team members' attendance at a glance with sortable columns
- **Dark/Light Theme** — Toggle between themes, preference saved per user
- **Future Planning** — Plan attendance for next 2 months (Planning to Come, Leave, Exception)

### Authentication & Security
- **Username-based login** — Users type their username (e.g., `agurav`) or full name to login
- **SHA-256 encrypted passwords** — Passwords hashed before storing in Firebase
- **Remember Me** — Save credentials in browser localStorage
- **Change Password** — Users can change their own password (requires old password)
- **Admin password reset** — Admin resets any user's password to default `Temp@123`
- **Role-based access** — Admin vs regular user permissions
- **Super Admin** — Akshay Gurav (cannot be removed as admin)
- **Locked while logged out** — The app content is hidden behind the login screen; no previous user's attendance is visible (see *Login Privacy* below)
- **Teams** — Super Admin creates teams; users pick one at sign-up; Managers see only their own team (see *Teams & Roles*)

### Attendance Types

| Type | Icon | Color | Effect |
|------|------|-------|--------|
| ✅ Present | Green | Counted as attended |
| 📋 Planning to Come | Blue | Counted as attended (future months) |
| 🏠 Work From Home | Cyan | Day excluded from working days |
| 📧 WFH Email | Pink | Day excluded from total days (like weekend) |
| 🚫 Leave | Purple | Day excluded from working days |
| ⚡ Exception | Yellow | Day excluded from working days |
| 🏖️ Holiday | Blue | Auto-excluded, set by admin |
| 🔒 Weekend | Gray | Auto-excluded (Sat/Sun) |

### Stat Tiles (Calendar View)
- **Working Days** — Total days minus weekends, holidays, leaves, exceptions, WFH, WFH Email
- **Days Attended** — Present + Planning to Come days
- **Need to Attend** — Required minus Days Attended (shows 0 when 60% met)
- **Required (60%)** — Minimum days needed
- **Attendance %** — (Days Attended / Working Days) × 100
- **Motivation Message** — Random WFH motivation message when 60% is completed

### Team Management (Admin, own team)
- **Add members** — Type name and click "Add Member". An Admin's new member is always created in the Admin's own team (an Admin with no team cannot add members). The Super Admin can pick a team in a dropdown next to the name box.
- **Scope** — An Admin sees and manages only members of their own team; the Super Admin sees all
- **Remove members** — Soft-delete (marked as terminated, can be restored)
- **Edit names** — Click ✏️ to rename (data transfers to new name)
- **Drag to reorder** — Drag the ☰ handle to rearrange member order
- **Restore terminated** — Admin can restore deleted members with password reset
- **Admin / Manager / Team roles** — only the Super admin can promote/demote admins, set Managers and assign teams
- **Reset password** — Admin clicks 🔑 → password resets to `Temp@123`

### Reports (Admin, own team)
- **Monthly Dashboard Report** — Visual report with KPI cards, progress bars, status badges
- **Copy to Clipboard** — Copies rich HTML, paste directly into Outlook/Teams
- **Send Email** — Opens .eml file with dashboard in Outlook
- **Sortable columns** — Click column headers to sort by Name, Days Attended, %, Status

### Holidays (Super Admin only by default)
- Controlled by `ADMIN_CAN_EDIT_HOLIDAYS` in `app.js` (default `false`). Holidays are one global list shared by all teams. Admins still see holidays on the calendar. Open question for the user: should team Admins edit holidays? See `REQUIREMENTS-teams-roles.md`.
- **Pre-loaded** — Indian 2026 holidays included
- **Add/Remove** — Manage holidays from the Holidays view
- **Current month highlight** — This month's holidays shown with cyan badge

### Visibility Settings (Super Admin only)
- **"Everyone sees everyone's data" toggle** — In Manage Team
- **Enabled** — All users see all team members, summary visible
- **Disabled** — Users only see their own calendar, summary hidden

### Future Planning (Next 2 Months)
- Navigate to future months using ◀▶ arrows
- Click any future day → planning menu appears:
  - 📋 **Planning to Come** — counts as attended in calculations
  - 🚫 **Leave** — excluded from working days
  - ⚡ **Exception** — excluded from working days
  - ❌ **Clear** — remove planning
- Days beyond 2 months remain non-clickable
- Current month days show regular options (Present, Leave, WFH, etc.)

---

## User Roles

### Super Admin (Akshay Gurav)
- Cannot be removed as admin
- Can edit everyone's attendance (all teams)
- Can add/remove/edit team members
- Only role that can create, rename and delete **teams** (Manage Team → Teams)
- Only role that can assign a user's team after registration and grant/revoke **Manager** and **Admin**
- Can reset passwords (to `Temp@123`)
- Can manage holidays
- Can toggle visibility settings
- Can generate reports & sync data
- Sees all team members always

### Admin (Promoted by Super Admin)
- Sees and edits attendance of **members of their own team only** (plus themselves); cannot see other teams
- Can add/remove/edit/restore team members and reset passwords, for their own team only; new members are created in their own team
- Can use Monthly Report and export for their own team only
- Cannot manage holidays (unless `ADMIN_CAN_EDIT_HOLIDAYS` is switched on), change the visibility toggle, import data or reset the roster (Super Admin only)
- Cannot grant or remove Admin/Manager roles or change teams (Super Admin only), and cannot edit or remove the Super Admin
- An Admin with no team sees only themselves until the Super Admin assigns one

### Manager (assigned by Super Admin)
- Sees the attendance and Summary of **all members of their own team**, read-only
- Cannot see other teams' members or unassigned users
- Cannot edit other members' attendance, and has no Holidays, Manage Team, Sync or Monthly Report
- Edits their own attendance like a regular user
- A user can be **Admin + Manager**: they get everything an Admin can do, within their own team only

### Teams
- Super Admin creates teams. New users pick a team on the Register form (required once teams exist); the login form only fills a team for users who have none yet
- The team picker lists team names only; no attendance or user data is loaded before login
- Existing users with no team are "Unassigned" (they see only themselves) until the Super Admin assigns one
- Deleting a team makes its members Unassigned; no users or attendance are deleted
- When "Everyone sees everyone's data" is on, non-admins see only their own team. Only the Super Admin can change this toggle

> In legacy mode (the current default) permission checks run in the browser only and do not stop someone calling Firebase directly. Secure mode moves enforcement to Firebase Auth and database rules; see *Secure mode* below and the runbook in FUTURE-ENHANCEMENTS.md.

### Permission Matrix

| Capability | Super Admin | Admin | Manager | Admin + Manager | Employee |
|---|---|---|---|---|---|
| Create / rename / delete teams | Yes | No | No | No | No |
| Assign teams, grant Manager / Admin | Yes | No | No | No | No |
| View own data | Yes | Yes | Yes | Yes | Yes |
| View other members | All | Own team | Own team | Own team | Own team only if "Everyone sees everyone's data" is on, else none |
| Edit own attendance | Yes | Yes | Yes | Yes | Yes |
| Edit others' attendance | Yes | Own team | No | Own team | No |
| Holidays | Yes | No (flag `ADMIN_CAN_EDIT_HOLIDAYS`) | No | No (flag) | No |
| Manage Team (add/remove/rename/restore/reset password/reorder) | Yes | Own team | No | Own team | No |
| Summary | All | Own team | Own team | Own team | Own team, only if toggle on |
| Monthly Report / Sync export | Yes (all) | Own team | No | Own team | No |
| Import data, reset roster, visibility toggle | Yes | No | No | No | No |

Unassigned users (no team) see only themselves, whatever their flags, including Admins. Only the Super Admin sees all teams.

### Regular User
- Can only edit their own attendance
- Can plan future attendance (next 2 months)
- Can change their own password
- Can see others' data only if visibility is enabled by admin
- Cannot see: Holidays, Manage Team, Sync, Monthly Report, Summary (when visibility disabled)

---

## How to Use

### First Time Setup
1. The Superuser already exists in the data (see "Who is the Superuser" below). Typing a name at the login screen never creates or promotes anyone. An unknown name is rejected.
2. The Superuser logs in with their existing username or full name and password
3. Other team members click "Register here" → enter full name + password
4. Username is auto-generated (e.g., "Krutik Arekar" → `karekar`)

#### Who is the Superuser
- **Secure mode:** the one profile (`usersV2/{uid}`) with `isSuperAdmin: true`. Only the Admin SDK can set it (the migration script or `migrate.js set-superuser`). No browser, including the Superuser's own, can write it.
- **Migration:** the Superuser is named by `--superuser "<name>"` or by the single legacy `users/*` record with `isSuperAdmin === true`. If both are given they must match. The client no longer contains a Superuser name.
- **Legacy mode:** the single `users/*` record with `isSuperAdmin === true`. That user keeps logging in with the existing password. On a fresh legacy database with no such record nobody is the Superuser until you set `isSuperAdmin` to `true` on one `users/<name>` node by hand in the Firebase console (a manual step).
- Legacy mode stays insecure regardless: its checks run only in the browser (see the FAQ below).

#### Who can do what (secure mode, enforced by the database rules)
| Actor | Ordinary member of own team | Admin / Manager / Superuser of own team | Other team |
|---|---|---|---|
| Employee | own attendance and leaves | none | none |
| Manager | read own team; write only own attendance and leaves | read only | none |
| Team Admin | manage (mark, rename, terminate, restore, reset, reorder, remove) | **cannot** change Admins, Managers or the Superuser; can still read them | none |
| Superuser | everything, all teams | everything except self-removal | everything |

The Superuser cannot terminate, demote, rename or delete their own profile or roster entry. The full actor x target x action matrix is in `DESIGN-server-side-isolation.md`.

#### FAQ: Can someone override this from dev tools?
In secure mode, no, not the part that matters. Anyone can open dev tools, edit the page code, change `localStorage` or set variables in their own browser. That only changes what their own screen shows. Every read and write still goes to Firebase, and the database rules decide, using the signed-in Firebase Auth uid on the server. A tampered browser sending a forbidden write gets `PERMISSION_DENIED`. The app code and the Firebase web config are public by design; they are not secrets and hiding them would not help. In legacy mode the answer is yes: all checks run in the browser and the database is open to anyone with the config. Minifying or obfuscating the code is not a security measure (see `DEPLOYMENT.md`).

### Login
1. Enter your username (e.g., `agurav`) or full name
2. Enter password
3. Check "Remember me" to save credentials
4. Click Login

### Marking Attendance (Current Month)
- **Left-click** a day → toggles Present ✅
- **Right-click** a day → shows full menu (Present, Leave, WFH, WFH Email, Exception, Clear)

### Planning Attendance (Future Months)
- Navigate to next/next-next month using ▶ arrow
- **Click** any day → planning menu (Planning to Come, Leave, Exception, Clear)
- "Planning to Come" counts toward your 60% target

### Switching Users / Logout
- Click **⇄ Logout** in the top-right
- Login screen appears for a different user
- Logout also clears the saved "Remember me" credentials on that browser

### Changing Password
- Click **🔑 Password** in the top-right
- Enter old password → enter new password → confirm

### Forgot Password
- Contact admin → admin resets to `Temp@123`
- Login with `Temp@123` → prompted to set new password
- Set your own password

---

## Technical Architecture

### Files
```
attendance-tracker-app/
├── index.html          — Main HTML page
├── app.js              — Application logic
├── styles.css          — Dark/Light theme styles
├── firebase-config.js  — Firebase initialization
├── README.md           — Quick overview
├── DEPLOYMENT.md       — Deployment instructions
├── REQUIREMENTS-teams-roles.md — Teams & roles requirements
└── DOCUMENTATION.md    — This file
```

### Data Storage

**Primary:** Firebase Realtime Database  
**Backup:** Browser localStorage

### Firebase Database Structure
```json
{
  "appData": {
    "attendance": {
      "Member Name": { "2026-07-21": true }
    },
    "holidays": [
      { "date": "2026-01-26", "name": "Republic Day" }
    ],
    "leaves": {
      "Member Name": {
        "2026-07-23": "leave",
        "2026-07-24": "wfh",
        "2026-07-25": "exception",
        "2026-07-28": "wfh-email",
        "2026-08-05": "planned"
      }
    }
  },
  "teamMembers": ["Akshay Gurav", "Krutik Arekar"],
  "admins": ["Akshay Gurav"],
  "managers": ["Krutik Arekar"],
  "teams": { "-Nabc123": { "id": "-Nabc123", "name": "Platform", "createdBy": "Akshay Gurav", "createdAt": "2026-08-01T09:00:00Z" } },
  "memberTeams": { "Krutik Arekar": "-Nabc123" },
  "users": {
    "Akshay Gurav": {
      "name": "Akshay Gurav",
      "username": "agurav",
      "passwordHash": "sha256...",
      "isAdmin": true,
      "isSuperAdmin": true,
      "teamId": "-Nabc123",
      "isManager": false,
      "terminated": false,
      "registeredAt": "2026-07-22T10:00:00Z"
    }
  },
  "settings": {
    "everyoneSeesAll": true
  },
  "connectionTest": { "timestamp": 123, "status": "connected" }
}
```

Data model notes (all additive, no migration needed):
- `teams/{teamId}` — team record (id, name, createdBy, createdAt)
- `users/{name}.teamId` and `.isManager` — canonical team and Manager flag; optional, missing means no team / not a Manager
- `memberTeams` and `managers` — mirrors of the above, so the client never has to read `users` (which holds password hashes) after login
- `admins` remains the source for Admin
- Existing users with no `teamId` are shown as "Unassigned"; the app does not throw when these nodes are missing

### Attendance Calculation
```
Effective Working Days = Total Days - Weekends - Holidays - Leaves - Exceptions - WFH - WFH Email

Days Attended = Present days + "Planning to Come" days

Attendance % = (Days Attended / Effective Working Days) × 100

Need to Attend = Required (60% of Working Days) - Days Attended
```

### Username Generation
- Format: first initial (lowercase) + full last name (lowercase)
- "Akshay Gurav" → `agurav`
- "Krutik Arekar" → `karekar`
- "Humera J." → `hj`
- Duplicates: try 2-char prefix (`akjadhav`), then append random number

### Password Security
- Passwords hashed with SHA-256 (browser `crypto.subtle` API)
- Plain text never stored
- Default reset password: `Temp@123`
- Minimum 4 characters

---

## Firebase Setup

### Configuration
Firebase config is stored in `firebase-config.js`. See that file for the full configuration object. These keys are safe in client-side code — access is restricted by Firebase database rules, not API keys.

### Database Rules
The rules deployed on the live project are not recorded here and must be checked in the Firebase console. The rule set for secure mode is `database.rules.json` (built from `rules/database.rules.src.json`, tested on the emulator, see `rules/RESULTS.md`). It is deployed only during the cutover runbook in `FUTURE-ENHANCEMENTS.md`; see *Secure mode* below and `DEPLOYMENT.md`.

## Secure mode (server-side team isolation)

`firebase-config.js` has `const SECURITY_MODE = "legacy";`. Legacy mode is the app as described above. Setting exactly `"secure"` (after the migration and the rules deploy) switches to:

- **Login with Firebase Auth** (Email/Password). The account email is `username@attendance.local`; users still type their username or full name. Remember me keeps the session; no password is stored in the browser. Minimum password length 6.
- **Registration in four steps**: create the Auth account, claim the name (`memberOwners/{memberKey}`), create the profile (`usersV2/{uid}`, never with Admin/Manager/Superuser flags), then the roster entry. Any failure rolls back.
- **Per-team data**: `teamData/{teamId}/members|attendance|leaves/{memberKey}` (`unassigned` for users without a team), `holidays/{date}`, `teamNames/{teamId}` (the only node readable before login), `passwordResetRequests/{uid}`.
- **The server enforces access** (`database.rules.json`): an Admin or Manager can read only their own team; an Employee reads only their own data unless the Superuser turns on "everyone sees everyone" (own team only); unassigned users see only themselves; terminated users see nothing; nobody can give themselves a role; only the Superuser writes teams, roles and settings. Editing localStorage or JavaScript in dev tools no longer changes what Firebase allows.
- **Password resets** go through the Superuser: the Admin button writes a request, and the Superuser runs `node tools/migrate-to-secure/migrate.js reset-password --pending` locally (free Admin SDK, no server).
- Holidays editing by Admins follows `settings/adminCanEditHolidays` (absent means Superuser only).

Code layout: `app.js` uses only the `MODE` constant and calls into `secure-mode.js` behind `MODE === 'secure'` guards, so legacy mode runs the original code. `auth-helpers.js`, `data-paths.js` and `secure-flows.js` are pure modules with unit tests in `tools/tests`. The migration tool is in `tools/migrate-to-secure` (README there).

Permission matrix enforced by the rules (design section 6):

| Action | Superuser | Admin (own team) | Manager (own team) | Employee | Unassigned | Not signed in |
|---|---|---|---|---|---|---|
| Read team names | yes | yes | yes | yes | yes | yes |
| Read teams, holidays, settings | yes | yes | yes | yes | yes | no |
| Read own data | yes | yes | yes | yes | yes | no |
| Read team data | all teams | own team | own team | own team only if the toggle is on | no | no |
| Write own attendance/leaves | yes | yes | yes | yes | yes | no |
| Write others' attendance/leaves | all | own team | no | no | no | no |
| Roster add/remove/rename/reorder | all | own team | no | no | no | no |
| Terminate / restore | all | own team, not the Superuser, not self | no | no | no | no |
| Set roles, move members, teams, settings | yes | no | no | no | no | no |
| Holidays | yes | only if `adminCanEditHolidays` | no | no | no | no |
| Request password reset | yes | own team | no | no | no | no |
| First team pick at login | n/a | no | no (waits for the Superuser) | n/a | yes | no |
| Legacy nodes (`appData`, `users`, ...) | no | no | no | no | no | no |

Known differences from legacy mode are listed in `FUTURE-ENHANCEMENTS.md` ("What users will notice after cutover").

---

## Deployment

### GitHub Pages
1. Push code to GitHub repository
2. Settings → Pages → Deploy from branch (main, root)
3. App is live at `https://username.github.io/repo-name/`

### Microsoft Teams Integration
1. Teams → Channel → "+" tab → Website
2. Paste GitHub Pages URL
3. Save

---

## UI Layout

### Top Navigation Bar
```
[Logo] Attendance Tracker 🟢Synced  |  [agurav 👑 (Platform) | 🔑 Password | ⇄ Logout]  [☀️Light] [🔄Sync] [📧Report]
```
- Team name shown in brackets after the username: own team, `All Teams` for the Super Admin only, own team name for everyone else, `No team` if unassigned
- Sync indicator: 🟢 Synced / 🔴 Offline
- Password, Logout, Sync, Report buttons
- Sync & Report hidden for non-admin

### Sidebar
- Team Members list (logged-in user on top with "(You)" tag). The heading shows the viewer's team, e.g. `Team Members - Platform`, `Team Members - All Teams` (Super Admin only) or `Team Members - No team`. Only the Super Admin sees a `[Team]` tag on each member.
- Views: Calendar, Summary (visibility-dependent), Holidays (Super Admin by default), Manage Team (Admin, own team)
- Legend: Present, WFH, WFH Email, Leave, Exception, Weekend, Holiday, Today

### Calendar View
- Month navigation (centered): ◀ July 2026 ▶
- Viewing info (right): "📝 Editing: Name" or "👁️ View Only"
- Stat tiles (centered): Working Days, Days Attended, Need to Attend, Required, Attendance %
- Motivation message (when 60% met)
- Calendar grid (centered)

---

## Login Privacy (2026-11-12, commit 605054d)

**Problem:** the previous user's attendance was visible behind the login modal.

**Now:**
- `lockApp()` runs whenever nobody is signed in (page load without a session, logout, stale session). It adds the `auth-locked` body class, so only the login view shows. `unlockApp()` removes it after a successful login.
- Logout clears: rendered containers (team list, calendar, stats, summary, holidays, reports, header user info), in-memory state (`TEAM_MEMBERS`, `ADMIN_MEMBERS`, selected member, view, sort), open modals and the day context menu, and the login form is reset.
- Realtime Firebase listeners are detached on logout (`stopListeners`) and the data layer is reset; listeners are re-created on login.
- localStorage keys removed: `attendance_current_user`, `attendance_tracker_data`, `attendance_team_members`, `attendance_admin_list`, `attendance_remembered_user`, `attendance_remembered_pass`. `sessionStorage` is cleared. Theme and `reminder_*` flags are kept.
- Async results that return after logout (or for a different user) are ignored via `getCurrentUser()` checks.

**How to test manually**
1. Log in as user A, open Calendar and Summary, then Logout. The login screen must show no calendar, member list or stats behind it.
2. Reload the page while logged out. Still nothing visible behind the login screen.
3. In DevTools → Application → Local Storage, confirm the keys above are gone after logout.
4. Log in as user B. No data from user A appears at any point.
5. Logout during a slow connection, then check no data renders after the login screen appears.

---

## Teams & Roles (2026-11-12, commit 88de19b)

Summary of behavior is in *User Roles* and the *Permission Matrix* above; requirements are in `REQUIREMENTS-teams-roles.md`.

- Super Admin only: create/rename/delete teams, assign a team after sign-up, grant/revoke Manager and Admin (Admins can no longer promote/demote admins).
- Sign-up: team dropdown (names only, read from `teams` before login). Required once any team exists. New accounts always start with `isAdmin: false` and no Manager flag.
- Login: the team dropdown only fills a team for users who have none; it never changes an existing team.
- Manager: read-only view of own team (members, calendar, Summary). Manager is not offered Holidays, Manage Team, Sync or Monthly Report, and those functions refuse when called anyway. Own attendance is editable.
- Admin + Manager: Admin rules apply within the user's own team (see *Team-scoped Admin* below).
- "Everyone sees everyone's data" is now team-scoped for non-admins.
- Existing users without a team are Unassigned until the Super Admin assigns one. Deleting a team makes its members Unassigned.
- Permissions are recomputed on login and on every listener update, and cleared on logout.

**How to test manually**
1. As Super Admin: create teams A and B; Manage Team → assign users, mark one user Manager of team A.
2. Register a new user: the team dropdown lists A and B; registration requires a pick.
3. Log in as the Manager: only team A members appear; calendars are "View Only" for others; Holidays and Manage Team are absent; own calendar is editable.
4. Make the same user Admin too: team A members appear and editing and Manage Team work for team A only; Holidays stays hidden. Remove Manager only: still Admin.
5. As Admin (not Super Admin): no team or role controls. As Employee: only self (or own team with the toggle on).
6. Log in as an existing user with no team: shows "No team", sees only self.

### Firebase security rules

In legacy mode (current default) the checks above are client-side only: the live rules are not known to be restrictive, there is no Firebase Authentication, and `appData` is one blob every client downloads, so team scoping only stops honest use. The earlier custom-claims snippet that used to be here was a design sketch and has been replaced by the real rule set for secure mode, `database.rules.json` (no custom claims; free Spark plan). See *Secure mode* above, `rules/RESULTS.md` for the emulator results, and the cutover runbook in FUTURE-ENHANCEMENTS.md.

### Known limitations (non-blocking review findings)
- Legacy mode: all enforcement is client-side (above); secure mode fixes this once the runbook is completed. Admin team scoping is client-side only: with one `appData` blob keyed by member name, rules cannot allow reading one team's members and hide another's without restructuring (for example `attendanceByTeam/{teamId}/{member}`) plus Firebase Auth.
- A Manager/Admin flag set on a name that has not registered yet applies to whoever registers that name first. Register users before flagging them.
- Renaming a member does not migrate their team, Manager flag or `users` record, so they show as Unassigned afterwards.
- The client no longer hard-codes a Superuser name. In legacy mode the Superuser is the single `users/*` record with `isSuperAdmin === true`; with no such record nobody is the Superuser.
- If `teams` is later made non-public, the pre-login team picker will be empty; assign teams from Manage Team instead.
- Not tested against real Firebase or in a browser (role matrix was verified with a Node harness); do the manual checks above before release.

---

## Team-scoped Admin (2026-11-12)

An Admin sees and manages only members whose team equals the Admin's team; the Super Admin stays global; a Manager is unchanged (own team, read-only, no edit, no Holidays, no Manage Team). Admin + Manager is the union, still inside the Admin's own team.

- Enforced inside the functions, not only in the UI: `editMember`, `removeMember`, `resetPasswordForMember`, `restoreMember`, `addMember`, `reorderMembers`, `markAttendance`, `markLeave`, `removeLeave`, report and export generation all check the target (`canAdminMember` / `canAdminTeamId`) and refuse otherwise. Calling them from the browser console on another team's member shows an alert and changes nothing.
- No privilege escalation: Admins cannot change roles or teams (the login/register team picker is skipped for Admins, so a team-less Admin stays self-only until the Superuser assigns a team), an Admin can still edit/remove/reset the password of another Admin in the same team (open question 13 in REQUIREMENTS-teams-roles.md), cannot add members to another team, cannot edit/remove the Super Admin, cannot remove themselves, cannot import data (import replaces the whole data blob).
- Admin export contains only the Admin's team (attendance and leaves) plus global holidays.
- **Holidays (open question for the user):** global list, so Super Admin only by default. Set `ADMIN_CAN_EDIT_HOLIDAYS = true` in `app.js` to let Admins edit it.
- **Security honesty:** Firebase rules are NOT deployed and there is no Firebase Auth. Anyone with the Firebase config can still read every team's data directly. This scoping limits honest use only. With one `appData` blob, rules cannot enforce team-scoped reads without restructuring.

**How to test manually**
1. Team A Admin: sidebar, Summary, Manage Team and Monthly Report list only Team A members; Team B members never appear. Heading shows `Team Members - <team A name>` and there are no `[Team]` tags.
2. Admin with no team: sees only themselves, Manage Team shows the "ask the Superuser" notice, Add Member is refused.
3. Direct calls on other-team members are rejected: in the console run `app.editMember('<Team B member>')`, `app.removeMember(...)`, `app.resetPasswordForMember(...)`, `app.data.markAttendance('<Team B member>', '2026-01-05', true)`; each shows a denial and changes nothing.
4. Admin adds a member: it lands in the Admin's team and is invisible to Team B's Admin.
5. Admin has no Holidays nav, no visibility toggle, no import card in Sync.
6. Super Admin still sees all teams, `All Teams` and `[Team]` tags.
7. Logout, then log in as another user: nothing from the previous session remains.

---

## Team Name Display (2026-11-12, commit 0162eda)

- The signed-in user's team shows beside the **Team Members** heading (`Team Members - Platform`) and in the header user info (`agurav 👑 (Platform)`).
- Label rules: own team name; `All Teams` for the Super Admin only (Admins, including Admin + Manager, see their own team name); `No team` when unassigned or the team no longer exists.
- Only the Super Admin sees a `[Team]` tag (or `[No team]`) on each member in the sidebar list.
- Labels are set with `textContent` and cleared on logout (`teamHeadingLabel` is emptied in `lockApp()`); they refresh when teams or assignments change.

**How to test manually**
1. Log in as a user in team A: heading and header show `Platform`-style team name.
2. Log in as Super Admin: `All Teams`, and `[Team]` tags on members. Log in as an Admin: their own team name, no tags.
3. Log in as an unassigned user: `No team`.
4. Super Admin renames or reassigns a team while a user is logged in: label updates.
5. Logout: no team name remains on screen.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Can't login | Check username spelling. Try full name or generated username. |
| "Username not found" | User needs to register first. |
| Forgot password | Contact admin for reset to `Temp@123`. |
| Data not saving | Check 🟢/🔴 indicator. Ensure Firebase rules allow writes. |
| Can't see other members | Admin needs to enable "Everyone sees everyone's data" toggle. |
| Can't edit others' calendar | Only an Admin can edit others, and only members of their own team. Regular users edit only their own. |
| Add Member not working | Ensure you're logged in as admin. Check browser console for errors. |
| Future days not clickable | Only next 2 months are plannable. Beyond that stays locked. |

---

## Changelog

### 2026-11-12
- **fix (605054d):** Login privacy — app locked while logged out; logout clears UI, state, listeners, cached localStorage and resets the login form
- **feat (88de19b):** Teams, Manager role and Super Admin role assignment; team picker on register/login; Manager read-only team view; Admin + Manager union; team-scoped visibility toggle
- **feat (0162eda):** Team name beside "Team Members" and in header user info (`All Teams` / `No team` cases)
- **docs:** Added permission matrix, data model notes, undeployed security rules, limitations and manual test checklists
- **feat:** Admin visibility is team-scoped (own team only); holidays, visibility toggle and import are Superuser-only; Admin with no team sees only self. Every edit/manage/add/remove/restore/reset-password/export function checks the target is in the actor's team. Firebase rules still not deployed.

### Earlier
- Firebase Realtime Database integration for shared data
- Username-based login system with SHA-256 password hashing
- Role-based permissions (Super Admin, Admin, User)
- Future planning (next 2 months) with Planning to Come, Leave, Exception
- "Need to Attend" stat tile with motivational message on 60% completion
- Remember Me functionality
- Visibility toggle (admin controls who sees what)
- Soft-delete with restore for team members
- Dark/Light theme toggle
- Sortable summary table
- Leave types: Present, WFH, WFH Email, Leave, Exception, Planning to Come
- Holiday management with current month highlighting
- Monthly Dashboard Report (HTML email format)
