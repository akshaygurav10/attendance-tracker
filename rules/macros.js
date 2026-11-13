'use strict';
// Macro table for database.rules.src.json (design section 7.1).
// Realtime Database rules have no user-defined functions, so the build step
// expands these names into plain rule expressions.
//
// `params` is the number of arguments. A parameterised macro is written in the
// source as NAME(arg). Arguments are simple tokens such as $teamId (no nested
// parentheses). In `body`, {0} is replaced by the argument.
// Expansions that contain operators are wrapped in parentheses so they are
// safe to splice anywhere in a larger expression.

const macros = {
    ME: { params: 0, body: "root.child('usersV2').child(auth.uid)" },
    SI: {
        params: 0,
        body: "(auth != null && ME.child('memberKey').exists() && ME.child('terminated').val() !== true)"
    },
    SU: { params: 0, body: "(SI && ME.child('isSuperAdmin').val() === true)" },
    ADM: {
        params: 1,
        body: "(SI && ME.child('isAdmin').val() === true && ME.child('teamId').val() === {0})"
    },
    MGR: {
        params: 1,
        body: "(SI && ME.child('isManager').val() === true && ME.child('teamId').val() === {0})"
    },
    SELF: { params: 1, body: "(SI && ME.child('memberKey').val() === {0})" },
    BUCKET: {
        params: 1,
        body: "(ME.child('teamId').val() === {0} || (!ME.child('teamId').exists() && {0} === 'unassigned'))"
    },
    TW: {
        params: 1,
        body: "((SU) || (ADM({0})) || (MGR({0})) || (SI && ME.child('teamId').val() === {0} && root.child('settings').child('everyoneSeesAll').val() === true))"
    },
    ADMIN_OF: {
        params: 1,
        body: "(SI && ME.child('isAdmin').val() === true && ME.child('teamId').exists() && ME.child('teamId').val() === root.child('usersV2').child({0}).child('teamId').val() && root.child('usersV2').child({0}).child('isSuperAdmin').val() !== true && auth.uid !== {0})"
    },
    // Raw rule text (not JSON-escaped; the builder works on parsed strings).
    // Test-gated fallback applied (design 7.1, rules/RESULTS.md): the emulator
    // evaluates the control-character range \x00-\x1f\x7f as non-matching, so
    // the range is dropped. Control characters are stripped by the client
    // (secureNameKey) and reported by the migration as data-domain violations.
    KEYRE: { params: 0, body: '/^[^$#\\[\\]\\/.]{1,128}$/' }
};

module.exports = { macros };
