# Team Attendance Tracker

A simple, portable attendance tracking system with a Jira-style dark UI.

## Features

- **Monthly Calendar View** — Click days to mark attendance for each team member
- **Auto-excludes weekends** (Saturday & Sunday) from working day calculations
- **Holiday Management** — Add/remove holidays (Indian 2026 holidays pre-loaded)
- **60% Attendance Threshold** — Visual indicators (green/red) for compliance
- **Summary Dashboard** — View all team members' attendance status at a glance
- **Export/Import JSON** — Share data with team members or backup
- **Email Report Generator** — Formatted report ready to copy/email to manager
- **Auto Reminder** — Prompts on the 20th and last day of month to send report

## Team Members

Krutik Arekar, Humera J., Manoj K., Reshma B., Nishant Joshi, Nisar Nadaf, Rahul O., Shashank D., Akshay Gurav, Suranjana G., Vikram H., Rakshita Devkar, Shailesh Hande, Akshata Jadhav, Robinsh Raj

## How to Use

1. **Open** `index.html` in any browser (double-click — no server needed)
2. **Select** a team member from the sidebar
3. **Click** on working days to mark/unmark attendance (✅)
4. **Switch views** using the sidebar buttons (Calendar / Summary / Holidays)
5. **Export** the JSON file and share with your team or manager
6. **Import** a JSON file on another machine to restore all data

## Email Report Schedule

- **20th of every month** — Mid-month report
- **Last day of month** — End-of-month report

The app will automatically remind you on these dates.

## Attendance Calculation

```
Attendance % = (Days Attended / Working Days) × 100

Working Days = Total Days in Month - Weekends - Holidays
```

## Data Storage

- All data is stored in `localStorage` (browser)
- Use **Export** to save a `.json` file for backup/sharing
- Use **Import** to load data from a `.json` file
- The JSON file is fully portable — just copy it to any team member

## Transferring to Another Machine

1. Click **📤 Export** to download the JSON file
2. Copy the JSON file to the new machine
3. Open `index.html` on the new machine
4. Click **📥 Import** and select the JSON file

## Integration Options

### Microsoft Teams
- Host these 3 files on SharePoint or any internal web server
- Add as a **Website Tab** in your Teams channel

### Jira Dashboard
- Host on any accessible URL
- Add a **Web Page** gadget to your Jira dashboard pointing to the URL

## Files

```
attendance-tracker-app/
├── index.html    — Main HTML page
├── styles.css    — Jira-style dark theme
├── app.js        — Application logic
└── README.md     — This file
```
