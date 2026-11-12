# Team Attendance Tracker

A real-time team attendance tracking app with role-based access, Firebase sync, and a Jira-style dark/light UI.

## Quick Start

1. Open the app URL (GitHub Pages)
2. **First time:** Super Admin (Akshay Gurav) logs in with username `agurav` + sets password
3. Team members click "Register here" to create their account
4. Mark attendance by clicking calendar days

## Features

- 📅 Monthly calendar with click-to-mark attendance
- 📋 Future planning (next 2 months) — Planning to Come, Leave, Exception
- 🔐 Username + password login with SHA-256 encryption
- 👑 Role-based access (Super Admin / Admin / User)
- 🔄 Real-time sync via Firebase (all users share same data)
- 🌙 Dark/Light theme toggle
- 📊 Summary dashboard with sortable columns
- 📧 Monthly HTML report for email
- 👥 Team management (add/remove/restore members)
- 🏖️ Holiday management with current month highlighting
- 🏷️ Teams: pick a team at sign-up; your team name shows beside "Team Members" and in the header
- 🔒 App is locked on the login screen and logout clears all cached user data

## Attendance Types

| Type | When | Effect |
|------|------|--------|
| ✅ Present | Current month | Counted as attended |
| 📋 Planning to Come | Future months | Counted as attended |
| 🏠 WFH | Current month | Excluded from working days |
| 📧 WFH Email | Current month | Excluded from total days |
| 🚫 Leave | Any | Excluded from working days |
| ⚡ Exception | Any | Excluded from working days |

## Login

- Enter your **username** (e.g., `agurav`, `karekar`) or full name
- Usernames are auto-generated: first initial + last name (lowercase)
- Check "Remember me" to save credentials

## Roles

| Role | Can do |
|------|--------|
| **User** | Edit own calendar, plan future, change password |
| **Manager** | View all members of own team (read-only, incl. Summary). No edit of others, no Holidays / Manage Team |
| **Admin** | + Edit all, manage team, holidays, reports, reset passwords (global) |
| **Admin + Manager** | Union of both (Admin rules apply) |
| **Super Admin** | + Create/rename/delete teams, assign teams, grant Manager/Admin; cannot be removed |

Users choose a team when registering. Existing users without a team show as "Unassigned" until the Super Admin assigns one. Role checks are client-side only; see the security rules notes in [DEPLOYMENT.md](DEPLOYMENT.md).

## Tech Stack

- HTML / CSS / JavaScript (vanilla, no frameworks)
- Firebase Realtime Database
- SHA-256 password hashing (Web Crypto API)
- GitHub Pages hosting

## Files

```
├── index.html          — Main page
├── app.js              — Application logic
├── styles.css          — Styling
├── firebase-config.js  — Firebase config
├── DEPLOYMENT.md       — Deployment guide
├── DOCUMENTATION.md    — Full documentation
└── README.md           — This file
```

## Docs

- [Full Documentation](DOCUMENTATION.md) — Features, architecture, troubleshooting
- [Deployment Guide](DEPLOYMENT.md) — Setup, Teams integration, onboarding
