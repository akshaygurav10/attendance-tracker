'use strict';
// Emulator tests for database.rules.json (design section 13 "Rules tests").
// Run with: npm run test:rules  (starts the Database emulator via firebase-tools).
// Never points at a live project: projectId is a demo- id and the host is the
// emulator started by `firebase emulators:exec`.

const { describe, test, before, after, beforeEach } = require('node:test');
const fs = require('fs');
const path = require('path');
const {
    initializeTestEnvironment,
    assertSucceeds,
    assertFails
} = require('@firebase/rules-unit-testing');

const PROJECT_ID = 'demo-attendance-rules';
const RULES = fs.readFileSync(path.join(__dirname, '..', 'database.rules.json'), 'utf8');
const ISO = '2024-01-01T00:00:00.000Z';

let env;

function profile(name, extra) {
    return Object.assign({
        name,
        username: name.toLowerCase().replace(/[^a-z0-9._-]/g, ''),
        memberKey: name.replace(/\./g, '___DOT___'),
        isAdmin: false,
        isManager: false,
        terminated: false,
        registeredAt: ISO
    }, extra || {});
}

// uid -> profile. Keys are memberKeys equal to the names below.
const USERS = {
    su: profile('Super', { isSuperAdmin: true, isAdmin: true, teamId: 'tA' }),
    admA: profile('AdminA', { isAdmin: true, teamId: 'tA' }),
    admB: profile('AdminB', { isAdmin: true, teamId: 'tB' }),
    admNT: profile('AdminNT', { isAdmin: true }),
    mgrA: profile('MgrA', { isManager: true, teamId: 'tA' }),
    mgrNT: profile('MgrNT', { isManager: true }),
    empA: profile('EmpA', { teamId: 'tA' }),
    empA2: profile('EmpA2', { teamId: 'tA', mustResetPassword: true }),
    empA3: profile('EmpA3', { teamId: 'tA' }),
    empA5: profile('EmpA5', { teamId: 'tA' }),
    empB: profile('EmpB', { teamId: 'tB' }),
    una1: profile('Una1'),
    una2: profile('Una2'),
    termA: profile('TermA', { teamId: 'tA', terminated: true, terminatedAt: ISO })
};

function seedData(settings) {
    const memberOwners = {};
    for (const [uid, p] of Object.entries(USERS)) memberOwners[p.memberKey] = uid;
    const member = (name, order, uid, extra) => Object.assign({ name, order }, uid ? { uid } : {}, extra || {});
    return {
        teams: {
            tA: { id: 'tA', name: 'Team A', createdBy: 'Super', createdAt: ISO },
            tB: { id: 'tB', name: 'Team B', createdBy: 'Super', createdAt: ISO }
        },
        teamNames: { tA: 'Team A', tB: 'Team B' },
        settings: Object.assign({ everyoneSeesAll: false }, settings || {}),
        usersV2: USERS,
        memberOwners,
        holidays: { '2024-12-25': { name: 'Christmas' } },
        teamData: {
            tA: {
                members: {
                    Super: member('Super', 0, 'su'),
                    AdminA: member('AdminA', 1, 'admA'),
                    MgrA: member('MgrA', 2, 'mgrA'),
                    EmpA: member('EmpA', 3, 'empA'),
                    EmpA2: member('EmpA2', 4, 'empA2'),
                    EmpA4: member('EmpA4', 5),
                    EmpA5: member('EmpA5', 6),
                    TermA: member('TermA', 7, 'termA', { terminated: true })
                },
                attendance: {
                    EmpA: { '2024-01-02': true },
                    MgrA: { '2024-01-02': true },
                    TermA: { '2024-01-02': true }
                },
                leaves: { EmpA: { '2024-01-03': 'wfh' } }
            },
            tB: {
                members: { AdminB: member('AdminB', 0, 'admB'), EmpB: member('EmpB', 1, 'empB') },
                attendance: { EmpB: { '2024-01-02': true } },
                leaves: { EmpB: { '2024-01-03': 'leave' } }
            },
            unassigned: {
                members: { Una1: member('Una1', 0, 'una1'), Una2: member('Una2', 1, 'una2') },
                attendance: { Una1: { '2024-01-02': true }, Una2: { '2024-01-02': true } },
                leaves: { Una1: { '2024-01-04': 'planned' } }
            }
        },
        // Legacy-only nodes: must be denied to everyone.
        appData: { attendance: {} , marker: true },
        users: { EmpA: { name: 'EmpA', passwordHash: 'x' } },
        admins: ['AdminA'],
        managers: ['MgrA'],
        teamMembers: ['EmpA'],
        memberTeams: { EmpA: 'tA' }
    };
}

async function seed(settings) {
    await env.withSecurityRulesDisabled(async (ctx) => {
        await ctx.database().ref().set(seedData(settings));
    });
}

function db(uid) {
    return uid ? env.authenticatedContext(uid).database() : env.unauthenticatedContext().database();
}
const read = (uid, p) => db(uid).ref(p).once('value');
const write = (uid, p, v) => db(uid).ref(p).set(v);
const upd = (uid, v) => db(uid).ref().update(v);

before(async () => {
    env = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        database: { rules: RULES }
    });
});

after(async () => {
    if (env) await env.cleanup();
});

beforeEach(async () => {
    await env.clearDatabase();
    await seed();
});

describe('escalation boundary (profile create and update)', () => {
    async function claim(uid, key) {
        await assertSucceeds(write(uid, 'memberOwners/' + key, uid));
    }
    test('valid self-created profile succeeds after claim', async () => {
        await claim('new1', 'NewU');
        await assertSucceeds(write('new1', 'usersV2/new1', profile('NewU', { teamId: 'tA' })));
    });
    for (const [label, extra] of [
        ['isAdmin true', { isAdmin: true }],
        ['isManager true', { isManager: true }],
        ['isSuperAdmin', { isSuperAdmin: true }],
        ['terminated true', { terminated: true }],
        ['mustResetPassword', { mustResetPassword: true }],
        ['teamId not in teamNames', { teamId: 'tZ' }]
    ]) {
        test('self-create with ' + label + ' fails', async () => {
            await claim('new1', 'NewU');
            await assertFails(write('new1', 'usersV2/new1', profile('NewU', extra)));
        });
    }
    test('self-create with an unclaimed memberKey fails', async () => {
        await assertFails(write('new2', 'usersV2/new2', profile('NoClaim')));
    });
    test('self-create with a key claimed by someone else fails', async () => {
        await assertFails(write('new2', 'usersV2/new2', profile('EmpA')));
    });
    test('user setting their whole existing profile fails', async () => {
        await assertFails(write('empA', 'usersV2/empA', USERS.empA));
    });
    test('user deleting their own profile fails', async () => {
        await assertFails(write('empA', 'usersV2/empA', null));
    });
    test('writing only own isAdmin fails (with profile)', async () => {
        await assertFails(write('empA', 'usersV2/empA/isAdmin', true));
    });
    test('writing only own isAdmin fails (without profile)', async () => {
        await claim('new1', 'NewU');
        await assertFails(write('new1', 'usersV2/new1/isAdmin', true));
    });
    test('Superuser changes isAdmin, isManager, teamId, terminated on another user', async () => {
        await assertSucceeds(write('su', 'usersV2/empA/isAdmin', true));
        await assertSucceeds(write('su', 'usersV2/empA/isManager', true));
        await assertSucceeds(write('su', 'usersV2/empA/teamId', 'tB'));
        await assertSucceeds(write('su', 'usersV2/empA/terminated', true));
    });
    test('nobody can write isSuperAdmin, including the Superuser', async () => {
        await assertFails(write('su', 'usersV2/empA/isSuperAdmin', true));
        await assertFails(write('su', 'usersV2/su/isSuperAdmin', false));
        await assertFails(write('empA', 'usersV2/empA/isSuperAdmin', true));
    });
    test('Superuser cannot delete a profile from the client', async () => {
        await assertFails(write('su', 'usersV2/empA', null));
    });
});

describe('name replace semantics', () => {
    test('name with one dot and encoded memberKey succeeds', async () => {
        await assertSucceeds(write('d1', 'memberOwners/J___DOT___Smith', 'd1'));
        await assertSucceeds(write('d1', 'usersV2/d1', profile('J.Smith')));
    });
    test('name with two dots and fully encoded memberKey succeeds (replace-all check)', async () => {
        await assertSucceeds(write('d2', 'memberOwners/A___DOT___B___DOT___C', 'd2'));
        await assertSucceeds(write('d2', 'usersV2/d2', profile('A.B.C')));
    });
    test('mismatched memberKey fails', async () => {
        await assertSucceeds(write('d3', 'memberOwners/Other', 'd3'));
        await assertFails(write('d3', 'usersV2/d3', profile('J.Smith', { memberKey: 'Other' })));
    });
});

describe('team isolation', () => {
    test('Admin A reads and writes team A, fails on team B', async () => {
        await assertSucceeds(read('admA', 'teamData/tA/attendance'));
        await assertSucceeds(read('admA', 'teamData/tA/members'));
        await assertSucceeds(write('admA', 'teamData/tA/attendance/EmpA/2024-02-01', true));
        await assertFails(read('admA', 'teamData/tB/attendance'));
        await assertFails(write('admA', 'teamData/tB/attendance/EmpB/2024-02-01', true));
    });
    test('Manager reads own team, fails writing a colleague, succeeds writing own', async () => {
        await assertSucceeds(read('mgrA', 'teamData/tA/attendance'));
        await assertFails(write('mgrA', 'teamData/tA/attendance/EmpA/2024-02-01', true));
        await assertSucceeds(write('mgrA', 'teamData/tA/attendance/MgrA/2024-02-01', true));
        await assertFails(read('mgrA', 'teamData/tB/attendance'));
    });
    test('Employee reads colleague with toggle off (fail) and on (succeed)', async () => {
        await assertFails(read('empA', 'teamData/tA/attendance'));
        await assertFails(read('empA', 'teamData/tA/attendance/MgrA'));
        await assertSucceeds(read('empA', 'teamData/tA/attendance/EmpA'));
        await env.withSecurityRulesDisabled((ctx) => ctx.database().ref('settings/everyoneSeesAll').set(true));
        await assertSucceeds(read('empA', 'teamData/tA/attendance'));
        await assertFails(read('empA', 'teamData/tB/attendance'));
    });
    test('unassigned user cannot read another unassigned user, toggle off and on', async () => {
        await assertFails(read('una1', 'teamData/unassigned/attendance/Una2'));
        await assertFails(read('una1', 'teamData/unassigned/members'));
        await assertSucceeds(read('una1', 'teamData/unassigned/attendance/Una1'));
        await env.withSecurityRulesDisabled((ctx) => ctx.database().ref('settings/everyoneSeesAll').set(true));
        await assertFails(read('una1', 'teamData/unassigned/attendance/Una2'));
        await assertFails(read('una1', 'teamData/unassigned/members'));
        await assertFails(read('una1', 'teamData/unassigned/attendance'));
    });
    test('Superuser reads all teamData', async () => {
        await assertSucceeds(read('su', 'teamData'));
    });
});

describe('leave types', () => {
    const TYPES = ['leave', 'wfh', 'wfh-email', 'exception', 'planned'];
    for (const t of TYPES) {
        test('leave type ' + t + ': self, own-team Admin, Superuser succeed; Manager and cross-team Admin fail', async () => {
            await assertSucceeds(write('empA', 'teamData/tA/leaves/EmpA/2024-03-01', t));
            await assertSucceeds(write('admA', 'teamData/tA/leaves/EmpA/2024-03-02', t));
            await assertSucceeds(write('su', 'teamData/tA/leaves/EmpA/2024-03-03', t));
            await assertFails(write('mgrA', 'teamData/tA/leaves/EmpA/2024-03-04', t));
            await assertFails(write('admB', 'teamData/tA/leaves/EmpA/2024-03-05', t));
        });
    }
    test('out-of-domain leave value fails', async () => {
        await assertFails(write('empA', 'teamData/tA/leaves/EmpA/2024-03-01', 'sick'));
    });
    test('attendance value other than true fails', async () => {
        await assertFails(write('empA', 'teamData/tA/attendance/EmpA/2024-03-01', false));
        await assertFails(write('empA', 'teamData/tA/attendance/EmpA/2024-03-01', 'yes'));
    });
    test('malformed dates fail', async () => {
        await assertFails(write('empA', 'teamData/tA/attendance/EmpA/2024-3-1', true));
        await assertFails(write('empA', 'teamData/tA/leaves/EmpA/20240301', 'leave'));
    });
});

describe('registration order', () => {
    test('claim without profile succeeds; second claim by another account fails', async () => {
        await assertSucceeds(write('new1', 'memberOwners/NewU', 'new1'));
        await assertFails(write('new2', 'memberOwners/NewU', 'new2'));
    });
    test('claim after having a profile fails', async () => {
        await assertFails(write('empA', 'memberOwners/Whatever', 'empA'));
    });
    test('owner deletes claim before profile (ok) and after (fails)', async () => {
        await assertSucceeds(write('new1', 'memberOwners/NewU', 'new1'));
        await assertSucceeds(write('new1', 'memberOwners/NewU', null));
        await assertFails(write('empA', 'memberOwners/EmpA', null));
    });
    test('reading someone else\'s claim fails, own claim succeeds', async () => {
        await assertFails(read('empA', 'memberOwners/EmpA2'));
        await assertSucceeds(read('empA', 'memberOwners/EmpA'));
    });
    test('profile create without a matching claim fails', async () => {
        await assertFails(write('new3', 'usersV2/new3', profile('NewThree')));
    });
    test('roster create before profile fails, after succeeds', async () => {
        await assertSucceeds(write('new1', 'memberOwners/NewU', 'new1'));
        const entry = { name: 'NewU', order: 99, uid: 'new1', addedBy: 'NewU' };
        await assertFails(write('new1', 'teamData/tA/members/NewU', entry));
        await assertSucceeds(write('new1', 'usersV2/new1', profile('NewU', { teamId: 'tA' })));
        await assertSucceeds(write('new1', 'teamData/tA/members/NewU', entry));
    });
});

describe('self move (first team assignment, no SELFMOVE)', () => {
    function step3(key, team) {
        return {
            ['teamData/' + team + '/members/' + key]: { name: key, order: 0, uid: 'una1', addedBy: key },
            ['teamData/' + team + '/attendance/' + key + '/2024-01-02']: true,
            ['teamData/' + team + '/leaves/' + key + '/2024-01-04']: 'planned',
            ['teamData/unassigned/members/' + key]: null,
            ['teamData/unassigned/attendance/' + key]: null,
            ['teamData/unassigned/leaves/' + key]: null
        };
    }
    test('team-less user sets teamId then copies and deletes (worst-case move write)', async () => {
        await assertSucceeds(write('una1', 'usersV2/una1/teamId', 'tA'));
        await assertSucceeds(upd('una1', step3('Una1', 'tA')));
        let v;
        await env.withSecurityRulesDisabled(async (ctx) => {
            v = (await ctx.database().ref('teamData').once('value')).val();
        });
        if (!v.tA.attendance.Una1 || !v.tA.leaves.Una1 || !v.tA.members.Una1) throw new Error('copy missing');
        if (v.unassigned.attendance && v.unassigned.attendance.Una1) throw new Error('unassigned copy not removed');
        if (v.unassigned.members.Una1) throw new Error('unassigned roster not removed');
    });
    test('same sequence by a user who already has a team fails at teamId', async () => {
        await assertFails(write('empA', 'usersV2/empA/teamId', 'tB'));
    });
    test('team-less user writing into a real team before step 2 fails', async () => {
        await assertFails(write('una1', 'teamData/tA/attendance/Una1/2024-01-05', true));
        await assertFails(write('una1', 'teamData/tA/leaves/Una1/2024-01-05', 'leave'));
        await assertFails(write('una1', 'teamData/tA/members/Una1', { name: 'Una1', order: 0 }));
    });
    test('move into a team not in teamNames fails', async () => {
        await assertFails(write('una1', 'usersV2/una1/teamId', 'tZ'));
    });
    test('move that also writes isAdmin fails', async () => {
        await assertFails(upd('una1', { 'usersV2/una1/teamId': 'tA', 'usersV2/una1/isAdmin': true }));
    });
    test('self first-assignment as Admin, Superuser-less Manager fails', async () => {
        await assertFails(write('admNT', 'usersV2/admNT/teamId', 'tA'));
        await assertFails(write('mgrNT', 'usersV2/mgrNT/teamId', 'tA'));
    });
    test('second teamId change by self fails', async () => {
        await assertSucceeds(write('una1', 'usersV2/una1/teamId', 'tA'));
        await assertFails(write('una1', 'usersV2/una1/teamId', 'tB'));
    });
    test('removing own unassigned copies after teamId set succeeds; another member\'s fails', async () => {
        await assertSucceeds(write('una1', 'usersV2/una1/teamId', 'tA'));
        await assertSucceeds(write('una1', 'teamData/unassigned/attendance/Una1', null));
        await assertFails(write('una1', 'teamData/unassigned/attendance/Una2', null));
    });
    test('member-created roster entry with a different name fails; Admin/Superuser may', async () => {
        await assertFails(write('empA3', 'teamData/tA/members/EmpA3', { name: 'Someone Else', order: 1 }));
        await assertSucceeds(write('empA3', 'teamData/tA/members/EmpA3', { name: 'EmpA3', order: 1, uid: 'empA3' }));
        await assertSucceeds(write('admA', 'teamData/tA/members/NewGuy', { name: 'New Guy', order: 9 }));
        await assertSucceeds(write('su', 'teamData/tA/members/NewGal', { name: 'New Gal', order: 10 }));
    });
    test('after teamId is set, own unassigned copies stay readable for move repair; others are not', async () => {
        await assertSucceeds(write('una1', 'usersV2/una1/teamId', 'tA'));
        await assertSucceeds(read('una1', 'teamData/unassigned/members/Una1'));
        await assertSucceeds(read('una1', 'teamData/unassigned/attendance/Una1'));
        await assertSucceeds(read('una1', 'teamData/unassigned/leaves/Una1'));
        await assertFails(read('una1', 'teamData/unassigned/attendance/Una2'));
        await assertFails(read('empA', 'teamData/unassigned/attendance/Una1'));
        await assertFails(read('una1', 'teamData/tB/attendance/Una1'));
    });
    test('interrupted move: after step 2 only, step 3 later succeeds and nothing is lost', async () => {
        await assertSucceeds(write('una1', 'usersV2/una1/teamId', 'tA'));
        // simulated reload: the repair re-reads the leftover unassigned copies first
        await assertSucceeds(read('una1', 'teamData/unassigned/attendance/Una1'));
        // simulated reload: new context, redo step 3
        await assertSucceeds(upd('una1', step3('Una1', 'tA')));
        await assertSucceeds(read('una1', 'teamData/tA/attendance/Una1'));
    });
});

describe('roster uid', () => {
    test('team Admin setting own uid on another member\'s entry fails', async () => {
        await assertFails(write('admA', 'teamData/tA/members/EmpA4/uid', 'admA'));
        await assertFails(write('admA', 'teamData/tA/members/EmpA4', { name: 'EmpA4', order: 5, uid: 'admA' }));
    });
    test('member sets own uid on own key (ok), a different uid (fails)', async () => {
        await assertFails(write('empA5', 'teamData/tA/members/EmpA5/uid', 'someoneElse'));
        await assertSucceeds(write('empA5', 'teamData/tA/members/EmpA5/uid', 'empA5'));
    });
    test('Admin deletes and recreates an entry without uid', async () => {
        await assertSucceeds(write('admA', 'teamData/tA/members/EmpA', null));
        await assertSucceeds(write('admA', 'teamData/tA/members/EmpA', { name: 'EmpA', order: 3 }));
    });
});

describe('terminate', () => {
    test('Admin terminates own-team member in one update', async () => {
        await assertSucceeds(upd('admA', {
            'usersV2/empA/terminated': true,
            'usersV2/empA/terminatedAt': ISO,
            'usersV2/empA/isAdmin': false,
            'teamData/tA/members/EmpA/terminated': true
        }));
    });
    test('Admin cannot terminate a Superuser, self, or another team\'s member', async () => {
        await assertFails(write('admA', 'usersV2/su/terminated', true));
        await assertFails(write('admA', 'usersV2/admA/terminated', true));
        await assertFails(write('admA', 'usersV2/empB/terminated', true));
    });
    test('terminated user is denied everywhere except own profile', async () => {
        await assertSucceeds(read('termA', 'usersV2/termA'));
        await assertFails(read('termA', 'teamData/tA/attendance/TermA'));
        await assertFails(write('termA', 'teamData/tA/attendance/TermA/2024-04-01', true));
        await assertFails(read('termA', 'teams'));
        await assertFails(read('termA', 'holidays'));
        await assertFails(read('termA', 'settings'));
    });
});

describe('Admin-writable flags (parity)', () => {
    test('Admin sets teammate isAdmin false and mustResetPassword true', async () => {
        await assertSucceeds(write('admA', 'usersV2/empA/isAdmin', false));
        await assertSucceeds(write('admA', 'usersV2/empA/mustResetPassword', true));
    });
    test('Admin cannot set isAdmin true, isManager, or clear a teammate\'s mustResetPassword', async () => {
        await assertFails(write('admA', 'usersV2/empA/isAdmin', true));
        await assertFails(write('admA', 'usersV2/empA/isManager', true));
        await assertFails(write('admA', 'usersV2/empA2/mustResetPassword', null));
    });
    test('same writes on another team, Superuser, or self fail', async () => {
        await assertFails(write('admA', 'usersV2/empB/isAdmin', false));
        await assertFails(write('admA', 'usersV2/empB/mustResetPassword', true));
        await assertFails(write('admA', 'usersV2/su/isAdmin', false));
        await assertFails(write('admA', 'usersV2/admA/isAdmin', false));
        await assertFails(write('admA', 'usersV2/admA/mustResetPassword', true));
    });
    test('user clears only own mustResetPassword', async () => {
        await assertSucceeds(write('empA2', 'usersV2/empA2/mustResetPassword', null));
        await assertFails(write('empA', 'usersV2/empA/mustResetPassword', true));
    });
    test('teams/unassigned and teamNames/unassigned writes fail', async () => {
        await assertFails(write('su', 'teams/unassigned', { id: 'unassigned', name: 'X' }));
        await assertFails(write('su', 'teamNames/unassigned', 'X'));
    });
});

describe('node shape', () => {
    test('scalar at attendance/{key} and leaves/{key} fails for self, Admin, Superuser', async () => {
        for (const uid of ['empA', 'admA', 'su']) {
            await assertFails(write(uid, 'teamData/tA/attendance/EmpA', true));
            await assertFails(write(uid, 'teamData/tA/leaves/EmpA', 'leave'));
        }
    });
    test('scalar at holidays fails for Admin (toggle on) and Superuser', async () => {
        await env.withSecurityRulesDisabled((ctx) => ctx.database().ref('settings/adminCanEditHolidays').set(true));
        await assertFails(write('admA', 'holidays', 'x'));
        await assertFails(write('su', 'holidays', true));
    });
    test('deleting those nodes still succeeds', async () => {
        await assertSucceeds(write('empA', 'teamData/tA/attendance/EmpA', null));
        await assertSucceeds(write('admA', 'teamData/tA/leaves/EmpA', null));
        await assertSucceeds(write('su', 'holidays', null));
    });
});

describe('other nodes', () => {
    test('anonymous reads teamNames only', async () => {
        await assertSucceeds(read(null, 'teamNames'));
        await assertFails(read(null, 'teams'));
        await assertFails(read(null, 'holidays'));
        await assertFails(read(null, 'settings'));
        await assertFails(read(null, 'usersV2'));
        await assertFails(read(null, 'teamData/tA/members'));
    });
    test('teams and teamNames: Superuser write only, in one update', async () => {
        await assertSucceeds(upd('su', {
            'teams/tC': { id: 'tC', name: 'Team C', createdBy: 'Super', createdAt: ISO },
            'teamNames/tC': 'Team C'
        }));
        await assertFails(write('admA', 'teams/tD', { id: 'tD', name: 'D' }));
        await assertFails(write('admA', 'teamNames/tD', 'D'));
        await assertFails(write('su', 'teams/tE', { id: 'wrong', name: 'E' }));
    });
    test('holidays write with and without adminCanEditHolidays', async () => {
        await assertFails(write('admA', 'holidays/2024-10-02', { name: 'G' }));
        await assertSucceeds(write('su', 'holidays/2024-10-02', { name: 'G' }));
        await env.withSecurityRulesDisabled((ctx) => ctx.database().ref('settings/adminCanEditHolidays').set(true));
        await assertSucceeds(write('admA', 'holidays/2024-10-03', { name: 'H' }));
        await assertFails(write('empA', 'holidays/2024-10-04', { name: 'I' }));
    });
    test('settings: Superuser only', async () => {
        await assertSucceeds(write('su', 'settings/everyoneSeesAll', true));
        await assertFails(write('admA', 'settings/everyoneSeesAll', true));
        await assertFails(write('su', 'settings/somethingElse', true));
    });
    test('passwordResetRequests', async () => {
        await assertSucceeds(write('admA', 'passwordResetRequests/empA', { requestedBy: 'admA', requestedAt: ISO }));
        await assertFails(write('admB', 'passwordResetRequests/empA', { requestedBy: 'admB', requestedAt: ISO }));
        await assertFails(write('admA', 'passwordResetRequests/empA2', { requestedBy: 'someoneElse', requestedAt: ISO }));
        await assertFails(write('admA', 'passwordResetRequests/su', { requestedBy: 'admA', requestedAt: ISO }));
        await assertFails(read('admA', 'passwordResetRequests'));
        await assertSucceeds(read('su', 'passwordResetRequests'));
    });
    test('usersV2 reads: Superuser all, Admin own team by uid, others own only', async () => {
        await assertSucceeds(read('su', 'usersV2'));
        await assertSucceeds(read('admA', 'usersV2/empA'));
        await assertFails(read('admA', 'usersV2/empB'));
        await assertFails(read('admA', 'usersV2'));
        await assertFails(read('mgrA', 'usersV2/empA'));
        await assertSucceeds(read('empA', 'usersV2/empA'));
        await assertFails(read('empA', 'usersV2/empA2'));
    });
    test('legacy-only nodes and migration are denied to everyone', async () => {
        for (const node of ['appData', 'users', 'admins', 'managers', 'teamMembers', 'memberTeams', 'migration']) {
            await assertFails(read('su', node));
            await assertFails(read('empA', node));
            await assertFails(read(null, node));
            await assertFails(write('su', node + '/x', 'y'));
        }
    });
});

describe('lookup-limit worst cases (acceptance gate, design 2.1)', () => {
    test('Admin writing a member\'s attendance', async () => {
        await assertSucceeds(write('admA', 'teamData/tA/attendance/EmpA/2024-05-01', true));
    });
    test('Manager reading a team', async () => {
        await assertSucceeds(read('mgrA', 'teamData/tA/members'));
        await assertSucceeds(read('mgrA', 'teamData/tA/attendance'));
        await assertSucceeds(read('mgrA', 'teamData/tA/leaves'));
    });
    test('Superuser team move as one multi-path update', async () => {
        await assertSucceeds(upd('su', {
            'teamData/tB/members/EmpA': { name: 'EmpA', order: 5, uid: 'empA' },
            'teamData/tB/attendance/EmpA/2024-01-02': true,
            'teamData/tB/leaves/EmpA/2024-01-03': 'wfh',
            'teamData/tA/members/EmpA': null,
            'teamData/tA/attendance/EmpA': null,
            'teamData/tA/leaves/EmpA': null,
            'usersV2/empA/teamId': 'tB'
        }));
    });
});
