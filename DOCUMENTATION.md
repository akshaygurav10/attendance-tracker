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

### Team Management (Admin only)
- **Add members** — Type name and click "Add Member"
- **Remove members** — Soft-delete (marked as terminated, can be restored)
- **Edit names** — Click ✏️ to rename (data transfers to new name)
- **Drag to reorder** — Drag the ☰ handle to rearrange member order
- **Restore terminated** — Admin can restore deleted members with password reset
- **Make/Remove Admin** — Super admin can promote/demote admins
- **Reset password** — Admin clicks 🔑 → password resets to `Temp@123`

### Reports (Admin only)
- **Monthly Dashboard Report** — Visual report with KPI cards, progress bars, status badges
- **Copy to Clipboard** — Copies rich HTML, paste directly into Outlook/Teams
- **Send Email** — Opens .eml file with dashboard in Outlook
- **Sortable columns** — Click column headers to sort by Name, Days Attended, %, Status

### Holidays (Admin only)
- **Pre-loaded** — Indian 2026 holidays included
- **Add/Remove** — Manage holidays from the Holidays view
- **Current month highlight** — This month's holidays shown with cyan badge

### Visibility Settings (Admin only)
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
- Can edit everyone's attendance
- Can add/remove/edit team members
- Can make/remove other admins
- Can reset passwords (to `Temp@123`)
- Can manage holidays
- Can toggle visibility settings
- Can generate reports & sync data
- Sees all team members always

### Admin (Promoted by Super Admin)
- Can edit everyone's attendance
- Can add/remove/edit team members
- Can reset passwords
- Can manage holidays
- Cannot remove other admins (only super admin can)

### Regular User
- Can only edit their own attendance
- Can plan future attendance (next 2 months)
- Can change their own password
- Can see others' data only if visibility is enabled by admin
- Cannot see: Holidays, Manage Team, Sync, Monthly Report, Summary (when visibility disabled)

---

## How to Use

### First Time Setup
1. Super Admin (Akshay Gurav) opens the app
2. Types username `agurav` or `Akshay Gurav` + any password → auto-registers
3. Other team members click "Register here" → enter full name + password
4. Username is auto-generated (e.g., "Krutik Arekar" → `karekar`)

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
  "users": {
    "Akshay Gurav": {
      "name": "Akshay Gurav",
      "username": "agurav",
      "passwordHash": "sha256...",
      "isAdmin": true,
      "isSuperAdmin": true,
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
```javascript
const firebaseConfig = {
    apiKey: "AIzaSyClCYh21_u4LTnlIP9tl0ahHrVQEvvFIgM",
    authDomain: "attendance-tracker-dca2b.firebaseapp.com",
    projectId: "attendance-tracker-dca2b",
    storageBucket: "attendance-tracker-dca2b.firebasestorage.app",
    messagingSenderId: "1073028755352",
    appId: "1:1073028755352:web:ee8a2f917970f21c8045ed",
    databaseURL: "https://attendance-tracker-dca2b-default-rtdb.asia-southeast1.firebasedatabase.app"
};
```

### Database Rules
```json
{
  "rules": {
    ".read": "now < 1787250600000",
    ".write": "now < 1787250600000"
  }
}
```

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
[Logo] Attendance Tracker 🟢Synced  |  [agurav 👑 | 🔑 Password | ⇄ Logout]  [☀️Light] [🔄Sync] [📧Report]
```
- Sync indicator: 🟢 Synced / 🔴 Offline
- Password, Logout, Sync, Report buttons
- Sync & Report hidden for non-admin

### Sidebar
- Team Members list (logged-in user on top with "(You)" tag)
- Views: Calendar, Summary (visibility-dependent), Holidays (admin), Manage Team (admin)
- Legend: Present, WFH, WFH Email, Leave, Exception, Weekend, Holiday, Today

### Calendar View
- Month navigation (centered): ◀ July 2026 ▶
- Viewing info (right): "📝 Editing: Name" or "👁️ View Only"
- Stat tiles (centered): Working Days, Days Attended, Need to Attend, Required, Attendance %
- Motivation message (when 60% met)
- Calendar grid (centered)

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Can't login | Check username spelling. Try full name or generated username. |
| "Username not found" | User needs to register first. |
| Forgot password | Contact admin for reset to `Temp@123`. |
| Data not saving | Check 🟢/🔴 indicator. Ensure Firebase rules allow writes. |
| Can't see other members | Admin needs to enable "Everyone sees everyone's data" toggle. |
| Can't edit others' calendar | Only admin can edit others. Regular users edit only their own. |
| Add Member not working | Ensure you're logged in as admin. Check browser console for errors. |
| Future days not clickable | Only next 2 months are plannable. Beyond that stays locked. |

---

## Changelog

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
