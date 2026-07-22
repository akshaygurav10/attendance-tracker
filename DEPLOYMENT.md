# Deploying Attendance Tracker to Microsoft Teams

## Your Code Repository

**Code is hosted at:** `code.saba.com` (internal Git)

---

## Hosting Options

Since SharePoint personal OneDrive downloads HTML files instead of rendering them, you need to host the app on a web server. Here are your options:

### Option A: GitLab/GitHub Pages on code.saba.com

If `code.saba.com` supports Pages (GitLab Pages or similar):

1. Go to your repository on `code.saba.com`
2. Enable **Pages** in the repository settings
3. Set the source to the root directory (where `index.html` is)
4. Your app will be available at a URL like: `https://agurav.code.saba.com/attendance-tracker-app/` (exact format depends on your setup)
5. Use that URL as a Website tab in Teams

### Option B: Use any internal web server

If your org has an internal web server (IIS, Apache, Nginx):

1. Clone the repo on the server
2. Point the server to serve the files
3. Use the server URL in Teams

### Option C: Use SharePoint Team Site (not personal OneDrive)

1. Ask your SharePoint admin to create a Team Site
2. Upload files to the Team Site's document library
3. Create a SharePoint Page → add "Embed" web part → paste the URL

---

## Adding to Microsoft Teams

Once you have a working URL that renders the app in browser:

1. Open **Microsoft Teams**
2. Go to the **channel** where your team collaborates
3. Click the **"+"** button at the top (next to existing tabs)
4. Search for and select **"Website"** (or "Webpage")
5. Give it a name: `Attendance Tracker`
6. Paste the hosted URL
7. Click **Save**

---

## Data Sharing Workflow

Since each person's attendance data is stored in their browser's localStorage, use this workflow to share/sync data:

### For the Team Admin (e.g., Akshay):
1. Mark attendance for all members throughout the month
2. Click **🔄 Sync to Teams** → **Share to Team** to download the JSON
3. Share the downloaded `.json` file in the Teams channel (Files tab or chat)

### For Team Members:
1. Download the latest `.json` file from the Teams channel
2. Open the Attendance Tracker tab
3. Click **🔄 Sync to Teams** → **Import from Team** and select the file
4. Their view will now show all the latest data

---

## Tips

- **Bookmark the Teams tab** for quick access
- **Pin the tab** in Teams so it appears first for everyone
- **Set a recurring Teams reminder** on the 20th and last day of each month to send the **📊 Monthly Report**
- Each team member can also use the app independently and only sync when needed

---

## Quick Start Checklist

- [ ] Push code to `code.saba.com`
- [ ] Enable Pages or deploy to an internal web server
- [ ] Verify the app loads in browser at the hosted URL
- [ ] Share access with team members
- [ ] Add as a Website tab in your Teams channel
- [ ] Test: Open the tab and mark one day as present
- [ ] Use **🔄 Sync to Teams** button to share data with the team

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
