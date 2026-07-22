# Attendance Tracker - Complete Documentation

## Overview

A real-time team attendance tracking application with a Jira-style dark/light UI. Built with vanilla HTML, CSS, and JavaScript, powered by Firebase Realtime Database for cloud sync across all team members.

**Live URL:** Your GitHub Pages URL (e.g., `https://yourusername.github.io/attendance-tracker/`)

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

### Attendance Types
| Type | Icon | Effect |
|------|------|--------|
| ✅ Present | Green | Counted as attended |
| 🏠 Work From Home (WFH) | Cyan | Day excluded from working days (not counted in attendance) |
| 🚫 Leave | Purple | Day excluded from working days |
| ⚡ Exception | Orange | Day excluded from working days |

### Team Management
- **Add members** — Type name and click "Add Member"
- **Remove members** — Click "Remove" (attendance history preserved)
- **Edit names** — Click ✏️ to rename (data transfers to new name)
- **Drag to reorder** — Drag the ☰ handle to rearrange member order
- **Reset to default** — Restore original team list

### Reports
- **Monthly Dashboard Report** — Visual report with KPI cards, progress bars, status badges
- **Copy to Clipboard** — Copies rich HTML, paste directly into Outlook/Teams
- **Send Email** — Opens Outlook with dashboard in email body
- **Sortable columns** — Click column headers to sort by Name, Days Attended, %, Status

### Holidays
- **Pre-loaded** — Indian 2026 holidays included
- **Add/Remove** — Manage holidays from the Holidays view
- **Current month highlight** — This month's holidays shown with cyan badge
- **Auto-excluded** — Holiday days not counted as working days

### Sync & Sharing
- **Firebase Real-time** — All data syncs automatically across all users
- **Sync to Teams** — Export/Import JSON for manual sharing
- **Connection indicator** — Green dot = connected, Red = offline, Yellow = connecting
- **Offline support** — App works offline using localStorage, syncs when reconnected

---

## How to Use

### Marking Attendance
1. Select a team member from the sidebar (or click any name from any view)
2. **Left-click** a day to toggle Present ✅
3. **Right-click** a day to see options: Present, Leave, WFH, Exception, Clear

### Viewing Summary
1. Click **📊 Summary** in the sidebar
2. Click column headers (▲▼) to sort
3. Click **🔄 Reset Order** to return to default team order
4. Use ◀ ▶ arrows to navigate months

### Generating Reports
1. Click **📧 Monthly Report** in the top nav
2. Preview the dashboard
3. Click **📋 Copy Dashboard to Clipboard** → Paste into Outlook/Teams
4. Or click **📧 Send Email** → Outlook opens with content ready

### Managing Team
1. Click **👥 Manage Team** in the sidebar
2. Add new members using the input field
3. Click ✏️ to edit a name
4. Click "Remove" to remove a member
5. Drag ☰ to reorder
6. Click **🔄 Reset to Default** to restore original list

### Managing Holidays
1. Click **🏖️ Holidays** in the sidebar
2. Use the date picker and name field to add holidays
3. Click "Remove" to delete a holiday
4. Current month holidays are highlighted in cyan

### Switching Theme
- Click **☀️ Light** or **🌙 Dark** button in the top nav
- Theme preference is saved and persists

---

## Technical Architecture

### Files
```
attendance-tracker-app/
├── index.html          — Main HTML page
├── app.js              — Application logic (classes, rendering, events)
├── styles.css          — Dark/Light theme styles
├── firebase-config.js  — Firebase initialization and connection monitoring
├── README.md           — Quick overview
├── DEPLOYMENT.md       — Deployment instructions
└── DOCUMENTATION.md    — This file
```

### Data Storage

**Primary:** Firebase Realtime Database (cloud, shared)
**Backup:** Browser localStorage (local, per-user)

#### Firebase Database Structure
```json
{
  "appData": {
    "attendance": {
      "Member Name": {
        "2026-07-21": true,
        "2026-07-22": true
      }
    },
    "holidays": [
      { "date": "2026-01-26", "name": "Republic Day" }
    ],
    "leaves": {
      "Member Name": {
        "2026-07-23": "leave",
        "2026-07-24": "wfh",
        "2026-07-25": "exception"
      }
    },
    "lastUpdated": "2026-07-22T10:30:00.000Z"
  },
  "teamMembers": [
    "Krutik Arekar",
    "Humera J.",
    "..."
  ]
}
```

### Attendance Calculation
```
Effective Working Days = Total Days - Weekends - Holidays - Leaves - Exceptions - WFH days

Attendance % = (Days Attended / Effective Working Days) × 100

Days Attended = Present days only (WFH not included)
```

### Key Classes

**AttendanceData** — Manages all data (CRUD operations, calculations)
- Syncs with Firebase on every write
- Listens for real-time updates from Firebase
- Falls back to localStorage if Firebase is unavailable

**App** — UI controller (rendering, events, navigation)
- Handles all user interactions
- Re-renders automatically when Firebase data changes
- Manages view switching, sorting, theme

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

### Database Rules (Test Mode)
```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

> ⚠️ **Security Note:** Test mode allows anyone to read/write. For production, update rules to restrict access. See "Security" section below.

### Recommended Production Rules
```json
{
  "rules": {
    ".read": true,
    ".write": true,
    "appData": {
      ".read": true,
      ".write": true
    },
    "teamMembers": {
      ".read": true,
      ".write": true
    }
  }
}
```

---

## Deployment

### GitHub Pages
1. Push code to GitHub repository
2. Go to Settings → Pages → Deploy from branch (main, root)
3. App is live at `https://username.github.io/repo-name/`

### Microsoft Teams Integration
1. Open Teams → Channel → Click "+" tab
2. Select "Website"
3. Name: "Attendance Tracker"
4. URL: Your GitHub Pages URL
5. Save

### SharePoint Embed
1. Create a SharePoint page
2. Add "Embed" web part
3. Paste your GitHub Pages URL

---

## Team Members (Default)

| # | Name |
|---|------|
| 1 | Krutik Arekar |
| 2 | Humera J. |
| 3 | Manoj K. |
| 4 | Reshma B. |
| 5 | Nishant Joshi |
| 6 | Nisar Nadaf |
| 7 | Rahul O. |
| 8 | Shashank D. |
| 9 | Akshay Gurav |
| 10 | Suranjana G. |
| 11 | Vikram H. |
| 12 | Rakshita Devkar |
| 13 | Shailesh Hande |
| 14 | Akshata Jadhav |
| 15 | Robinsh Raj |

---

## Report Schedule

- **20th of every month** — Mid-month report
- **Last day of month** — End-of-month report

The app automatically reminds you on these dates to generate the report.

---

## Keyboard Shortcuts & Interactions

| Action | How |
|--------|-----|
| Mark present | Left-click a day |
| Leave/WFH/Exception menu | Right-click a day |
| Switch to member's calendar | Click any member name (from any view) |
| Sort table | Click column header |
| Reorder members | Drag ☰ handle |
| Add member | Type name + Enter |

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Yellow/Red dot (disconnected) | Check internet connection; Firebase may be temporarily unavailable |
| Data not syncing | Verify Firebase Realtime Database is created and rules allow read/write |
| App shows old data | Hard refresh (Ctrl+Shift+R) to clear cache |
| Theme not saving | Check if localStorage is enabled in browser |
| Report shows plain text in email | Use "Copy Dashboard to Clipboard" and paste (Ctrl+V) into Outlook instead |
| Team member order reset | Click "Reset to Default" in Manage Team view |

---

## Security Considerations

1. **Firebase rules** — Switch from test mode to authenticated rules after 30 days
2. **API keys** — Firebase web API keys are safe to expose (they're restricted by domain in Firebase Console → App Check)
3. **Data privacy** — Attendance data is visible to anyone with the database URL in test mode. Restrict access for production use.
4. **No authentication** — Currently no login required. All users share the same data pool. For per-user access control, Firebase Authentication can be added later.

---

## Future Enhancements

- [ ] Firebase Authentication (Google sign-in for each team member)
- [ ] Per-user permissions (admin vs. member)
- [ ] Monthly report auto-email via Firebase Cloud Functions
- [ ] Export to Excel/CSV
- [ ] Historical trends and charts
- [ ] Mobile-responsive improvements
- [ ] Push notifications for low attendance alerts
