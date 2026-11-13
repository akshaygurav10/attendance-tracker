// ==========================================
// PERMISSIONS (pure client-side authorization checks)
// Decides what the signed-in user may do to a member. Inputs are plain
// profile-like objects ({ name, teamId, isAdmin, isManager, isSuperAdmin }),
// never localStorage, DOM or app globals. The server rules remain the real
// enforcement; these checks decide what the UI offers and refuse early.
// Browser global `AppPermissions`; require()-able from Node for unit tests.
// ==========================================
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.AppPermissions = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const UNASSIGNED = 'unassigned';

    const MSG_SUPER_ONLY = 'Only the Superuser can manage Admins and Managers.';
    const MSG_SUPER_PROTECTED = 'The Superuser account cannot be removed or changed.';
    const MSG_TEAM_ONLY = 'You can only manage members of your own team.';
    const MSG_SELF = 'You cannot do this to your own account.';

    function isSuperProfile(p) { return !!(p && p.isSuperAdmin === true); }
    function isAdminActor(p) { return !!(p && (p.isAdmin === true || p.isSuperAdmin === true)); }
    function isPrivilegedProfile(p) {
        return !!(p && (p.isAdmin === true || p.isManager === true || p.isSuperAdmin === true));
    }

    function teamOf(p, ctx) {
        const t = ctx && ctx.targetTeamId !== undefined ? ctx.targetTeamId : (p && p.teamId);
        return typeof t === 'string' && t && t !== UNASSIGNED ? t : null;
    }
    function sameTeam(actor, target, ctx) {
        const mine = teamOf(actor, null);
        return !!mine && mine === teamOf(target, ctx);
    }
    function isSelf(actor, target, ctx) {
        if (ctx && typeof ctx.isSelf === 'boolean') return ctx.isSelf;
        return !!(actor && target && actor.name && actor.name === target.name);
    }

    // Attendance/leave editing and general scope: Superuser anyone; a team Admin
    // only self and ordinary members of the own team (never other Admins,
    // Managers or the Superuser); everyone else nothing.
    function canAdminMember(actor, target, ctx) {
        if (!actor || !target) return false;
        if (isSuperProfile(actor)) return true;
        if (actor.isAdmin !== true) return false;
        if (isSelf(actor, target, ctx)) return true;
        if (isPrivilegedProfile(target)) return false;
        return sameTeam(actor, target, ctx);
    }

    // First reason an action on this target is refused, or null when none applies.
    function superBlockReason(actor, target, ctx) {
        if (!actor || !target) return MSG_TEAM_ONLY;
        if (isSuperProfile(target) && isSuperProfile(actor)) return MSG_SUPER_PROTECTED;
        if (isSuperProfile(actor)) return null;
        if (isSuperProfile(target) || (isPrivilegedProfile(target) && !isSelf(actor, target, ctx))) return MSG_SUPER_ONLY;
        return null;
    }

    function manageable(actor, target, ctx) {
        return canAdminMember(actor, target, ctx) && superBlockReason(actor, target, ctx) === null;
    }

    // Management actions never apply to the actor's own account.
    function canTerminate(actor, target, ctx) {
        return !isSelf(actor, target, ctx) && manageable(actor, target, ctx);
    }
    function canRestore(actor, target, ctx) {
        return !isSelf(actor, target, ctx) && manageable(actor, target, ctx);
    }
    function canForceReset(actor, target, ctx) {
        return !isSelf(actor, target, ctx) && manageable(actor, target, ctx);
    }
    // Renaming: the Superuser may rename others; nobody else may rename themselves.
    function canRename(actor, target, ctx) {
        return !isSelf(actor, target, ctx) && manageable(actor, target, ctx);
    }
    function canReorder(actor, target, ctx) {
        return canAdminMember(actor, target, ctx);
    }

    // Message for a refused management action, or null when it is allowed.
    function denyReason(actor, target, ctx, allowed) {
        if (allowed) return null;
        if (isSelf(actor, target, ctx)) return isSuperProfile(target) ? MSG_SUPER_PROTECTED : MSG_SELF;
        const why = superBlockReason(actor, target, ctx);
        if (why) return why;
        return MSG_TEAM_ONLY;
    }

    return {
        isPrivilegedProfile, canAdminMember, canTerminate, canRestore, canRename,
        canForceReset, canReorder, superBlockReason, denyReason,
        MESSAGES: Object.freeze({ MSG_SUPER_ONLY, MSG_SUPER_PROTECTED, MSG_TEAM_ONLY, MSG_SELF })
    };
});
