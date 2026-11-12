const vm = require('vm'), fs = require('fs');
const store = {};
const alerts = [];
const toggle = { checked: false };
const ctx = vm.createContext({
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  document: { getElementById: id => (id === 'toggleVisibility' ? toggle : null), addEventListener() {}, querySelectorAll: () => [] },
  alert: m => alerts.push(m), confirm: () => true, console, sessionStorage: { clear() {} }
});
vm.runInContext(fs.readFileSync(__dirname + '/../../app.js', 'utf8'), ctx);
const run = c => vm.runInContext(c, ctx);
run(`TEAM_MEMBERS=['Akshay Gurav','Adm A','Mgr A','Both A','Emp A','Emp B1','Unassigned U','Mgr B'];
TEAMS={ta:{name:'A'},tb:{name:'B'}};
MEMBER_TEAMS={'Mgr A':'ta','Emp A':'ta','Both A':'ta','Adm A':'ta','Emp B1':'tb','Mgr B':'tb'};
MANAGERS=['Mgr A','Both A','Mgr B'];
ADMIN_MEMBERS=['Akshay Gurav','Adm A','Both A'];`);
const as = (u, fn) => { store['attendance_current_user'] = u; return run(fn); };
let fail = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' got=' + JSON.stringify(got) + ' exp=' + JSON.stringify(exp))); };
const users = ['Akshay Gurav', 'Adm A', 'Mgr A', 'Both A', 'Emp A', 'Unassigned U'];
const row = u => ({
  vis: as(u, 'getVisibleMembers()'),
  editOther: as(u, "canEdit('Emp B1')"), editTeammate: as(u, "canEdit('Emp A')"), editSelf: as(u, `canEdit(${JSON.stringify(u)})`),
  hol: as(u, 'canManageHolidays()'), mt: as(u, 'canManageTeam()'), sum: as(u, 'canViewSummary()'),
  teams: as(u, 'canManageTeams()'), roles: as(u, 'canAssignRoles()'), rep: as(u, 'canUseReports()')
});
const R = Object.fromEntries(users.map(u => [u, row(u)]));
const all = run('[...TEAM_MEMBERS]');
eq('Super sees all', R['Akshay Gurav'].vis, all);
eq('Admin sees all', R['Adm A'].vis, all);
eq('Both sees all', R['Both A'].vis, all);
eq('Manager A sees own team + self only', R['Mgr A'].vis, ['Adm A', 'Mgr A', 'Both A', 'Emp A']);
eq('Employee sees self only', R['Emp A'].vis, ['Emp A']);
eq('Unassigned sees self only', R['Unassigned U'].vis, ['Unassigned U']);
eq('Manager cannot edit other-team', R['Mgr A'].editOther, false);
eq('Manager cannot edit teammate', R['Mgr A'].editTeammate, false);
eq('Manager edits self', R['Mgr A'].editSelf, true);
eq('Manager no holidays/team/reports', [R['Mgr A'].hol, R['Mgr A'].mt, R['Mgr A'].rep], [false, false, false]);
eq('Manager summary yes', R['Mgr A'].sum, true);
eq('Admin+Manager edit others + holidays + manage', [R['Both A'].editOther, R['Both A'].hol, R['Both A'].mt], [true, true, true]);
eq('Admin cannot manage teams/roles', [R['Adm A'].teams, R['Adm A'].roles], [false, false]);
eq('Both cannot manage teams/roles', [R['Both A'].teams, R['Both A'].roles], [false, false]);
eq('Super manage teams/roles', [R['Akshay Gurav'].teams, R['Akshay Gurav'].roles], [true, true]);
eq('Employee: no edit others, no hol, no summary', [R['Emp A'].editOther, R['Emp A'].hol, R['Emp A'].sum], [false, false, false]);
toggle.checked = true;
eq('Employee toggle on: own team only', as('Emp A', 'getVisibleMembers()'), ['Adm A', 'Mgr A', 'Both A', 'Emp A']);
eq('Unassigned toggle on: self only', as('Unassigned U', 'getVisibleMembers()'), ['Unassigned U']);
toggle.checked = false;
// Data-layer guards (console-call equivalent)
as('Mgr A', `var d=new AttendanceData(()=>{}); d.data=d.getDefaultData(); d.firebaseReady=false;`);
alerts.length = 0;
as('Mgr A', `d.markAttendance('Emp A','2026-01-05',true)`);
as('Mgr A', `d.markLeave('Emp A','2026-01-05','leave')`);
as('Mgr A', `d.removeLeave('Emp A','2026-01-05')`);
as('Mgr A', `d.addHoliday('2026-02-02','x')`);
as('Mgr A', `d.removeHoliday('2026-02-02')`);
eq('Manager data writes denied (5 alerts)', alerts.length, 5);
eq('Manager left no data', run('JSON.stringify([d.data.attendance,d.data.leaves,d.data.holidays])'), '[{},{},[]]');
as('Mgr A', `d.markAttendance('Mgr A','2026-01-05',true)`);
eq('Manager can mark self', run('d.isPresent("Mgr A","2026-01-05")'), true);
as('Adm A', `d.markAttendance('Emp B1','2026-01-06',true)`);
eq('Admin can mark anyone', run('d.isPresent("Emp B1","2026-01-06")'), true);
// Superuser-only functions refuse for others (no database in harness => would return false anyway; check alert path)
const appObj = `Object.create(App.prototype)`;
for (const [who, fns] of [['Adm A', ["createTeam('X')", "renameTeam('ta')", "deleteTeam('ta')", "assignTeam('Emp A','tb')", "setManager('Emp A',true)", "setAdminRole('Emp A',true)", "makeAdmin('Emp A')", "removeAdmin('Adm A')"]], ['Both A', ["setManager('Emp A',true)", "assignTeam('Emp A','tb')"]]]) {
  for (const f of fns) { alerts.length = 0; const r = as(who, `${appObj}.${f}`); eq(`${who} ${f} denied`, [r, alerts.length], [false, 1]); }
}
// Non-admin cannot run admin-only app functions
for (const f of ["addMember('Z')", "removeMember('Emp A')", "editMember('Emp A')", "resetTeamToDefault()", "showSyncModal()", "syncExport()", "syncImport()", "showEmailModal()", "restoreMember('X')"]) {
  alerts.length = 0; as('Mgr A', `${appObj}.${f}`); eq(`Manager ${f} refused`, alerts.length >= 1, true);
}
eq('Manager view allowed: holiday', as('Mgr A', `${appObj}.isViewAllowed('holiday')`), false);
eq('Manager view allowed: team', as('Mgr A', `${appObj}.isViewAllowed('team')`), false);
eq('Manager view allowed: summary', as('Mgr A', `${appObj}.isViewAllowed('summary')`), true);
// No-crash on missing data
run('TEAMS={};MEMBER_TEAMS={};MANAGERS=[]');
eq('Empty state: manager flag false, team null', [as('Mgr A', 'isManager()'), as('Mgr A', 'getMyTeamId()')], [false, null]);
eq('Logged out: nothing visible', (delete store['attendance_current_user'], run('getVisibleMembers()')), []);
console.log(fail ? fail + ' FAILED' : 'ALL PASSED');
process.exit(fail ? 1 : 0);

