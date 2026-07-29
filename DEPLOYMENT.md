# Deploying Attendance Tracker to Microsoft Teams

## Code Repository

**Code:** `https://code.saba.com/users/agurav/repos/attendance-tracker/`  
**Live App:** Your GitHub Pages URL

---

## Hosting

The app is hosted on **GitHub Pages** — a free static site hosting service.

### Setup (already done)
1. Code pushed to GitHub
2. Pages enabled in Settings → Deploy from branch (main, root)
3. App accessible at the GitHub Pages URL

---

## Microsoft Teams Integration

1. Open **Microsoft Teams**
2. Go to the **channel** where your team collaborates
3. Click the **"+"** button at the top
4. Select **"Website"**
5. Name: `Attendance Tracker`
6. URL: Your GitHub Pages URL
7. Click **Save**

---

## Firebase (Backend Database)

All data is stored in **Firebase Realtime Database**. The app connects automatically — no server to manage.

### Firebase Project
- **Console:** [https://console.firebase.google.com/](https://console.firebase.google.com/) → Project: `attendance-tracker-dca2b`
- **Database URL:** `https://attendance-tracker-dca2b-default-rtdb.asia-southeast1.firebasedatabase.app`
- **Region:** Asia Southeast 1

### Database Rules (current)
```json
{
  "rules": {
    ".read": "now < 1787250600000",
    ".write": "now < 1787250600000"
  }
}
```
> ⚠️ These rules expire on **August 21, 2026**. After that date, update them in Firebase Console → Realtime Database → Rules tab.

### What's stored in Firebase
| Node | Content |
|------|---------|
| `appData` | Attendance records, holidays, leaves |
| `teamMembers` | Active team members list |
| `admins` | Admin members list |
| `users` | User accounts (name, username, password hash, roles, status) |
| `settings` | App settings (visibility toggle) |

### Firebase Config
The Firebase configuration is in `firebase-config.js`. This file contains the API keys and database URL needed to connect to the Firebase backend. These keys are safe to expose in client-side code (Firebase restricts access via database rules, not API keys).

### Connection Status
The app shows a connection indicator next to "Attendance Tracker":
- **🟢 Synced** — Connected to Firebase, data saves in real-time
- **🔴 Offline** — No connection, data saves to localStorage only

---

## First Time Setup

1. **Super Admin** (Akshay Gurav) opens the app first
2. Login with username `agurav` or `Akshay Gurav` + set any password
3. Share the app URL with team members
4. Each member clicks **"Register here"** → enters full name + creates password
5. Username is auto-generated (shown after login)
6. Admin enables **"Everyone sees everyone's data"** toggle in Manage Team if needed

---

## User Onboarding Guide (Share with team)

1. Open the Attendance Tracker URL
2. Click **"Register here"**
3. Enter your **full name** (e.g., Krutik Arekar)
4. Create a **password** (min 4 characters)
5. Confirm password → Click Register
6. You're in! Your username (e.g., `karekar`) is shown in the top-right
7. Mark your attendance by clicking days on the calendar
8. Check "Remember me" on login to save your credentials

---

## Password Policy

| Scenario | Password |
|----------|----------|
| New registration | User creates their own |
| Admin resets | Resets to `Temp@123` |
| After restore | User prompted to set new password on next login |
| Change password | Click 🔑 in top-right (requires old password) |

---

## Admin Responsibilities

- Add new team members (Manage Team → type name → Add)
- Remove terminated members (they can be restored later)
- Reset forgotten passwords (🔑 icon → resets to `Temp@123`)
- Manage holidays (add/remove from Holidays view)
- Toggle data visibility for team
- Generate monthly reports
- Promote/demote other admins (super admin only)

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| App shows blank | Hard refresh (Ctrl+Shift+R). Check internet connection. |
| "Username not found" | User hasn't registered yet. Click "Register here". |
| "Account terminated" | Admin needs to restore the user in Manage Team. |
| Data not syncing | Check 🟢/🔴 indicator next to "Attendance Tracker" |
| Can't see team members | Admin needs to enable visibility toggle |
| Password forgotten | Admin resets to `Temp@123` |

---

## Quick Reference

- **Login:** Type username (e.g., `agurav`) + password
- **Mark attendance:** Click a day (current month)
- **Plan future:** Navigate to next month → click day → select option
- **Change password:** Top-right → 🔑 Password
- **Logout:** Top-right → ⇄ Logout
- **Admin panel:** Manage Team view (admin only)

---

## Step 2: Add as a Tab in Microsoft Teams

1. Open **Microsoft Teams**
2. Go to the **channel** where your team collaborates
3. Click the **"+"** button at the top (next to existing tabs)
4. Search for and select **"Website"** (or "Webpage")
5. Give it a name: `Attendance Tracker`
6. Paste the URL: `https://csod365-my.sharepoint.com/personal/agurav_csod_com/Documents/attendance-tracker-app/index.html`
7. Click **Save**

Your team can now access the tracker directly from the Teams channel tab.

---

## Step 3: Data Sharing Workflow

Since each person's attendance data is stored in their browser's localStorage, use this workflow to share/sync data:

### For the Team Admin (e.g., Krutik):
1. Mark attendance for all members throughout the month
2. On the 20th or last day of month, click **📤 Export** to download the JSON backup
3. Share the exported `.json` file in the Teams channel (Files tab or chat)

### For Team Members:
1. Download the latest `.json` file from the Teams channel
2. Open the Attendance Tracker tab
3. Click **📥 Import** and select the downloaded file
4. Their view will now show all the latest data

### For Generating Reports:
1. Click **📧 Email Report** in the tracker
2. Copy the formatted report
3. Paste into a Teams message or email to your manager

---

## Alternative: SharePoint Page Embed

If you prefer embedding in a SharePoint page instead of Teams:

1. Go to your SharePoint site → **Site Pages** → **New Page**
2. Add an **"Embed"** web part
3. Paste the URL: `https://csod365-my.sharepoint.com/personal/agurav_csod_com/Documents/attendance-tracker-app/index.html`
4. Publish the page
5. Share the page link with your team

---

## Folder Structure on SharePoint

```
https://csod365-my.sharepoint.com/personal/agurav_csod_com/Documents/
└── attendance-tracker-app/
    ├── index.html
    ├── app.js
    ├── styles.css
    ├── README.md
    └── DEPLOYMENT.md
```

---

## Tips

- **Bookmark the Teams tab** for quick access
- **Pin the tab** in Teams so it appears first for everyone
- **Set a recurring Teams reminder** on the 20th and last day of each month to export/share data
- Each team member can also use the app independently and only sync when needed

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Page shows blank in Teams | Make sure the URL points directly to the hosted `index.html` |
| "This content can't be shown" | Check that team members have access to the hosted URL |
| Data lost after clearing browser | Re-import the latest JSON using Sync to Teams |
| App looks broken | Ensure all 3 files (`index.html`, `app.js`, `styles.css`) are deployed together |
| SharePoint downloads HTML instead of rendering | Use Pages on code.saba.com or an internal web server instead |

---

## Quick Start Checklist

- [ ] Files are at: `https://csod365-my.sharepoint.com/personal/agurav_csod_com/Documents/attendance-tracker-app/`
- [ ] Share the folder with team members (right-click folder → Share)
- [ ] Add as a Website tab in your Teams channel
- [ ] Test: Open the tab and mark one day as present
- [ ] Use **🔄 Sync to Teams** button to share data with the team
- [ ] Set a Teams reminder for the 20th and last day of each month to send the **📊 Monthly Report**
