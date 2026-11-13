'use strict';
// Canonical checksums over attendance data (never passwords), design 9 `verify`.
const crypto = require('crypto');

function sha256(lines) {
    return crypto.createHash('sha256').update(lines.slice().sort().join('\n')).digest('hex');
}

// attendance: { teamId: { memberKey: { date: true } } }
function attendanceRows(byTeam) {
    const rows = [];
    Object.keys(byTeam || {}).forEach(t => Object.keys(byTeam[t] || {}).forEach(k =>
        Object.keys(byTeam[t][k] || {}).forEach(d => rows.push([t, k, d].join('\u0001')))));
    return rows;
}

function leaveRows(byTeam) {
    const rows = [];
    Object.keys(byTeam || {}).forEach(t => Object.keys(byTeam[t] || {}).forEach(k =>
        Object.keys(byTeam[t][k] || {}).forEach(d => rows.push([t, k, d, byTeam[t][k][d]].join('\u0001')))));
    return rows;
}

function summarize(byTeamAttendance, byTeamLeaves) {
    const a = attendanceRows(byTeamAttendance);
    const l = leaveRows(byTeamLeaves);
    return { attendanceCount: a.length, attendanceSum: sha256(a), leaveCount: l.length, leaveSum: sha256(l) };
}

module.exports = { sha256, attendanceRows, leaveRows, summarize };
