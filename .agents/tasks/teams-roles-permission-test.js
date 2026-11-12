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
run(`TEAM_MEMBERS=['Akshay Gurav','Adm A','Mgr A','Both A','Emp A','Emp B1','Unassigned U','Mgr B','Adm B','Adm U','Emp B2'];
TEAMS={ta:{name:'A'},tb:{name:'B'}};
MEMBER_TEAMS={'Mgr A':'ta','Emp A':'ta','Both A':'ta','Adm A':'ta','Emp B1':'tb','Mgr B':'tb','Adm B':'tb','Emp B2':'tb'};
MANAGERS=['Mgr A','Both A','Mgr B'];
ADMIN_MEMBERS=['Akshay Gurav','Adm A','Both A','Adm B','Adm U'];`);
const as = (u, fn) => { store['attendance_current_user'] = u; return run(fn); };
let fail = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' got=' + JSON.stringify(got) + ' exp=' + JSON.stringify(exp))); };
const users = ['Akshay Gurav', 'Adm A', 'Mgr A', 'Both A', 'Emp A', 'Unassigned U', 'Adm B', 'Adm U'];
const row = u => ({
  vis: as(u, 'getVisibleMembers()'),
  editOther: as(u, "canEdit('Emp B1')"), editTeammate: as(u, "canEdit('Emp A')"), editSelf: as(u, `canEdit(${JSON.stringify(u)})`),
  hol: as(u, 'canManageHolidays()'), mt: as(u, 'canManageTeam()'), sum: as(u, 'canViewSummary()'),
  teams: as(u, 'canManageTeams()'), roles: as(u, 'canAssignRoles()'), rep: as(u, 'canUseReports()'),
  adminOtherTeam: as(u, "canAdminMember('Emp B1')"), adminSuper: as(u, "canAdminMember('Akshay Gurav')"), imp: as(u, 'canImportData()'), scope: as(u, 'getAdminScopeMembers()')
});
const R = Object.fromEntries(users.map(u => [u, row(u)]));
const all = run('[...TEAM_MEMBERS]');
const teamA = ['Adm A', 'Mgr A', 'Both A', 'Emp A'];
eq('Super sees all', R['Akshay Gurav'].vis, all);
eq('Admin sees own team + self only', R['Adm A'].vis, teamA);
eq('Both sees own team only', R['Both A'].vis, teamA);
eq('Admin A cannot see Team B', ['Emp B1', 'Mgr B', 'Adm B', 'Emp B2'].some(m => R['Adm A'].vis.includes(m)), false);
eq('Admin B sees Team B only', R['Adm B'].vis, ['Mgr B', 'Adm B', 'Emp B1', 'Emp B2'].sort((a, b) => all.indexOf(a) - all.indexOf(b)));
eq('Unassigned admin sees self only', R['Adm U'].vis, ['Adm U']);
eq('Unassigned admin scope = self', R['Adm U'].scope, ['Adm U']);
eq('Unassigned admin cannot edit teammate/other team', [R['Adm U'].editTeammate, R['Adm U'].editOther, R['Adm U'].editSelf], [false, false, true]);
eq('Admin scope matches visible', R['Adm A'].scope, teamA);
eq('Super scope = all', R['Akshay Gurav'].scope, all);
eq('Manager admin scope empty', R['Mgr A'].scope, []);
eq('Employee admin scope empty', R['Emp A'].scope, []);
eq('Manager A sees own team + self only', R['Mgr A'].vis, ['Adm A', 'Mgr A', 'Both A', 'Emp A']);
eq('Employee sees self only', R['Emp A'].vis, ['Emp A']);
eq('Unassigned sees self only', R['Unassigned U'].vis, ['Unassigned U']);
eq('Manager cannot edit other-team', R['Mgr A'].editOther, false);
eq('Manager cannot edit teammate', R['Mgr A'].editTeammate, false);
eq('Manager edits self', R['Mgr A'].editSelf, true);
eq('Manager no holidays/team/reports', [R['Mgr A'].hol, R['Mgr A'].mt, R['Mgr A'].rep], [false, false, false]);
eq('Manager summary yes', R['Mgr A'].sum, true);
eq('Admin+Manager: no other-team edit, no holidays, manages own team', [R['Both A'].editOther, R['Both A'].hol, R['Both A'].mt], [false, false, true]);
eq('Admin+Manager edits teammate', R['Both A'].editTeammate, true);
eq('Admin edits teammate, not other team', [R['Adm A'].editTeammate, R['Adm A'].editOther, R['Adm A'].adminOtherTeam], [true, false, false]);
eq('Admin cannot administer Superuser', [R['Adm A'].adminSuper, R['Both A'].adminSuper], [false, false]);
eq('Super edits all + holidays + import', [R['Akshay Gurav'].editOther, R['Akshay Gurav'].hol, R['Akshay Gurav'].imp], [true, true, true]);
eq('Admin: holidays off, import off, reports on, manage team on', [R['Adm A'].hol, R['Adm A'].imp, R['Adm A'].rep, R['Adm A'].mt], [false, false, true, true]);
eq('Manager/Employee cannot import', [R['Mgr A'].imp, R['Emp A'].imp], [false, false]);
eq('Team labels', [as('Akshay Gurav', 'getMyTeamLabel()'), as('Adm A', 'getMyTeamLabel()'), as('Adm U', 'getMyTeamLabel()'), as('Mgr A', 'getMyTeamLabel()')], ['All Teams', 'A', 'No team', 'A']);
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
eq('Admin cannot mark other-team member', run('d.isPresent("Emp B1","2026-01-06")'), false);
as('Adm A', "d.markAttendance('Emp A','2026-01-06',true)");
eq('Admin can mark teammate', run('d.isPresent("Emp A","2026-01-06")'), true);
alerts.length = 0;
as('Adm A', "d.markLeave('Emp B1','2026-01-07','leave')");
as('Adm A', "d.removeLeave('Emp B1','2026-01-07')");
as('Adm A', "d.addHoliday('2026-02-02','x')");
eq('Admin cross-team leave/holiday writes denied (3 alerts), nothing written', [alerts.length, run('JSON.stringify([d.data.leaves["Emp B1"]||null,d.data.holidays])')], [3, '[null,[]]']);
as('Adm A', "d.importJSON('{}')");
eq('Admin importJSON denied', alerts.length, 4);
as('Akshay Gurav', "d.addHoliday('2026-02-02','x')");
eq('Super can add holiday', run('d.isHoliday("2026-02-02")'), true);
as('Akshay Gurav', "d.removeHoliday('2026-02-02')");
// Holidays flag
eq('Holiday view: Adm A off by default', as('Adm A', "Object.create(App.prototype).isViewAllowed('holiday')"), false);
run('ADMIN_CAN_EDIT_HOLIDAYS = true');
eq('Holiday view: Adm A on when flag set, Mgr A still off', [as('Adm A', "Object.create(App.prototype).isViewAllowed('holiday')"), as('Mgr A', 'canManageHolidays()')], [true, false]);
run('ADMIN_CAN_EDIT_HOLIDAYS = false');
// Filtered export keeps only scoped members
as('Akshay Gurav', "d.markAttendance('Emp B1','2026-01-08',true)");
as('Adm A', "d.markAttendance('Emp A','2026-01-08',true)");
eq('Filtered export: team A only', run('Object.keys(JSON.parse(d.exportJSON(getAdminScopeMembers())).attendance)').sort(), ['Emp A', 'Mgr A']);
// Direct (console-style) calls on other-team members by Adm A are rejected and change nothing
{
  const app = 'Object.create(App.prototype)';
  const before = run('JSON.stringify([TEAM_MEMBERS,MEMBER_TEAMS,ADMIN_MEMBERS])');
  for (const f of ["editMember('Emp B1')", "removeMember('Emp B1')", "resetPasswordForMember('Emp B1')", "restoreMember('Emp B1')", "reorderMembers('Emp A','Emp B1')", "editMember('Akshay Gurav')", "removeMember('Adm A')"]) {
    alerts.length = 0; as('Adm A', `${app}.${f}`);
    eq(`Adm A ${f} rejected`, alerts.length >= 1, true);
  }
  eq('No roster/team/admin state changed by rejected calls', run('JSON.stringify([TEAM_MEMBERS,MEMBER_TEAMS,ADMIN_MEMBERS])'), before);
  alerts.length = 0; as('Adm U', `${app}.addMember('Zed')`); 
  eq('Unassigned admin addMember refused, no Zed', [alerts.length, run('TEAM_MEMBERS.includes("Zed")')], [1, false]);
  as('Adm A', `${app}.addMember('Zed','tb')`);
  eq('Admin addMember lands in own team even if tb passed', [run('TEAM_MEMBERS.includes("Zed")'), run('MEMBER_TEAMS["Zed"]')], [true, 'ta']);
  as('Akshay Gurav', `${app}.addMember('Yan','tb')`);
  eq('Super addMember honours team', run('MEMBER_TEAMS["Yan"]'), 'tb');
  eq('Adm B sees Yan, Adm A does not', [as('Adm B', 'getVisibleMembers().includes("Yan")'), as('Adm A', 'getVisibleMembers().includes("Yan")')], [true, false]);
  alerts.length = 0; as('Adm A', `${app}.resetTeamToDefault()`);
  eq('Admin resetTeamToDefault refused', alerts.length, 1);
  alerts.length = 0; as('Adm A', `${app}.syncImport()`);
  eq('Admin syncImport refused', alerts.length, 1);
  // Superuser account protected even if assigned to the admin's team
  run("MEMBER_TEAMS['Akshay Gurav']='ta'");
  eq('Admin cannot administer Superuser even in same team', as('Adm A', "canAdminMember('Akshay Gurav')"), false);
  run("delete MEMBER_TEAMS['Akshay Gurav']");
  eq('canAdminTeamId: Adm A own/other/null', [as('Adm A', "canAdminTeamId('ta')"), as('Adm A', "canAdminTeamId('tb')"), as('Adm A', "canAdminTeamId(null)")], [true, false, false]);
  eq('canAdminTeamId: Adm U any team', [as('Adm U', "canAdminTeamId('ta')"), as('Adm U', "canAdminTeamId(null)")], [false, false]);
  run("TEAM_MEMBERS=TEAM_MEMBERS.filter(m=>m!=='Zed'&&m!=='Yan'); delete MEMBER_TEAMS['Zed']; delete MEMBER_TEAMS['Yan']");
}
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
// Toggle on: admin scope still own team
toggle.checked = true;
eq('Toggle on: Adm A still team A only', as('Adm A', 'getVisibleMembers()'), teamA);
eq('Toggle on: Adm U self only', as('Adm U', 'getVisibleMembers()'), ['Adm U']);
toggle.checked = false;
// No-crash on missing data
run('TEAMS={};MEMBER_TEAMS={};MANAGERS=[]');
eq('Empty state: manager flag false, team null', [as('Mgr A', 'isManager()'), as('Mgr A', 'getMyTeamId()')], [false, null]);
eq('Empty state: team admin sees only self, no throw', [as('Adm A', 'getVisibleMembers()'), as('Adm A', 'getAdminScopeMembers()')], [['Adm A'], ['Adm A']]);
eq('Logged out: nothing visible', (delete store['attendance_current_user'], run('getVisibleMembers()')), []);
console.log(fail ? fail + ' FAILED' : 'ALL PASSED');
process.exit(fail ? 1 : 0);

