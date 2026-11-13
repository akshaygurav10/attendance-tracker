// ==========================================
// ATTENDANCE TRACKER - Main Application
// ==========================================

// Security mode (design 4.0). Only the exact string "secure" in firebase-config.js
// enables secure mode; anything else, or an old cached config without the flag,
// runs the legacy code paths unchanged. Use MODE only, never SECURITY_MODE.
const MODE = (typeof SECURITY_MODE !== 'undefined' && SECURITY_MODE === 'secure') ? 'secure' : 'legacy';

const DEFAULT_TEAM_MEMBERS = [];

// Load team members from Firebase or use defaults
function loadTeamMembers() {
    const saved = localStorage.getItem('attendance_team_members');
    if (saved) {
        const list = JSON.parse(saved);
        // Filter out null/undefined entries
        return list.filter(m => m && m.trim() !== '');
    }
    return [];
}

function saveTeamMembers(members) {
    if (MODE === 'secure') return; // secure mode never writes legacy nodes
    // Filter out null/undefined entries before saving
    members = members.filter(m => m && m.trim() !== '');
    localStorage.setItem('attendance_team_members', JSON.stringify(members));
    if (typeof database !== 'undefined') {
        database.ref('teamMembers').set(members);
    }
}

let TEAM_MEMBERS = loadTeamMembers();

const AVATAR_COLORS = [
    "#0052CC", "#00875A", "#FF5630", "#6554C0", "#00B8D9",
    "#FF991F", "#403294", "#008DA6", "#DE350B", "#006644",
    "#5243AA", "#0747A6", "#FF8B00", "#172B4D", "#4C9AFF"
];

const REQUIRED_PERCENTAGE = 60;

// ==========================================
// USER / PERMISSIONS / AUTH
// ==========================================

// Legacy mode only: the Superuser is the one users/* record with isSuperAdmin === true.
// Held in memory (never persisted) and filled by loadLegacySuper(); until then nobody is
// the Superuser (fails closed). Secure mode takes this from the signed-in usersV2 profile.
let LEGACY_SUPER_NAME = null;

async function loadLegacySuper(knownUsers) {
    if (MODE === 'secure' || typeof database === 'undefined') return;
    try {
        const users = knownUsers || (await database.ref('users').once('value')).val() || {};
        if (!knownUsers && !getCurrentUser()) return; // signed out while loading
        const supers = Object.keys(users).filter(k => users[k] && users[k].isSuperAdmin === true);
        LEGACY_SUPER_NAME = supers.length === 1 ? (users[supers[0]].name || supers[0].replace(/___DOT___/g, '.')) : null;
    } catch (e) {
        LEGACY_SUPER_NAME = null;
    }
}

// Is this member the Superuser? Secure: private profile data. Legacy: loaded record.
function memberIsSuper(name) {
    if (!name) return false;
    if (MODE === 'secure') return SecureMode.memberIsSuper(name);
    return !!LEGACY_SUPER_NAME && name === LEGACY_SUPER_NAME;
}

// SHA-256 hashing using browser's Web Crypto API
async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function getAdminList() {
    const saved = localStorage.getItem('attendance_admin_list');
    if (saved) return JSON.parse(saved);
    return [];
}

function saveAdminList(admins) {
    if (MODE === 'secure') return; // secure mode never writes legacy nodes
    localStorage.setItem('attendance_admin_list', JSON.stringify(admins));
    if (typeof database !== 'undefined') {
        database.ref('admins').set(admins);
    }
}

let ADMIN_MEMBERS = getAdminList();

function getCurrentUser() {
    // Secure mode: derived from the Firebase Auth session and usersV2 profile, never localStorage
    if (MODE === 'secure') return SecureMode.currentUserName();
    return localStorage.getItem('attendance_current_user');
}

function setCurrentUser(name) {
    localStorage.setItem('attendance_current_user', name);
}

function isAdmin() {
    if (MODE === 'secure') return SecureMode.isAdminUser();
    const user = getCurrentUser();
    if (!user) return false;
    if (memberIsSuper(user)) return true;
    return ADMIN_MEMBERS.includes(user);
}

// ------------------------------------------
// Teams / Manager role (in-memory, synced from Firebase, cleared on logout)
// NOTE: these checks run in the browser only. See DEPLOYMENT.md for the
// database rules needed for real enforcement.
// ------------------------------------------
let TEAMS = {};         // teamId -> { id, name, createdBy, createdAt }
let MEMBER_TEAMS = {};  // sanitized member name -> teamId
let MANAGERS = [];      // full names with the Manager flag

// Open question (see REQUIREMENTS-teams-roles.md): may team Admins edit the
// GLOBAL holidays list? Default false = Superuser only. Flip to true to allow.
let ADMIN_CAN_EDIT_HOLIDAYS = false;

function nameKey(name) {
    return String(name).replace(/\./g, '___DOT___');
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function isSuperUser() {
    if (MODE === 'secure') return SecureMode.isSuper();
    return memberIsSuper(getCurrentUser());
}

function isManager() {
    if (MODE === 'secure') return SecureMode.isManagerUser();
    const user = getCurrentUser();
    return !!user && Array.isArray(MANAGERS) && MANAGERS.includes(user);
}

function getMemberTeamId(name) {
    if (MODE === 'secure') return SecureMode.memberTeamId(name);
    if (!name) return null;
    return (MEMBER_TEAMS && MEMBER_TEAMS[nameKey(name)]) || null;
}

function getMyTeamId() {
    return getMemberTeamId(getCurrentUser());
}

function getTeamName(teamId) {
    return (teamId && TEAMS && TEAMS[teamId] && TEAMS[teamId].name) || null;
}

// Team label for the signed-in user: own team, 'All Teams' for the Superuser only, else 'No team'
function getMyTeamLabel() {
    if (!getCurrentUser()) return '';
    if (isSuperUser()) return 'All Teams';
    return getTeamName(getMyTeamId()) || 'No team';
}

// Admin who is not the Superuser: scoped to their own team
/** Only ordinary users may pick their own first team; Admins/Superuser are assigned by the Superuser. */
function canSelfAssignTeam(name, userData) {
    if (MODE === 'secure') return SecureMode.canSelfAssign(); // also excludes Managers (Q13)
    if (!name || memberIsSuper(name) || (userData && userData.isSuperAdmin === true)) return false;
    return !(ADMIN_MEMBERS.includes(name) || (userData && userData.isAdmin));
}

function isTeamAdmin() {
    return isAdmin() && !isSuperUser();
}

// Members the current user administers (edit/manage/report).
// Superuser: everyone. Admin: self + own team (self only when unassigned).
function getAdminScopeMembers() {
    if (MODE === 'secure') return SecureMode.scopeMembers(); // private roster, not TEAM_MEMBERS
    const user = getCurrentUser();
    if (!user || !isAdmin()) return [];
    if (isSuperUser()) return [...TEAM_MEMBERS];
    const myTeam = getMyTeamId();
    return TEAM_MEMBERS.filter(m => m === user || (!!myTeam && getMemberTeamId(m) === myTeam));
}

// May the current user administer this member? Checked by every action function.
function canAdminMember(name) {
    if (MODE === 'secure') return SecureMode.canAdminMember(name); // private profile data only
    const user = getCurrentUser();
    if (!name || !user) return false;
    if (isSuperUser()) return true;
    if (memberIsSuper(name)) return false;
    if (!isAdmin()) return false;
    if (name === user) return true;
    const myTeam = getMyTeamId();
    return !!myTeam && getMemberTeamId(name) === myTeam;
}

// May the current user administer members of this team id?
function canAdminTeamId(teamId) {
    if (isSuperUser()) return true;
    if (!isAdmin()) return false;
    const myTeam = getMyTeamId();
    return !!teamId && !!myTeam && teamId === myTeam;
}

function everyoneSeesAllEnabled() {
    const toggle = document.getElementById('toggleVisibility');
    return !!(toggle && toggle.checked);
}

// Members the current user may see. Superuser: all. Admin and Manager: own team + self.
// Others: self, plus own team when "everyone sees everyone" is on.
// A user with no team sees only themselves (never falls back to global).
function getVisibleMembers() {
    const user = getCurrentUser();
    if (!user) return [];
    if (isSuperUser()) return [...TEAM_MEMBERS];
    const myTeam = getMyTeamId();
    const teamScoped = !!myTeam && (isAdmin() || isManager() || everyoneSeesAllEnabled());
    return TEAM_MEMBERS.filter(m => m === user || (teamScoped && getMemberTeamId(m) === myTeam));
}

function canViewMember(name) {
    return !!name && getVisibleMembers().includes(name);
}

function canViewSummary() {
    return isAdmin() || isManager() || everyoneSeesAllEnabled();
}

function canManageHolidays() {
    // Secure mode: the server flag settings/adminCanEditHolidays is authoritative (Q1)
    if (MODE === 'secure') return isSuperUser() || (SecureMode.adminCanEditHolidays() && isAdmin());
    return isSuperUser() || (ADMIN_CAN_EDIT_HOLIDAYS && isAdmin());
}
function canImportData() { return isSuperUser(); }
function canManageTeam() { return isAdmin(); }
function canUseReports() { return isAdmin(); }
function canManageTeams() { return isSuperUser(); }
function canAssignRoles() { return isSuperUser(); }

function denyAction(message) {
    alert('âš ï¸ ' + message);
}

// ==========================================
// USERNAME GENERATION (Fix 5)
// ==========================================

function generateUsername(fullName) {
    if (!fullName || fullName.trim() === '') return '';
    const parts = fullName.trim().split(/\s+/);
    if (parts.length === 1) {
        return parts[0].toLowerCase().replace(/\./g, '');
    }
    const firstName = parts[0].replace(/\./g, '').toLowerCase();
    const lastName = parts[parts.length - 1].replace(/\./g, '').toLowerCase();
    return firstName[0] + lastName;
}

async function generateUniqueUsername(fullName) {
    const baseUsername = generateUsername(fullName);
    if (!baseUsername) return '';

    if (typeof database === 'undefined') return baseUsername;

    // Check if username already taken
    const snapshot = await database.ref('users').once('value');
    const users = snapshot.val() || {};
    const existingUsernames = [];
    for (const key in users) {
        if (users[key].username) {
            existingUsernames.push(users[key].username);
        }
    }

    if (!existingUsernames.includes(baseUsername)) {
        return baseUsername;
    }

    // Try first 2 chars of first name + last name
    const parts = fullName.trim().split(/\s+/);
    const firstName = parts[0].replace(/\./g, '').toLowerCase();
    const lastName = parts[parts.length - 1].replace(/\./g, '').toLowerCase();
    const altUsername = firstName.substring(0, 2) + lastName;

    if (!existingUsernames.includes(altUsername)) {
        return altUsername;
    }

    // Append random number
    let uniqueUsername = altUsername;
    while (existingUsernames.includes(uniqueUsername)) {
        uniqueUsername = altUsername + Math.floor(Math.random() * 100);
    }
    return uniqueUsername;
}

function canEdit(member) {
    // Superuser: anyone. Admin: own team. Everyone else (Manager included): own data only.
    const currentUser = getCurrentUser();
    if (!currentUser || !member) return false;
    return currentUser === member || canAdminMember(member);
}

// ==========================================
// DATA MANAGEMENT (Firebase + localStorage)
// ==========================================

class AttendanceData {
    constructor(onDataLoaded) {
        this.onDataLoaded = onDataLoaded;
        this.data = this.getDefaultData();
        this.firebaseReady = false;
        this._listeners = [];
        // Only touch stored/remote data when a user is signed in
        if (getCurrentUser()) {
            this.loadLocal();
            this.startListeners();
            // Legacy: learn who the Superuser is from the server record (no hardcoded name)
            loadLegacySuper().then(() => { if (this.onDataLoaded) this.onDataLoaded(); });
        }
    }

    // Track a realtime listener so it can be detached on logout
    _listen(path, cb, errCb) {
        const ref = database.ref(path);
        if (errCb) ref.on('value', cb, errCb); else ref.on('value', cb);
        this._listeners.push({ ref, cb });
    }

    stopListeners() {
        this._listeners.forEach(l => l.ref.off('value', l.cb));
        this._listeners = [];
        this.firebaseReady = false;
    }

    reset() {
        this.data = this.getDefaultData();
    }

    getDefaultData() {
        return {
            attendance: {},
            holidays: [],
            leaves: {},
            lastUpdated: new Date().toISOString()
        };
    }

    loadLocal() {
        // Secure mode keeps no team data in localStorage (design 4.4)
        if (MODE === 'secure') { this.data = this.getDefaultData(); return; }
        // Load from localStorage first (immediate)
        const saved = localStorage.getItem('attendance_tracker_data');
        if (saved) {
            this.data = JSON.parse(saved);
            if (!this.data.leaves) this.data.leaves = {};
            if (!this.data.holidays) this.data.holidays = [];
            if (!this.data.attendance) this.data.attendance = {};
        } else {
            this.data = this.getDefaultData();
            this.initDefaultHolidays();
        }
    }

    startListeners() {
        if (MODE === 'secure') { SecureMode.startListeners(this); return; }
        // Sync with Firebase
        if (typeof database !== 'undefined' && this._listeners.length === 0) {
            this._listen('appData', (snapshot) => {
                const firebaseData = snapshot.val();
                if (firebaseData) {
                    // Decode sanitized keys back to original names
                    if (firebaseData.attendance) {
                        const decoded = {};
                        for (const key in firebaseData.attendance) {
                            decoded[key.replace(/___DOT___/g, '.')] = firebaseData.attendance[key];
                        }
                        firebaseData.attendance = decoded;
                    }
                    if (firebaseData.leaves) {
                        const decoded = {};
                        for (const key in firebaseData.leaves) {
                            decoded[key.replace(/___DOT___/g, '.')] = firebaseData.leaves[key];
                        }
                        firebaseData.leaves = decoded;
                    }
                    this.data = firebaseData;
                    if (!this.data.leaves) this.data.leaves = {};
                    if (!this.data.holidays) this.data.holidays = [];
                    if (!this.data.attendance) this.data.attendance = {};
                    // Keep localStorage in sync
                    localStorage.setItem('attendance_tracker_data', JSON.stringify(this.data));
                } else if (!this.firebaseReady) {
                    // First time â€” push local data to Firebase
                    this.saveToFirebase();
                }
                this.firebaseReady = true;
                if (this.onDataLoaded) this.onDataLoaded();
            }, (error) => {
                console.error('Firebase read failed:', error);
            });

            // Sync team members
            this._listen('teamMembers', (snapshot) => {
                const members = snapshot.val();
                if (members && Array.isArray(members)) {
                    TEAM_MEMBERS = members.filter(m => m && m.trim() !== '');
                    localStorage.setItem('attendance_team_members', JSON.stringify(TEAM_MEMBERS));
                    if (this.onDataLoaded) this.onDataLoaded();
                } else {
                    // No team members in Firebase â€” start fresh
                    TEAM_MEMBERS = [];
                    localStorage.setItem('attendance_team_members', JSON.stringify([]));
                }
            });

            // Sync admin list
            this._listen('admins', (snapshot) => {
                const admins = snapshot.val();
                if (admins && Array.isArray(admins)) {
                    ADMIN_MEMBERS = admins;
                    localStorage.setItem('attendance_admin_list', JSON.stringify(admins));
                    if (this.onDataLoaded) this.onDataLoaded();
                }
            });

            // Sync teams, member->team mirror and manager flags
            this._listen('teams', (snapshot) => {
                const val = snapshot.val();
                TEAMS = (val && typeof val === 'object') ? val : {};
                if (this.onDataLoaded) this.onDataLoaded();
            });
            this._listen('memberTeams', (snapshot) => {
                const val = snapshot.val();
                MEMBER_TEAMS = (val && typeof val === 'object') ? val : {};
                if (this.onDataLoaded) this.onDataLoaded();
            });
            this._listen('managers', (snapshot) => {
                const val = snapshot.val();
                MANAGERS = Array.isArray(val) ? val.filter(m => m) : [];
                if (this.onDataLoaded) this.onDataLoaded();
            });

            // Sync visibility setting
            this._listen('settings/everyoneSeesAll', (snapshot) => {
                const val = snapshot.val();
                const toggle = document.getElementById('toggleVisibility');
                if (toggle) toggle.checked = val === true;
                if (this.onDataLoaded) this.onDataLoaded();
            });
        }
    }

    save() {
        if (MODE === 'secure') return; // secure mode writes granular paths instead of the blob
        if (!getCurrentUser()) return;
        this.data.lastUpdated = new Date().toISOString();
        localStorage.setItem('attendance_tracker_data', JSON.stringify(this.data));
        this.saveToFirebase();
    }

    saveToFirebase() {
        if (MODE === 'secure') return; // never writes appData in secure mode
        if (typeof database !== 'undefined') {
            // Guard: never overwrite with empty data if we haven't loaded from Firebase yet
            if (!this.firebaseReady) return;
            
            // Guard: don't save if attendance is empty and we expect data
            const hasData = this.data.attendance && Object.keys(this.data.attendance).length > 0;
            const hasHolidays = this.data.holidays && this.data.holidays.length > 0;
            if (!hasData && !hasHolidays && this.firebaseReady) {
                // Only save if explicitly intended (not accidental wipe)
                console.warn('Skipping Firebase save: data appears empty');
                return;
            }

            const sanitized = JSON.parse(JSON.stringify(this.data));
            
            if (sanitized.attendance) {
                const cleanAttendance = {};
                for (const key in sanitized.attendance) {
                    cleanAttendance[key.replace(/\./g, '___DOT___')] = sanitized.attendance[key];
                }
                sanitized.attendance = cleanAttendance;
            }
            
            if (sanitized.leaves) {
                const cleanLeaves = {};
                for (const key in sanitized.leaves) {
                    cleanLeaves[key.replace(/\./g, '___DOT___')] = sanitized.leaves[key];
                }
                sanitized.leaves = cleanLeaves;
            }

            const indicator = document.getElementById('syncIndicator');
            database.ref('appData').set(sanitized).then(() => {
                if (indicator) {
                    indicator.textContent = 'ðŸŸ¢ Synced';
                    indicator.className = 'sync-indicator connected';
                    indicator.style.fontSize = '12px';
                }
            }).catch((error) => {
                console.error('Firebase save failed:', error);
                if (indicator) {
                    indicator.textContent = 'ðŸ”´ ' + error.message;
                    indicator.className = 'sync-indicator disconnected';
                    indicator.style.fontSize = '12px';
                }
            });
        }
    }

    initDefaultHolidays() {
        this.data.holidays = [
            { date: "2026-01-26", name: "Republic Day" },
            { date: "2026-03-10", name: "Holi" },
            { date: "2026-03-30", name: "Id-ul-Fitr" },
            { date: "2026-04-02", name: "Ram Navami" },
            { date: "2026-04-14", name: "Dr. Ambedkar Jayanti" },
            { date: "2026-05-01", name: "May Day" },
            { date: "2026-05-24", name: "Buddha Purnima" },
            { date: "2026-06-06", name: "Id-ul-Zuha" },
            { date: "2026-07-06", name: "Muharram" },
            { date: "2026-08-15", name: "Independence Day" },
            { date: "2026-09-04", name: "Milad-un-Nabi" },
            { date: "2026-10-02", name: "Gandhi Jayanti" },
            { date: "2026-10-20", name: "Dussehra" },
            { date: "2026-11-08", name: "Diwali" },
            { date: "2026-11-09", name: "Diwali (Day 2)" },
            { date: "2026-11-27", name: "Guru Nanak Jayanti" },
            { date: "2026-12-25", name: "Christmas" }
        ];
        // Only save to localStorage, not Firebase (prevents overwriting team data)
        localStorage.setItem('attendance_tracker_data', JSON.stringify(this.data));
    }

    markAttendance(member, date, present) {
        if (!canEdit(member)) { denyAction('You do not have permission to edit this member\'s attendance.'); return; }
        if (MODE === 'secure') { SecureMode.markAttendance(this, member, date, present); return; }
        if (!this.data.attendance) this.data.attendance = {};
        if (!this.data.attendance[member]) {
            this.data.attendance[member] = {};
        }
        if (present) {
            this.data.attendance[member][date] = true;
        } else {
            delete this.data.attendance[member][date];
            // Clean up empty objects
            if (Object.keys(this.data.attendance[member]).length === 0) {
                delete this.data.attendance[member];
            }
        }
        this.save();
    }

    isPresent(member, date) {
        return !!(this.data.attendance[member] && this.data.attendance[member][date]);
    }

    // --- Leave / Exception / WFH ---
    markLeave(member, date, type) {
        // type: "leave", "wfh", "exception"
        if (!canEdit(member)) { denyAction('You do not have permission to edit this member\'s attendance.'); return; }
        if (MODE === 'secure') { SecureMode.markLeave(this, member, date, type); return; }
        if (!this.data.leaves[member]) {
            this.data.leaves[member] = {};
        }
        this.data.leaves[member][date] = type;
        // Remove attendance mark if exists
        if (this.data.attendance[member]) {
            delete this.data.attendance[member][date];
        }
        this.save();
    }

    removeLeave(member, date) {
        if (!canEdit(member)) { denyAction('You do not have permission to edit this member\'s attendance.'); return; }
        if (MODE === 'secure') { SecureMode.removeLeave(this, member, date); return; }
        if (this.data.leaves[member]) {
            delete this.data.leaves[member][date];
            this.save();
        }
    }

    getLeaveType(member, date) {
        if (this.data.leaves[member] && this.data.leaves[member][date]) {
            return this.data.leaves[member][date];
        }
        return null;
    }

    isOnLeave(member, date) {
        return !!(this.data.leaves[member] && this.data.leaves[member][date]);
    }

    addHoliday(date, name) {
        if (!canManageHolidays()) { denyAction('You do not have permission to manage holidays.'); return; }
        if (MODE === 'secure') { SecureMode.addHoliday(this, date, name); return; }
        if (!this.data.holidays.find(h => h.date === date)) {
            this.data.holidays.push({ date, name });
            this.data.holidays.sort((a, b) => a.date.localeCompare(b.date));
            this.save();
        }
    }

    removeHoliday(date) {
        if (!canManageHolidays()) { denyAction('You do not have permission to manage holidays.'); return; }
        if (MODE === 'secure') { SecureMode.removeHoliday(this, date); return; }
        this.data.holidays = this.data.holidays.filter(h => h.date !== date);
        this.save();
    }

    isHoliday(date) {
        return this.data.holidays.some(h => h.date === date);
    }

    getHolidayName(date) {
        const h = this.data.holidays.find(h => h.date === date);
        return h ? h.name : '';
    }

    isWeekend(date) {
        const d = new Date(date + 'T00:00:00');
        const day = d.getDay();
        return day === 0 || day === 6;
    }

    getWorkingDays(year, month) {
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        let workingDays = 0;
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            if (!this.isWeekend(dateStr) && !this.isHoliday(dateStr)) {
                workingDays++;
            }
        }
        return workingDays;
    }

    // Working days for a specific member (excludes their leaves/exceptions/wfh/wfh-email)
    getEffectiveWorkingDays(member, year, month) {
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        let workingDays = 0;
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            if (!this.isWeekend(dateStr) && !this.isHoliday(dateStr)) {
                const leaveType = this.getLeaveType(member, dateStr);
                if (leaveType === 'leave' || leaveType === 'exception' || leaveType === 'wfh-email') {
                    continue;
                }
                workingDays++;
            }
        }
        return workingDays;
    }

    getAttendanceCount(member, year, month) {
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        let count = 0;
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            if (this.isPresent(member, dateStr)) {
                count++;
            }
            // "Planning to Come" counts same as Present
            if (this.getLeaveType(member, dateStr) === 'planned') {
                count++;
            }
        }
        return count;
    }

    getAttendancePercentage(member, year, month) {
        const workingDays = this.getEffectiveWorkingDays(member, year, month);
        if (workingDays === 0) return 0;
        const attended = this.getAttendanceCount(member, year, month);
        return Math.round((attended / workingDays) * 100);
    }

    // memberFilter (array of names) limits attendance/leaves to those members; holidays are global
    exportJSON(memberFilter) {
        if (!Array.isArray(memberFilter)) return JSON.stringify(this.data, null, 2);
        const pick = src => {
            const out = {};
            memberFilter.forEach(m => { if (src && src[m] !== undefined) out[m] = src[m]; });
            return out;
        };
        return JSON.stringify({
            ...this.data,
            attendance: pick(this.data.attendance),
            leaves: pick(this.data.leaves)
        }, null, 2);
    }

    importJSON(jsonStr) {
        if (!canImportData()) { denyAction('Only the Superuser can import data.'); return false; }
        if (MODE === 'secure') return SecureMode.importJSON(this, jsonStr);
        try {
            const imported = JSON.parse(jsonStr);
            if (imported.attendance && imported.holidays) {
                this.data = imported;
                this.save();
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }
}

// ==========================================
// APP CONTROLLER
// ==========================================

class App {
    constructor() {
        this.currentDate = new Date();
        this.currentYear = this.currentDate.getFullYear();
        this.currentMonth = this.currentDate.getMonth();
        this.currentView = 'calendar';
        this.sortColumn = null;
        this.sortDirection = 'asc';

        // Initialize data with callback for when Firebase data loads
        this.data = new AttendanceData(() => this.onDataUpdate());
        this.selectedMember = TEAM_MEMBERS[0];

        this.init();
    }

    onDataUpdate() {
        if (!getCurrentUser()) return;
        // Re-render when Firebase sends new data (roles/teams may have changed too)
        this.applyRoleVisibility();
        this.ensureViewAllowed();
        this.ensureSelectedVisible();
        this.renderTeamList();
        if (this.currentView === 'calendar') this.renderCalendar();
        else if (this.currentView === 'summary') this.renderSummary();
        else if (this.currentView === 'holiday') this.renderHolidays();
        else if (this.currentView === 'team') this.renderTeamManagement();
    }

    // Whether the given view is allowed for the current user
    isViewAllowed(view) {
        if (view === 'holiday') return canManageHolidays();
        if (view === 'team') return canManageTeam();
        if (view === 'summary') return canViewSummary();
        return true;
    }

    ensureViewAllowed() {
        if (!this.isViewAllowed(this.currentView)) this.switchView('calendar');
    }

    // Never keep a member selected that the current user may not see
    ensureSelectedVisible() {
        const user = getCurrentUser();
        if (!user) return;
        if (!this.selectedMember || !canViewMember(this.selectedMember)) {
            const visible = getVisibleMembers();
            this.selectedMember = visible.includes(user) ? user : (visible[0] || user);
        }
    }

    init() {
        if (MODE === 'secure') { SecureMode.init(this); return; }
        this.loadTheme();
        const currentUser = getCurrentUser();
        if (currentUser && TEAM_MEMBERS.includes(currentUser)) {
            this.unlockApp();
            this.showUserSelection();
            this.renderTeamList();
            this.renderCalendar();
            this.bindEvents();
            this.updateUIPermissions();
            this.checkEmailReminder();
        } else {
            // Not signed in (or stale session): show only the login view
            this.bindEvents();
            this.lockApp();
        }
    }

    // Reveal the app for the signed-in user and start data sync
    unlockApp() {
        if (MODE === 'secure') { SecureMode.unlockApp(this); return; }
        document.body.classList.remove('auth-locked');
        this.data.loadLocal();
        this.data.startListeners();
    }

    // Return to a clean logged-out state: nothing from the previous user remains
    lockApp() {
        // Secure mode: also sign out of Firebase Auth and drop the profile (design 4.4)
        if (MODE === 'secure') SecureMode.beforeLock();
        document.body.classList.add('auth-locked');

        // Stop realtime sync and drop in-memory data
        this.data.stopListeners();
        this.data.reset();
        TEAM_MEMBERS = [];
        ADMIN_MEMBERS = [];
        LEGACY_SUPER_NAME = null;
        TEAMS = {};
        MEMBER_TEAMS = {};
        MANAGERS = [];
        this.selectedMember = '';
        this.currentView = 'calendar';
        this.sortColumn = null;
        this.sortDirection = 'asc';

        // Clear persisted personal data (keep theme and reminder_* flags)
        [
            'attendance_current_user', 'attendance_tracker_data', 'attendance_team_members',
            'attendance_admin_list', 'attendance_remembered_user', 'attendance_remembered_pass'
        ].forEach(k => localStorage.removeItem(k));
        sessionStorage.clear();

        // Remove transient UI and close app modals
        const menu = document.getElementById('dayContextMenu');
        if (menu) menu.remove();
        ['syncModal', 'emailModal'].forEach(id => {
            const m = document.getElementById(id);
            if (m) m.classList.remove('active');
        });

        // Empty every container that renders attendance / user data
        ['teamList', 'calendarGrid', 'attendanceStats', 'viewingInfo', 'summaryBody',
         'holidayList', 'teamMemberList', 'teamsAdminList', 'reportDashboard', 'currentUserDisplay',
         'currentMonthYear', 'summaryMonthYear', 'syncStatus', 'teamHeadingLabel'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        });

        // Reset to calendar view
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.querySelectorAll('.btn-sidebar').forEach(b => b.classList.remove('active'));
        const cv = document.getElementById('calendarView');
        if (cv) cv.classList.add('active');
        const cb = document.getElementById('btnCalendarView');
        if (cb) cb.classList.add('active');

        // Clear all form fields and messages
        ['loginUsername', 'loginPassword', 'registerName', 'registerPassword', 'registerConfirm',
         'memberName', 'holidayDate', 'holidayName', 'newTeamName'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        ['rememberMe', 'toggleVisibility'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.checked = false;
        });
        ['loginError', 'registerError'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = '';
        });
        ['loginPassword', 'registerPassword'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.type = 'password';
        });
        ['toggleLoginPw', 'toggleRegPw'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = 'ðŸ‘ï¸';
        });

        // Show only the login panel
        document.getElementById('loginForm').style.display = 'block';
        document.getElementById('registerForm').style.display = 'none';
        document.getElementById('forgotForm').style.display = 'none';
        const title = document.getElementById('authModalTitle');
        if (title) title.textContent = 'ðŸ” Login';
        document.getElementById('userModal').classList.add('active');

        // Permission-bearing UI off until the next login recomputes it
        this.applyRoleVisibility();

        // Team picker: drop old options, then reload team NAMES only (no personal data)
        this.clearTeamOptions();
        this.loadTeamOptions();
    }

    clearTeamOptions() {
        ['loginTeam', 'registerTeam'].forEach(id => {
            const sel = document.getElementById(id);
            if (sel) sel.innerHTML = '';
        });
    }

    // Pre-auth: reads only the `teams` node and renders team names via textContent
    async loadTeamOptions() {
        const loginSel = document.getElementById('loginTeam');
        const regSel = document.getElementById('registerTeam');
        if (MODE === 'secure') return SecureMode.loadTeamOptions(); // reads the public teamNames only
        if (!loginSel || !regSel || typeof database === 'undefined') return;
        let teams = {};
        try {
            const snap = await database.ref('teams').once('value');
            teams = snap.val() || {};
        } catch (e) {
            return; // e.g. rules restrict public reads: users pick a team after login instead
        }
        if (getCurrentUser()) return; // logged in meanwhile: do not populate login-screen controls
        const list = Object.keys(teams)
            .filter(id => teams[id] && typeof teams[id].name === 'string')
            .map(id => ({ id, name: teams[id].name }))
            .sort((a, b) => a.name.localeCompare(b.name));
        const build = (sel, placeholder) => {
            sel.innerHTML = '';
            const first = document.createElement('option');
            first.value = '';
            first.textContent = placeholder;
            sel.appendChild(first);
            list.forEach(t => {
                const o = document.createElement('option');
                o.value = t.id;
                o.textContent = t.name;
                sel.appendChild(o);
            });
        };
        build(loginSel, list.length ? 'Keep my current team' : 'No teams yet');
        build(regSel, list.length ? 'Select your team' : 'No teams yet');
    }

    showUserSelection() {
        const currentUser = getCurrentUser();
        if (currentUser && TEAM_MEMBERS.includes(currentUser)) {
            document.getElementById('userModal').classList.remove('active');
            this.selectedMember = currentUser;
            this.updateUserDisplay();
            this.updateUIPermissions();
            return;
        }
        // Show login modal and fill remembered credentials
        const rememberedUser = localStorage.getItem('attendance_remembered_user');
        const rememberedPass = localStorage.getItem('attendance_remembered_pass');
        if (rememberedUser) {
            document.getElementById('loginUsername').value = rememberedUser;
            if (rememberedPass) {
                document.getElementById('loginPassword').value = rememberedPass;
                document.getElementById('rememberMe').checked = true;
            }
        }
    }

    populateLoginDropdown() {
        // No dropdown anymore â€” just clear the input
        const input = document.getElementById('loginUsername');
        if (input) input.value = '';
    }

    async refreshTeamMembers() {
        if (typeof database === 'undefined') return;
        const snap = await database.ref('teamMembers').once('value');
        const members = snap.val();
        if (members && Array.isArray(members)) {
            TEAM_MEMBERS = members.filter(m => m && m.trim() !== '');
        }
    }

    async handleLogin() {
        if (MODE === 'secure') return SecureMode.login(this);
        const usernameInput = document.getElementById('loginUsername').value.trim();
        const password = document.getElementById('loginPassword').value;
        const errorEl = document.getElementById('loginError');

        if (!usernameInput) { errorEl.textContent = 'Please enter your username.'; return; }
        if (!password) { errorEl.textContent = 'Please enter your password.'; return; }

        const hash = await hashPassword(password);

        if (typeof database !== 'undefined') {
            try {
                // Team list is not preloaded while logged out; fetch it so later saves don't overwrite it
                await this.refreshTeamMembers();
                // Look up user by username or full name
                const usersSnapshot = await database.ref('users').once('value');
                const users = usersSnapshot.val() || {};
                let matchedUser = null;
                let sanitizedName = null;
                let userData = null;

                for (const key in users) {
                    const u = users[key];
                    const uname = u.username || '';
                    const fullName = u.name || key.replace(/___DOT___/g, '.');
                    // Match by username or full name (case insensitive)
                    if (uname.toLowerCase() === usernameInput.toLowerCase() ||
                        fullName.toLowerCase() === usernameInput.toLowerCase()) {
                        matchedUser = fullName;
                        sanitizedName = key;
                        userData = u;
                        break;
                    }
                }

                if (!matchedUser) {
                    errorEl.textContent = 'Username not found. Check spelling or register.';
                    return;
                }

                if (userData && userData.terminated === true) {
                    errorEl.textContent = 'Your account has been terminated. Contact admin.';
                    return;
                }

                const storedHash = userData ? userData.passwordHash : null;

                if (!storedHash) {
                    errorEl.textContent = 'User not registered. Please register first.';
                    return;
                } else if (hash !== storedHash) {
                    errorEl.textContent = 'Incorrect password.';
                    return;
                }

                // Password accepted: learn the Superuser from the server records we already read
                await loadLegacySuper(users);

                // Check if must reset password (restored user)
                if (userData && userData.mustResetPassword === true) {
                    let newPassword = null;
                    while (true) {
                        newPassword = prompt('Your account was restored. Please set a new password (min 4 characters):');
                        if (newPassword === null) return;
                        if (newPassword.length >= 4) break;
                        alert('Password must be at least 4 characters. Try again.');
                    }
                    const confirmPassword = prompt('Confirm new password:');
                    if (newPassword !== confirmPassword) {
                        errorEl.textContent = 'Passwords do not match. Try again.';
                        return;
                    }
                    const newHash = await hashPassword(newPassword);
                    await database.ref('users/' + sanitizedName + '/passwordHash').set(newHash);
                    await database.ref('users/' + sanitizedName + '/mustResetPassword').remove();
                }

                // Generate username for existing users who don't have one
                if (userData && !userData.username) {
                    const uname = await generateUniqueUsername(matchedUser);
                    await database.ref('users/' + sanitizedName + '/username').set(uname);
                }

                // First team assignment only: a user who already has a team cannot
                // change it here (only the Superuser can).
                const pickedTeam = (document.getElementById('loginTeam') || {}).value;
                // Admins never pick their own team (that would self-assign admin scope);
                // only the Superuser assigns an Admin's team.
                if (pickedTeam && canSelfAssignTeam(matchedUser, userData)) {
                    const hasTeam = (userData && userData.teamId) ||
                        (await database.ref('memberTeams/' + sanitizedName).once('value')).val();
                    if (!hasTeam) {
                        const teamExists = (await database.ref('teams/' + pickedTeam + '/name').once('value')).val();
                        if (teamExists) {
                            await database.ref().update({
                                ['users/' + sanitizedName + '/teamId']: pickedTeam,
                                ['memberTeams/' + sanitizedName]: pickedTeam
                            });
                        }
                    }
                }

                // Use full name as the stored current user
                var username = matchedUser;
            } catch (error) {
                errorEl.textContent = 'Connection error. Please try again.';
                return;
            }
        } else {
            var username = usernameInput;
        }

        // Login successful
        errorEl.textContent = '';
        localStorage.setItem('attendance_current_user', username);
        this.selectedMember = username;

        // Remember me
        const rememberMe = document.getElementById('rememberMe');
        if (rememberMe && rememberMe.checked) {
            localStorage.setItem('attendance_remembered_user', usernameInput);
            localStorage.setItem('attendance_remembered_pass', password);
        } else {
            localStorage.removeItem('attendance_remembered_user');
            localStorage.removeItem('attendance_remembered_pass');
        }

        // Ensure user is in team members list
        if (!TEAM_MEMBERS.includes(username)) {
            TEAM_MEMBERS.push(username);
            saveTeamMembers(TEAM_MEMBERS);
        }
        this.unlockApp();
        document.getElementById('userModal').classList.remove('active');
        document.getElementById('loginPassword').value = '';
        this.updateUserDisplay();
        this.ensureSelectedVisible();
        this.updateUIPermissions();
        this.renderTeamList();
        this.renderCalendar();
    }

    async handleRegister() {
        if (MODE === 'secure') return SecureMode.register(this);
        const name = document.getElementById('registerName').value.trim();
        const password = document.getElementById('registerPassword').value;
        const confirm = document.getElementById('registerConfirm').value;
        const errorEl = document.getElementById('registerError');

        if (!name) { errorEl.textContent = 'Please enter your full name.'; return; }
        if (!password) { errorEl.textContent = 'Please enter a password.'; return; }
        if (password.length < 4) { errorEl.textContent = 'Password must be at least 4 characters.'; return; }
        if (password !== confirm) { errorEl.textContent = 'Passwords do not match.'; return; }

        // Check if already registered
        if (typeof database !== 'undefined') {
            const sanitizedName = name.replace(/\./g, '___DOT___');
            const snapshot = await database.ref('users/' + sanitizedName + '/passwordHash').once('value');
            if (snapshot.val()) {
                errorEl.textContent = 'This name is already registered. Please login.';
                return;
            }

            // Team: required once teams exist. Chosen team must be a real team.
            const teams = (await database.ref('teams').once('value')).val() || {};
            const pickedTeam = (document.getElementById('registerTeam') || {}).value || '';
            if (Object.keys(teams).length > 0 && !pickedTeam) {
                errorEl.textContent = 'Please select your team.';
                return;
            }
            if (pickedTeam && !teams[pickedTeam]) {
                errorEl.textContent = 'Selected team no longer exists. Please pick again.';
                return;
            }

            // Hash and save. Only fixed, non-privileged fields come from the client:
            // isAdmin is always false and isManager is never written here. A team the
            // Superuser already assigned to this name is kept.
            const hash = await hashPassword(password);
            const uname = await generateUniqueUsername(name);
            const existing = (await database.ref('users/' + sanitizedName).once('value')).val() || {};
            // Admins never self-assign a team; only the Superuser does.
            const teamId = existing.teamId || (canSelfAssignTeam(name, existing) ? pickedTeam : null) || null;
            const updates = {
                ['users/' + sanitizedName + '/name']: name,
                ['users/' + sanitizedName + '/passwordHash']: hash,
                ['users/' + sanitizedName + '/registeredAt']: new Date().toISOString(),
                ['users/' + sanitizedName + '/isAdmin']: false,
                ['users/' + sanitizedName + '/username']: uname,
                ['users/' + sanitizedName + '/terminated']: null
            };
            if (teamId) {
                updates['users/' + sanitizedName + '/teamId'] = teamId;
                updates['memberTeams/' + sanitizedName] = teamId;
            }
            await database.ref().update(updates);

            // Add to team members if not already there
            await this.refreshTeamMembers();
            if (!TEAM_MEMBERS.includes(name)) {
                TEAM_MEMBERS.push(name);
                saveTeamMembers(TEAM_MEMBERS);
            }
        }

        // Auto-login after register
        errorEl.textContent = '';
        localStorage.setItem('attendance_current_user', name);
        this.selectedMember = name;
        this.unlockApp();
        document.getElementById('userModal').classList.remove('active');
        document.getElementById('registerName').value = '';
        document.getElementById('registerPassword').value = '';
        document.getElementById('registerConfirm').value = '';
        this.updateUserDisplay();
        this.ensureSelectedVisible();
        this.updateUIPermissions();
        this.renderTeamList();
        this.renderCalendar();
    }

    async resetPasswordForMember(member) {
        // Secure mode: only the Admin SDK can set a password, so this becomes a request (design 4.5)
        if (MODE === 'secure') return SecureMode.requestReset(member);
        if (!isAdmin() || !canAdminMember(member)) {
            alert('You can only reset passwords for members of your own team.');
            return;
        }
        const defaultPassword = 'Temp@123';
        const hash = await hashPassword(defaultPassword);
        const sanitizedName = member.replace(/\./g, '___DOT___');
        await database.ref('users/' + sanitizedName + '/passwordHash').set(hash);
        alert(`Password reset for "${member}" as "Temp@123"`);
    }

    updateUserDisplay() {
        if (MODE === 'secure') { SecureMode.updateUserDisplay(this); return; }
        const user = getCurrentUser();
        const display = document.getElementById('currentUserDisplay');
        if (user) {
            const badge = isAdmin() ? ' ðŸ‘‘' : '';
            const sanitizedName = user.replace(/\./g, '___DOT___');
            if (typeof database !== 'undefined') {
                database.ref('users/' + sanitizedName + '/username').once('value').then((snapshot) => {
                    if (getCurrentUser() !== user) return;
                    const uname = snapshot.val() || user;
                    display.innerHTML = `
                        <span class="user-display-name">${uname}${badge}</span>
                        <span class="user-display-team" id="currentUserTeam"></span>
                        <span class="user-display-sep">|</span>
                        <span class="user-display-btn" id="btnChangePassword" title="Change password">ðŸ”‘ Password</span>
                        <span class="user-display-sep">|</span>
                        <span class="user-display-btn" id="btnLogout" title="Logout">â‡„ Logout</span>
                    `;
                    this.bindUserDisplayEvents(display);
                    this.updateTeamLabels();
                });
            } else {
                display.innerHTML = `
                    <span class="user-display-name">${user}${badge}</span>
                    <span class="user-display-team" id="currentUserTeam"></span>
                    <span class="user-display-sep">|</span>
                    <span class="user-display-btn" id="btnChangePassword" title="Change password">ðŸ”‘ Password</span>
                    <span class="user-display-sep">|</span>
                    <span class="user-display-btn" id="btnLogout" title="Logout">â‡„ Logout</span>
                `;
                this.bindUserDisplayEvents(display);
                    this.updateTeamLabels();
            }
        } else {
            display.innerHTML = '';
        }
    }

    bindUserDisplayEvents(display) {
        document.getElementById('btnLogout').onclick = () => {
            this.lockApp();
        };
        document.getElementById('btnChangePassword').onclick = () => {
            this.changeOwnPassword();
        };
    }

    // Fix 3: Hide/show UI elements based on permissions
    // Show/hide nav and sections from the current role flags (no network)
    applyRoleVisibility() {
        const show = (id, on, display) => {
            const el = document.getElementById(id);
            if (el) el.style.display = on ? display : 'none';
        };
        show('btnHolidayView', canManageHolidays(), 'block');
        show('btnTeamView', canManageTeam(), 'block');
        show('btnSyncTeams', canUseReports(), '');
        show('btnEmailReport', canUseReports(), '');
        show('adminSettings', isSuperUser(), 'block');
        show('teamsAdmin', canManageTeams(), 'block');
        show('btnSummaryView', canViewSummary(), 'block');
        show('syncImport', canImportData(), '');
    }

    updateUIPermissions() {
        if (MODE === 'secure') { SecureMode.updateUIPermissions(this); return; }
        this.applyRoleVisibility();
        const summaryBtn = document.getElementById('btnSummaryView');

        // Load visibility toggle state from Firebase
        if (typeof database !== 'undefined') {
            database.ref('settings/everyoneSeesAll').once('value').then((snapshot) => {
                if (!getCurrentUser()) return;
                const val = snapshot.val();
                const toggle = document.getElementById('toggleVisibility');
                if (toggle) toggle.checked = val === true;
                // Update nav/visibility after loading setting
                this.applyRoleVisibility();
                this.ensureSelectedVisible();
                this.renderTeamList();
            });
        }
    }

    getDataVisibility() {
        // Check if everyone can see everyone's data
        const toggle = document.getElementById('toggleVisibility');
        if (toggle) return toggle.checked;
        return false;
    }

    async changeOwnPassword() {
        if (MODE === 'secure') return SecureMode.changeOwnPassword();
        const currentUser = getCurrentUser();
        if (!currentUser) return;

        const oldPassword = prompt('Enter your current password:');
        if (!oldPassword) return;

        const oldHash = await hashPassword(oldPassword);
        const sanitizedName = currentUser.replace(/\./g, '___DOT___');

        // Verify old password
        const snapshot = await database.ref('users/' + sanitizedName + '/passwordHash').once('value');
        const storedHash = snapshot.val();

        if (oldHash !== storedHash) {
            alert('âŒ Current password is incorrect.');
            return;
        }

        const newPassword = prompt('Enter new password (min 4 characters):');
        if (!newPassword || newPassword.length < 4) {
            alert('Password must be at least 4 characters.');
            return;
        }

        const confirmPassword = prompt('Confirm new password:');
        if (newPassword !== confirmPassword) {
            alert('âŒ Passwords do not match.');
            return;
        }

        const newHash = await hashPassword(newPassword);
        await database.ref('users/' + sanitizedName + '/passwordHash').set(newHash);
        alert('âœ… Password changed successfully.');
    }

    // --- Team List ---
    renderTeamList() {
        const list = document.getElementById('teamList');
        const currentUser = getCurrentUser();

        // Admin: everyone. Manager: own team + self. Others: self (own team if toggle on)
        let visibleMembers = getVisibleMembers();

        // Put logged-in user on top
        if (currentUser && visibleMembers.includes(currentUser)) {
            visibleMembers = visibleMembers.filter(m => m !== currentUser);
            visibleMembers.unshift(currentUser);
        }

        list.innerHTML = visibleMembers.map((member, i) => {
            const initials = member.split(' ').map(n => n[0]).join('').substring(0, 2);
            const isActive = member === this.selectedMember ? 'active' : '';
            const isMe = member === currentUser ? '<span class="me-tag">(You)</span>' : '';
            // Only the Superuser sees many teams, so only they get a per-member team tag
            const teamTag = isSuperUser()
                ? ` <span class="member-team-tag">[${escapeHtml(getTeamName(getMemberTeamId(member)) || 'No team')}]</span>`
                : '';
            return `<li class="${isActive}" data-member="${escapeHtml(member)}">
                <span class="avatar" style="background:${AVATAR_COLORS[i % AVATAR_COLORS.length]}">${escapeHtml(initials)}</span>
                ${escapeHtml(member)} ${isMe}${teamTag}
            </li>`;
        }).join('');
        this.updateTeamLabels();
    }

    // Team name next to "Team Members" and in the header; textContent only, empty when logged out
    updateTeamLabels() {
        const label = getMyTeamLabel();
        const heading = document.getElementById('teamHeadingLabel');
        if (heading) heading.textContent = label ? ' - ' + label : '';
        const mine = document.getElementById('currentUserTeam');
        if (mine) mine.textContent = label ? '(' + label + ')' : '';
    }

    // --- Calendar ---
    renderCalendar() {
        const monthNames = ["January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"];

        document.getElementById('currentMonthYear').textContent =
            `${monthNames[this.currentMonth]} ${this.currentYear}`;

        this.ensureSelectedVisible();
        this.renderViewingInfo();
        this.renderStats();
        this.renderCalendarGrid();
    }

    renderViewingInfo() {
        const currentUser = getCurrentUser();
        const viewing = this.selectedMember;
        const info = document.getElementById('viewingInfo');
        if (!info) return;
        const isSelf = currentUser && currentUser === viewing;
        const v = escapeHtml(viewing);

        if (isSelf) {
            info.innerHTML = `<span class="viewing-member editing">ðŸ“ Editing: ${v}</span>`;
        } else if (canEdit(viewing)) {
            info.innerHTML = `<span class="viewing-member editing">ðŸ“ Admin Editing: ${v}</span>`;
        } else {
            info.innerHTML = `<span class="view-only-tag">ðŸ‘ï¸ View Only</span> <span class="viewing-member">Viewing: ${v}</span>`;
        }
    }

    renderStats() {
        const workingDays = this.data.getEffectiveWorkingDays(this.selectedMember, this.currentYear, this.currentMonth);
        const attended = this.data.getAttendanceCount(this.selectedMember, this.currentYear, this.currentMonth);
        const percentage = this.data.getAttendancePercentage(this.selectedMember, this.currentYear, this.currentMonth);
        const required = Math.ceil(workingDays * REQUIRED_PERCENTAGE / 100);
        const needToAttend = Math.max(0, required - attended);

        const statusColor = percentage >= REQUIRED_PERCENTAGE ? 'green' : (percentage >= 40 ? 'orange' : 'red');

        const wfhMessages = [
            "Enjoy your work-from-home daysâ€”they're a blessing for both your family and your health. â¤ï¸ðŸ¡ðŸ’»",
            "Work from home while it lasts. More family time, better health, and a happier life. ðŸ¡â¤ï¸",
            "Enjoy your work-from-home timeâ€”it brings you closer to your family and gives you a better work-life balance. ðŸ¡â¤ï¸"
        ];
        const motivationMsg = percentage >= REQUIRED_PERCENTAGE
            ? `<div class="motivation-msg">${wfhMessages[Math.floor(Math.random() * wfhMessages.length)]}</div>`
            : '';

        document.getElementById('attendanceStats').innerHTML = `
            <div class="stat-card">
                <span class="stat-label">Working Days</span>
                <span class="stat-value blue">${workingDays}</span>
            </div>
            <div class="stat-card">
                <span class="stat-label">Days Attended</span>
                <span class="stat-value green">${attended}</span>
            </div>
            <div class="stat-card">
                <span class="stat-label">Need to Attend</span>
                <span class="stat-value ${needToAttend === 0 ? 'green' : 'red'}">${needToAttend}</span>
            </div>
            <div class="stat-card">
                <span class="stat-label">Required (60%)</span>
                <span class="stat-value orange">${required}</span>
            </div>
            <div class="stat-card">
                <span class="stat-label">Attendance %</span>
                <span class="stat-value ${statusColor}">${percentage}%</span>
            </div>
            ${motivationMsg}
        `;
    }

    renderCalendarGrid() {
        const grid = document.getElementById('calendarGrid');
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const firstDay = new Date(this.currentYear, this.currentMonth, 1).getDay();
        const daysInMonth = new Date(this.currentYear, this.currentMonth + 1, 0).getDate();
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

        let html = dayNames.map(d => `<div class="calendar-header">${d}</div>`).join('');

        // Empty cells before first day
        for (let i = 0; i < firstDay; i++) {
            html += '<div class="calendar-day empty"></div>';
        }

        // Day cells
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${this.currentYear}-${String(this.currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const isWeekend = this.data.isWeekend(dateStr);
            const isHoliday = this.data.isHoliday(dateStr);
            const isPresent = this.data.isPresent(this.selectedMember, dateStr);
            const leaveType = this.data.getLeaveType(this.selectedMember, dateStr);
            const isToday = dateStr === todayStr;
            const isFuture = new Date(dateStr + 'T23:59:59') > today;
            // Allow planning up to 2 months ahead
            const twoMonthsAhead = new Date(today);
            twoMonthsAhead.setMonth(twoMonthsAhead.getMonth() + 2);
            const canPlan = isFuture && new Date(dateStr) <= twoMonthsAhead;

            let classes = ['calendar-day'];
            let statusIcon = '';
            let title = '';

            if (isWeekend) {
                classes.push('weekend');
                statusIcon = 'ðŸ”’';
                title = 'Weekend';
            } else if (isHoliday) {
                classes.push('holiday');
                statusIcon = 'ðŸ–ï¸';
                title = this.data.getHolidayName(dateStr);
            } else if (leaveType) {
                if (leaveType === 'leave') {
                    classes.push('on-leave');
                    statusIcon = 'ðŸš«';
                    title = 'Leave (not counted as working day)';
                } else if (leaveType === 'wfh') {
                    classes.push('wfh');
                    statusIcon = 'ðŸ ';
                    title = 'Work From Home';
                } else if (leaveType === 'wfh-email') {
                    classes.push('wfh-email');
                    statusIcon = 'ðŸ“§';
                    title = 'WFH Email (excluded from total days)';
                } else if (leaveType === 'exception') {
                    classes.push('exception');
                    statusIcon = 'âš¡';
                    title = 'Exception (not counted as working day)';
                } else if (leaveType === 'planned') {
                    classes.push('planned');
                    statusIcon = 'ðŸ“‹';
                    title = 'Planning to Come';
                }
                // Mark future days with leave type as future too
                if (isFuture) classes.push('future');
            } else if (isToday) {
                if (isPresent) {
                    classes.push('present');
                    statusIcon = 'âœ…';
                }
            } else if (isFuture) {
                classes.push('future');
                if (canPlan) classes.push('plannable');
            } else if (isPresent) {
                classes.push('present');
                statusIcon = 'âœ…';
            }

            if (isToday) classes.push('today');

            html += `<div class="${classes.join(' ')}" data-date="${dateStr}" title="${title}">
                <span class="day-number">${day}</span>
                <span class="day-status">${statusIcon}</span>
            </div>`;
        }

        grid.innerHTML = html;
    }

    // --- Day Context Menu ---
    showDayMenu(date, targetEl) {
        // Remove any existing menu
        const existingMenu = document.getElementById('dayContextMenu');
        if (existingMenu) existingMenu.remove();

        const menu = document.createElement('div');
        menu.id = 'dayContextMenu';
        menu.className = 'day-context-menu';

        const isPresent = this.data.isPresent(this.selectedMember, date);
        const leaveType = this.data.getLeaveType(this.selectedMember, date);

        menu.innerHTML = `
            <div class="menu-title">Mark as:</div>
            <button class="menu-item ${isPresent && !leaveType ? 'active' : ''}" data-action="present">âœ… Present</button>
            <button class="menu-item ${leaveType === 'leave' ? 'active' : ''}" data-action="leave">ðŸš« Leave</button>
            <button class="menu-item ${leaveType === 'wfh' ? 'active' : ''}" data-action="wfh">ðŸ  Work From Home</button>
            <button class="menu-item ${leaveType === 'wfh-email' ? 'active' : ''}" data-action="wfh-email">ðŸ“§ WFH Email</button>
            <button class="menu-item ${leaveType === 'exception' ? 'active' : ''}" data-action="exception">âš¡ Exception</button>
            <hr>
            <button class="menu-item" data-action="clear">âŒ Clear</button>
        `;

        // Position menu near the target element
        const rect = targetEl.getBoundingClientRect();
        menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
        menu.style.left = `${rect.left + window.scrollX}px`;
        document.body.appendChild(menu);

        // Handle menu clicks
        menu.addEventListener('click', (e) => {
            const btn = e.target.closest('.menu-item');
            if (!btn) return;
            const action = btn.dataset.action;

            if (action === 'present') {
                this.data.removeLeave(this.selectedMember, date);
                this.data.markAttendance(this.selectedMember, date, true);
            } else if (action === 'leave') {
                this.data.markLeave(this.selectedMember, date, 'leave');
            } else if (action === 'wfh') {
                this.data.markLeave(this.selectedMember, date, 'wfh');
            } else if (action === 'wfh-email') {
                this.data.markLeave(this.selectedMember, date, 'wfh-email');
            } else if (action === 'exception') {
                this.data.markLeave(this.selectedMember, date, 'exception');
            } else if (action === 'clear') {
                this.data.removeLeave(this.selectedMember, date);
                this.data.markAttendance(this.selectedMember, date, false);
            }

            menu.remove();
            this.renderCalendar();
        });

        // Close menu on outside click
        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => document.addEventListener('click', closeMenu), 10);
    }

    // --- Planning Menu (Future Days) ---
    showPlanningMenu(date, targetEl) {
        const existingMenu = document.getElementById('dayContextMenu');
        if (existingMenu) existingMenu.remove();

        const menu = document.createElement('div');
        menu.id = 'dayContextMenu';
        menu.className = 'day-context-menu';

        const leaveType = this.data.getLeaveType(this.selectedMember, date);

        menu.innerHTML = `
            <div class="menu-title">Plan for this day:</div>
            <button class="menu-item ${leaveType === 'planned' ? 'active' : ''}" data-action="planned">ðŸ“‹ Planning to Come</button>
            <button class="menu-item ${leaveType === 'leave' ? 'active' : ''}" data-action="leave">ðŸš« Leave</button>
            <button class="menu-item ${leaveType === 'exception' ? 'active' : ''}" data-action="exception">âš¡ Exception</button>
            <hr>
            <button class="menu-item" data-action="clear">âŒ Clear</button>
        `;

        const rect = targetEl.getBoundingClientRect();
        menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
        menu.style.left = `${rect.left + window.scrollX}px`;
        document.body.appendChild(menu);

        menu.addEventListener('click', (e) => {
            const btn = e.target.closest('.menu-item');
            if (!btn) return;
            const action = btn.dataset.action;

            if (action === 'planned') {
                this.data.markLeave(this.selectedMember, date, 'planned');
            } else if (action === 'leave') {
                this.data.markLeave(this.selectedMember, date, 'leave');
            } else if (action === 'exception') {
                this.data.markLeave(this.selectedMember, date, 'exception');
            } else if (action === 'clear') {
                this.data.removeLeave(this.selectedMember, date);
            }

            menu.remove();
            this.renderCalendar();
        });

        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => document.addEventListener('click', closeMenu), 10);
    }

    // --- Summary View ---
    renderSummary() {
        const monthNames = ["January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"];

        document.getElementById('summaryMonthYear').textContent =
            `${monthNames[this.currentMonth]} ${this.currentYear}`;

        const workingDays = this.data.getWorkingDays(this.currentYear, this.currentMonth);

        // Build data array (only members the current user may see)
        if (!canViewSummary()) return;
        let memberData = getVisibleMembers().map(member => {
            const attended = this.data.getAttendanceCount(member, this.currentYear, this.currentMonth);
            const percentage = this.data.getAttendancePercentage(member, this.currentYear, this.currentMonth);
            let statusClass, statusText, statusOrder;
            if (percentage >= REQUIRED_PERCENTAGE) {
                statusClass = 'compliant'; statusText = 'âœ“ Compliant'; statusOrder = 1;
            } else if (percentage >= 40) {
                statusClass = 'on-track'; statusText = 'âš  At Risk'; statusOrder = 2;
            } else {
                statusClass = 'non-compliant'; statusText = 'âœ— Non-Compliant'; statusOrder = 3;
            }
            return { name: member, attended, workingDays, percentage, statusClass, statusText, statusOrder };
        });

        // Sort (null = default team order)
        if (this.sortColumn) {
            memberData.sort((a, b) => {
                let cmp = 0;
                switch (this.sortColumn) {
                    case 'name': cmp = a.name.localeCompare(b.name); break;
                    case 'attended': cmp = a.attended - b.attended; break;
                    case 'percentage': cmp = a.percentage - b.percentage; break;
                    case 'status': cmp = a.statusOrder - b.statusOrder; break;
                }
                return this.sortDirection === 'asc' ? cmp : -cmp;
            });
        }

        // Render sort arrows in header
        const getArrow = (col) => {
            if (this.sortColumn === col) {
                return this.sortDirection === 'asc' ? ' â–²' : ' â–¼';
            }
            return ' â‡…';
        };

        document.getElementById('summaryTable').querySelector('thead').innerHTML = `
            <tr>
                <th class="sortable" data-sort="name">Team Member${getArrow('name')}</th>
                <th class="sortable" data-sort="attended">Days Attended${getArrow('attended')}</th>
                <th>Working Days</th>
                <th class="sortable" data-sort="percentage">Attendance %${getArrow('percentage')}</th>
                <th class="sortable" data-sort="status">Status${getArrow('status')}</th>
            </tr>`;

        const tbody = document.getElementById('summaryBody');
        tbody.innerHTML = memberData.map(m => {
            const barColor = m.percentage >= REQUIRED_PERCENTAGE ? 'green' : (m.percentage >= 40 ? 'orange' : 'red');
            return `<tr>
                <td>${escapeHtml(m.name)}</td>
                <td>${m.attended}</td>
                <td>${m.workingDays}</td>
                <td>
                    <div class="progress-bar"><div class="fill ${barColor}" style="width:${Math.min(m.percentage, 100)}%"></div></div>
                    ${m.percentage}%
                </td>
                <td><span class="status-badge ${m.statusClass}">${m.statusText}</span></td>
            </tr>`;
        }).join('');
    }

    // --- Holiday View ---
    renderHolidays() {
        if (!canManageHolidays()) return;
        const list = document.getElementById('holidayList');
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
            "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

        const today = new Date();
        const currentMonth = today.getMonth();
        const currentYear = today.getFullYear();

        list.innerHTML = this.data.data.holidays.map(h => {
            const d = new Date(h.date + 'T00:00:00');
            const dateDisplay = `${d.getDate()} ${monthNames[d.getMonth()]} ${d.getFullYear()}`;
            const isCurrentMonth = (d.getMonth() === currentMonth && d.getFullYear() === currentYear);
            const highlightClass = isCurrentMonth ? 'holiday-current-month' : '';
            return `<div class="holiday-item ${highlightClass}">
                <div class="holiday-info">
                    <span class="holiday-date">ðŸ“… ${dateDisplay}</span>
                    <span class="holiday-name">${h.name}</span>
                    ${isCurrentMonth ? '<span class="holiday-badge">This Month</span>' : ''}
                </div>
                <button class="btn-delete" data-date="${h.date}">Remove</button>
            </div>`;
        }).join('');

        if (this.data.data.holidays.length === 0) {
            list.innerHTML = '<p style="color: var(--text-secondary); padding: 20px;">No holidays added yet.</p>';
        }
    }

    // --- View Switching ---
    switchView(view) {
        // Refuse views the user may not open (also blocks console / stale-DOM access)
        if (!this.isViewAllowed(view)) view = 'calendar';
        this.currentView = view;
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.querySelectorAll('.btn-sidebar').forEach(b => b.classList.remove('active'));

        if (view === 'calendar') {
            document.getElementById('calendarView').classList.add('active');
            document.getElementById('btnCalendarView').classList.add('active');
            this.renderCalendar();
        } else if (view === 'summary') {
            document.getElementById('summaryView').classList.add('active');
            document.getElementById('btnSummaryView').classList.add('active');
            this.renderSummary();
        } else if (view === 'holiday') {
            document.getElementById('holidayView').classList.add('active');
            document.getElementById('btnHolidayView').classList.add('active');
            this.renderHolidays();
        } else if (view === 'team') {
            document.getElementById('teamView').classList.add('active');
            document.getElementById('btnTeamView').classList.add('active');
            this.renderTeamManagement();
        }
    }

    // --- Team Management ---
    renderTeamManagement() {
        const list = document.getElementById('teamMemberList');
        if (!canManageTeam()) { list.innerHTML = ''; return; }
        const currentUserIsAdmin = isAdmin();
        const superUser = canAssignRoles();
        this.renderTeamsAdmin();
        const scope = getAdminScopeMembers();
        this.renderMemberTeamSelect();
        let html = scope.map((member, i) => {
            const initials = member.split(' ').map(n => n[0]).join('').substring(0, 2);
            const memberIsAdmin = ADMIN_MEMBERS.includes(member);
            const memberIsManager = MANAGERS.includes(member);
            const isSuperAdmin = memberIsSuper(member);
            const isSelf = member === getCurrentUser();
            const canAct = canAdminMember(member);
            // A team Admin never gets controls for other Admins or Managers; the Superuser's own row has no Remove/Rename
            const privilegedOther = !superUser && !isSelf &&
                (MODE === 'secure' ? SecureMode.memberIsPrivileged(member) : (memberIsAdmin || memberIsManager || isSuperAdmin));
            const canManage = canAct && !privilegedOther;
            const ownSuperRow = isSelf && isSuperAdmin;
            const canRenameRow = canManage && !ownSuperRow && (MODE !== 'secure' || !SecureMode.denyText('canRename', member));
            const canDrag = MODE === 'secure' ? SecureMode.canReorder(member) : canManage;
            const m = escapeHtml(member);
            const teamId = getMemberTeamId(member);
            const teamName = getTeamName(teamId);
            let roleControls = '';
            if (superUser) {
                const opts = ['<option value="">Unassigned</option>']
                    .concat(Object.keys(TEAMS).filter(id => TEAMS[id] && TEAMS[id].name).map(id =>
                        `<option value="${escapeHtml(id)}"${id === teamId ? ' selected' : ''}>${escapeHtml(TEAMS[id].name)}</option>`))
                    .join('');
                const adminCtl = isSuperAdmin
                    ? `<span class="super-admin-badge">ðŸ‘‘ Super Admin</span>`
                    : `<label class="role-check"><input type="checkbox" class="chk-admin" data-member="${m}"${memberIsAdmin ? ' checked' : ''}> Admin</label>`;
                roleControls = `
                    <select class="member-team-select" data-member="${m}" title="Team">${opts}</select>
                    <label class="role-check"><input type="checkbox" class="chk-manager" data-member="${m}"${memberIsManager ? ' checked' : ''}> Manager</label>
                    ${adminCtl}`;
            } else {
                roleControls = `<span class="team-tag">${escapeHtml(teamName || 'Unassigned')}</span>` +
                    (memberIsManager ? `<span class="admin-tag">Manager</span>` : '') +
                    (memberIsAdmin ? `<span class="admin-tag">Admin</span>` : '');
            }

            return `<div class="team-member-item" draggable="${canDrag ? 'true' : 'false'}" data-index="${i}" data-member="${m}">
                <div class="team-member-info">
                    <span class="drag-handle" title="Drag to reorder"${canDrag ? '' : ' style="visibility:hidden"'}>â˜°</span>
                    <span class="avatar" style="background:${AVATAR_COLORS[i % AVATAR_COLORS.length]}">${escapeHtml(initials)}</span>
                    <span class="team-member-name">${m}</span>
                    ${roleControls}
                </div>
                <div class="team-member-actions">
                    ${canRenameRow ? `<button class="btn-edit" data-member="${m}" title="Edit name">âœï¸</button>` : ''}
                    ${canManage && !isSelf && (MODE !== 'secure' || SecureMode.hasAccount(member)) ? `<button class="btn-reset-pw" data-member="${m}" title="${MODE === 'secure' ? 'Request password reset' : 'Reset password'}">ðŸ”‘</button>` : ''}
                    ${canManage && !isSelf && !isSuperAdmin ? `<button class="btn-delete" data-member="${m}" title="Remove">Remove</button>` : ''}
                </div>
            </div>`;
        }).join('');

        if (isTeamAdmin() && !getMyTeamId()) {
            html += '<p style="color: var(--text-secondary); padding: 20px;">You are not assigned to a team yet. Ask the Superuser to assign you.</p>';
        } else if (scope.length === 0) {
            html = '<p style="color: var(--text-secondary); padding: 20px;">No team members added yet.</p>';
        }

        // Show terminated users section (admin only)
        if (currentUserIsAdmin) {
            html += `<div id="terminatedSection"></div>`;
        }

        list.innerHTML = html;

        // Load terminated users from Firebase
        if (MODE === 'secure') {
            if (currentUserIsAdmin) SecureMode.renderTerminatedSection();
        } else if (currentUserIsAdmin && typeof database !== 'undefined') {
            database.ref('users').once('value').then((snapshot) => {
                const users = snapshot.val();
                if (!users) return;
                const terminatedUsers = [];
                for (const key in users) {
                    const user = users[key];
                    if (user.terminated === true && canAdminTeamId(user.teamId || MEMBER_TEAMS[key] || null)) {
                        terminatedUsers.push(user.name || key.replace(/___DOT___/g, '.'));
                    }
                }
                const section = document.getElementById('terminatedSection');
                if (section && terminatedUsers.length > 0) {
                    section.innerHTML = `
                        <h4 class="terminated-header">ðŸš« Terminated Members (${terminatedUsers.length})</h4>
                        ${terminatedUsers.map(name => `
                            <div class="team-member-item terminated-item">
                                <div class="team-member-info">
                                    <span class="avatar" style="background:#666">âœ—</span>
                                    <span class="team-member-name terminated-name">${escapeHtml(name)}</span>
                                </div>
                                <div class="team-member-actions">
                                    <button class="btn-restore" data-member="${escapeHtml(name)}" title="Restore member">â™»ï¸ Restore</button>
                                </div>
                            </div>
                        `).join('')}
                    `;
                }
            });
        }

        // Setup drag and drop
        this.setupDragDrop();
    }

    setupDragDrop() {
        const list = document.getElementById('teamMemberList');
        let draggedItem = null;
        let draggedMember = null;

        list.querySelectorAll('.team-member-item').forEach(item => {
            item.addEventListener('dragstart', (e) => {
                draggedItem = item;
                draggedMember = item.dataset.member;
                item.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
            });

            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
                list.querySelectorAll('.team-member-item').forEach(el => el.classList.remove('drag-over'));
                draggedItem = null;
            });

            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (item !== draggedItem) {
                    list.querySelectorAll('.team-member-item').forEach(el => el.classList.remove('drag-over'));
                    item.classList.add('drag-over');
                }
            });

            item.addEventListener('dragleave', () => {
                item.classList.remove('drag-over');
            });

            item.addEventListener('drop', (e) => {
                e.preventDefault();
                item.classList.remove('drag-over');
                if (!canManageTeam()) { denyAction('Only admins can reorder the team.'); return; }
                if (this.reorderMembers(draggedMember, item.dataset.member)) {
                    this.renderTeamManagement();
                    this.renderTeamList();
                }
            });
        });
    }

    // Move `dragged` to the position of `target` in the global roster; both must be in the actor's scope
    reorderMembers(dragged, target) {
        if (!canManageTeam()) { denyAction('Only admins can reorder the team.'); return false; }
        if (!dragged || !target || dragged === target) return false;
        if (!canAdminMember(dragged) || !canAdminMember(target)) {
            denyAction('You can only reorder members of your own team.');
            return false;
        }
        if (MODE === 'secure') return SecureMode.reorderMembers(dragged, target);
        const from = TEAM_MEMBERS.indexOf(dragged);
        const to = TEAM_MEMBERS.indexOf(target);
        if (from < 0 || to < 0) return false;
        TEAM_MEMBERS.splice(from, 1);
        TEAM_MEMBERS.splice(to, 0, dragged);
        saveTeamMembers(TEAM_MEMBERS);
        return true;
    }

    resetTeamToDefault() {
        if (!isSuperUser()) {
            alert('âš ï¸ Only the Superuser can reset the team list.');
            return;
        }
        if (MODE === 'secure') { denyAction('Resetting the team list is not available in secure mode.'); return; }
        if (!confirm('Reset team list to the default members?\n\nThis will replace the current list. Attendance data is preserved.')) return;
        TEAM_MEMBERS = [...DEFAULT_TEAM_MEMBERS];
        saveTeamMembers(TEAM_MEMBERS);
        this.selectedMember = TEAM_MEMBERS[0];
        this.renderTeamList();
        this.renderTeamManagement();
    }

    // --- Admin Management ---
    // Superuser only (roles are assigned by the Superuser alone)
    makeAdmin(member) { return this.setAdminRole(member, true); }
    removeAdmin(member) { return this.setAdminRole(member, false); }

    setAdminRole(member, makeAdmin) {
        if (!canAssignRoles()) { denyAction('Only the Superuser can assign roles.'); return false; }
        if (!member || !TEAM_MEMBERS.includes(member)) return false;
        if (memberIsSuper(member)) {
            if (!makeAdmin) alert('âš ï¸ Cannot remove the super admin.');
            return false;
        }
        const has = ADMIN_MEMBERS.includes(member);
        if (makeAdmin === has) return true;
        const msg = makeAdmin
            ? `Make "${member}" an admin?\n\nAdmins can edit attendance and manage members of their own team only.`
            : `Remove admin rights from "${member}"?`;
        if (!confirm(msg)) { this.renderTeamManagement(); return false; }
        if (MODE === 'secure') return SecureMode.setRole(this, member, 'isAdmin', makeAdmin);
        ADMIN_MEMBERS = makeAdmin ? [...ADMIN_MEMBERS, member] : ADMIN_MEMBERS.filter(m => m !== member);
        saveAdminList(ADMIN_MEMBERS);
        if (typeof database !== 'undefined') {
            database.ref('users/' + nameKey(member) + '/isAdmin').set(makeAdmin);
        }
        this.renderTeamManagement();
        return true;
    }

    setManager(member, makeManager) {
        if (!canAssignRoles()) { denyAction('Only the Superuser can assign roles.'); return false; }
        if (!member || !TEAM_MEMBERS.includes(member) || typeof database === 'undefined') return false;
        const has = MANAGERS.includes(member);
        if (makeManager === has) return true;
        if (MODE === 'secure') return SecureMode.setRole(this, member, 'isManager', makeManager);
        const next = makeManager ? [...MANAGERS, member] : MANAGERS.filter(m => m !== member);
        MANAGERS = next;
        database.ref().update({
            managers: next.length ? next : null,
            ['users/' + nameKey(member) + '/isManager']: makeManager
        });
        this.renderTeamManagement();
        return true;
    }

    // --- Teams (Superuser only) ---
    createTeam(name) {
        if (!canManageTeams()) { denyAction('Only the Superuser can create teams.'); return false; }
        if (typeof database === 'undefined') return false;
        name = (name || '').trim();
        if (!name) return false;
        if (name.length > 60) { alert('âš ï¸ Team name must be 60 characters or fewer.'); return false; }
        if (Object.values(TEAMS).some(t => t && t.name && t.name.toLowerCase() === name.toLowerCase())) {
            alert('âš ï¸ A team with this name already exists.');
            return false;
        }
        if (MODE === 'secure') return SecureMode.createTeam(name); // teams + teamNames in one update
        const id = database.ref('teams').push().key;
        database.ref('teams/' + id).set({
            id, name, createdBy: getCurrentUser(), createdAt: new Date().toISOString()
        });
        return true;
    }

    renameTeam(teamId) {
        if (!canManageTeams()) { denyAction('Only the Superuser can rename teams.'); return false; }
        const team = TEAMS[teamId];
        if (!team || typeof database === 'undefined') return false;
        const input = prompt(`Rename team "${team.name}":`, team.name);
        const name = (input || '').trim();
        if (!name || name === team.name) return false;
        if (name.length > 60) { alert('âš ï¸ Team name must be 60 characters or fewer.'); return false; }
        if (Object.keys(TEAMS).some(id => id !== teamId && TEAMS[id].name && TEAMS[id].name.toLowerCase() === name.toLowerCase())) {
            alert('âš ï¸ A team with this name already exists.');
            return false;
        }
        if (MODE === 'secure') return SecureMode.renameTeam(teamId, name);
        database.ref('teams/' + teamId + '/name').set(name);
        return true;
    }

    // Deleting a team leaves its members Unassigned; users are never deleted
    deleteTeam(teamId) {
        if (!canManageTeams()) { denyAction('Only the Superuser can delete teams.'); return false; }
        const team = TEAMS[teamId];
        if (!team || typeof database === 'undefined') return false;
        const memberKeys = Object.keys(MEMBER_TEAMS).filter(k => MEMBER_TEAMS[k] === teamId);
        if (!confirm(`Delete team "${team.name}"?\n\n${memberKeys.length} member(s) will become Unassigned. No users or attendance data are deleted.`)) return false;
        if (MODE === 'secure') return SecureMode.deleteTeam(teamId); // members move to unassigned
        const updates = { ['teams/' + teamId]: null };
        memberKeys.forEach(k => {
            updates['memberTeams/' + k] = null;
            updates['users/' + k + '/teamId'] = null;
        });
        database.ref().update(updates);
        return true;
    }

    assignTeam(member, teamId) {
        if (!canAssignRoles()) { denyAction('Only the Superuser can change a member\'s team.'); return false; }
        if (!member || !TEAM_MEMBERS.includes(member) || typeof database === 'undefined') return false;
        teamId = teamId || null;
        if (teamId && !TEAMS[teamId]) return false;
        if (MODE === 'secure') return SecureMode.assignTeam(member, teamId); // moves roster and history
        const key = nameKey(member);
        database.ref().update({
            ['users/' + key + '/teamId']: teamId,
            ['memberTeams/' + key]: teamId
        });
        return true;
    }

    renderTeamsAdmin() {
        const box = document.getElementById('teamsAdminList');
        if (!box) return;
        if (!canManageTeams()) { box.innerHTML = ''; return; }
        const ids = Object.keys(TEAMS).filter(id => TEAMS[id] && TEAMS[id].name)
            .sort((a, b) => TEAMS[a].name.localeCompare(TEAMS[b].name));
        if (ids.length === 0) {
            box.innerHTML = '<p style="color: var(--text-secondary);">No teams yet. Create one above.</p>';
            return;
        }
        box.innerHTML = ids.map(id => {
            const count = Object.keys(MEMBER_TEAMS).filter(k => MEMBER_TEAMS[k] === id).length;
            return `<div class="team-admin-item">
                <span class="team-admin-name">${escapeHtml(TEAMS[id].name)}</span>
                <span class="team-tag">${count} member${count === 1 ? '' : 's'}</span>
                <span class="team-member-actions">
                    <button class="btn-edit btn-team-rename" data-team="${escapeHtml(id)}" title="Rename team">âœï¸</button>
                    <button class="btn-delete btn-team-delete" data-team="${escapeHtml(id)}" title="Delete team">Delete</button>
                </span>
            </div>`;
        }).join('');
    }

    // --- Theme Toggle ---
    toggleTheme() {
        const body = document.body;
        const isLight = body.classList.toggle('light-theme');
        localStorage.setItem('attendance_theme', isLight ? 'light' : 'dark');
        this.updateThemeButton();
    }

    updateThemeButton() {
        const btn = document.getElementById('btnThemeToggle');
        const isLight = document.body.classList.contains('light-theme');
        btn.textContent = isLight ? 'ðŸŒ™ Dark' : 'â˜€ï¸ Light';
    }

    loadTheme() {
        const saved = localStorage.getItem('attendance_theme');
        if (saved === 'light') {
            document.body.classList.add('light-theme');
        }
        this.updateThemeButton();
    }

    // Superuser-only team picker for the add-member form
    renderMemberTeamSelect() {
        const sel = document.getElementById('memberTeam');
        if (!sel) return;
        if (!isSuperUser()) { sel.style.display = 'none'; sel.innerHTML = ''; return; }
        const prev = sel.value;
        sel.innerHTML = ['<option value="">Unassigned</option>']
            .concat(Object.keys(TEAMS).filter(id => TEAMS[id] && TEAMS[id].name).map(id =>
                `<option value="${escapeHtml(id)}">${escapeHtml(TEAMS[id].name)}</option>`)).join('');
        if (prev && TEAMS[prev]) sel.value = prev;
        sel.style.display = '';
    }

    // Admin: the member is always created in the Admin's own team (teamId argument is ignored).
    // Superuser: may pass a teamId; omitted means Unassigned.
    async addMember(name, teamId) {
        if (!isAdmin()) {
            alert('âš ï¸ Only admins can add team members.');
            return;
        }
        if (isTeamAdmin()) {
            teamId = getMyTeamId();
            if (!teamId) {
                alert('âš ï¸ Ask the Superuser to assign you to a team first.');
                return;
            }
        } else {
            teamId = (teamId && TEAMS[teamId]) ? teamId : null;
        }
        if (!name || name.trim() === '') return;
        name = name.trim();
        if (TEAM_MEMBERS.includes(name)) {
            alert('âš ï¸ This member already exists!');
            return;
        }
        if (memberIsSuper(name)) {
            alert('âš ï¸ This member already exists!');
            return;
        }

        if (MODE === 'secure') return SecureMode.addMember(this, name, teamId);

        // Check if member exists in Firebase (might be terminated)
        try {
            if (typeof database !== 'undefined') {
                const sanitizedName = name.replace(/\./g, '___DOT___');
                const snapshot = await database.ref('users/' + sanitizedName).once('value');
                const userData = snapshot.val();
                // A team Admin may not claim a person who already belongs to another team
                const existingTeam = (userData && userData.teamId) || getMemberTeamId(name);
                if (isTeamAdmin() && existingTeam && existingTeam !== teamId) {
                    alert('âš ï¸ This person belongs to another team. Ask the Superuser to move them.');
                    return;
                }
                if (userData && userData.terminated === true) {
                    if (confirm(`"${name}" is a terminated member. Do you want to restore them instead?`)) {
                        await this.restoreMember(name);
                    }
                    return;
                }
            }
        } catch (e) {
            // Ignore Firebase errors â€” just add locally
        }

        // Add to team members â€” they can register themselves later
        TEAM_MEMBERS.push(name);
        saveTeamMembers(TEAM_MEMBERS);
        if (teamId) {
            // Record the team so the member is visible to (only) that team's Admins/Managers
            const key = nameKey(name);
            MEMBER_TEAMS[key] = teamId;
            if (typeof database !== 'undefined') {
                database.ref().update({
                    ['users/' + key + '/teamId']: teamId,
                    ['memberTeams/' + key]: teamId
                });
            }
        }
        this.selectedMember = name;
        this.renderTeamList();
        this.renderTeamManagement();
        this.renderCalendar();
    }

    editMember(oldName) {
        if (!isAdmin()) {
            alert('âš ï¸ Only admins can edit team member names.');
            return;
        }
        if (memberIsSuper(oldName) && oldName === getCurrentUser()) {
            denyAction('The Superuser account cannot be removed or changed.');
            return;
        }
        if (!canAdminMember(oldName)) {
            alert('âš ï¸ You can only edit members of your own team.');
            return;
        }
        if (MODE === 'secure') {
            const why = SecureMode.denyText('canRename', oldName);
            if (why) { denyAction(why); return; }
        }
        const newName = prompt(`Edit name for "${oldName}":`, oldName);
        if (!newName || newName.trim() === '' || newName.trim() === oldName) return;
        const trimmed = newName.trim();
        if (TEAM_MEMBERS.includes(trimmed)) {
            alert('âš ï¸ A member with this name already exists!');
            return;
        }
        if (MODE === 'secure') {
            SecureMode.editMember(this, oldName, trimmed);
            this.renderTeamList();
            this.renderTeamManagement();
            return;
        }
        const index = TEAM_MEMBERS.indexOf(oldName);
        if (index !== -1) {
            TEAM_MEMBERS[index] = trimmed;
            saveTeamMembers(TEAM_MEMBERS);
            // Update attendance data key
            if (this.data.data.attendance[oldName]) {
                this.data.data.attendance[trimmed] = this.data.data.attendance[oldName];
                delete this.data.data.attendance[oldName];
                this.data.save();
            }
            if (this.selectedMember === oldName) {
                this.selectedMember = trimmed;
            }
            this.renderTeamList();
            this.renderTeamManagement();
        }
    }

    removeMember(name) {
        if (!isAdmin()) {
            alert('âš ï¸ Only admins can remove team members.');
            return;
        }
        if (memberIsSuper(name)) {
            alert('âš ï¸ Cannot remove the super admin.');
            return;
        }
        if (!canAdminMember(name)) {
            alert('âš ï¸ You can only remove members of your own team.');
            return;
        }
        if (MODE === 'secure') {
            const why = SecureMode.denyText('canTerminate', name);
            if (why) { denyAction(why); return; }
        }
        if (name === getCurrentUser()) {
            alert('âš ï¸ You cannot remove yourself.');
            return;
        }
        if (!confirm(`Are you sure you want to remove "${name}" from the team?\n\nThey will be marked as terminated but can be restored later.`)) return;

        // Secure mode: profile + roster flags in one update; isAdmin cleared (design 5.3)
        if (MODE === 'secure') { SecureMode.removeMember(this, name); return; }

        // Soft delete: mark as terminated in Firebase
        const sanitizedName = name.replace(/\./g, '___DOT___');
        if (typeof database !== 'undefined') {
            database.ref('users/' + sanitizedName + '/terminated').set(true);
            database.ref('users/' + sanitizedName + '/terminatedAt').set(new Date().toISOString());
        }

        // Remove from active team members
        TEAM_MEMBERS = TEAM_MEMBERS.filter(m => m !== name);
        saveTeamMembers(TEAM_MEMBERS);

        // Remove from admin list if they were admin
        if (ADMIN_MEMBERS.includes(name)) {
            ADMIN_MEMBERS = ADMIN_MEMBERS.filter(m => m !== name);
            saveAdminList(ADMIN_MEMBERS);
        }

        if (this.selectedMember === name) {
            this.selectedMember = TEAM_MEMBERS[0] || '';
        }
        this.renderTeamList();
        this.renderTeamManagement();
        this.renderCalendar();
    }

    async restoreMember(name) {
        if (!canManageTeam()) { denyAction('Only admins can restore team members.'); return; }
        if (MODE === 'secure') return SecureMode.restoreMember(this, name);
        // Terminated members keep their team record; no team => Superuser only
        if (!canAdminTeamId(MEMBER_TEAMS[nameKey(name)] || null)) {
            denyAction('You can only restore members of your own team.');
            return;
        }

        // Remove terminated flag and set mustResetPassword (Fix 1)
        const sanitizedName = name.replace(/\./g, '___DOT___');
        await database.ref('users/' + sanitizedName + '/terminated').set(false);
        await database.ref('users/' + sanitizedName + '/terminatedAt').remove();
        await database.ref('users/' + sanitizedName + '/mustResetPassword').set(true);

        // Add back to team
        if (!TEAM_MEMBERS.includes(name)) {
            TEAM_MEMBERS.push(name);
            saveTeamMembers(TEAM_MEMBERS);
        }

        // Offer password reset
        const resetPw = confirm(`"${name}" has been restored.\n\nThey will be asked to set a new password on next login.\nDo you also want to reset their password now?`);
        if (resetPw) {
            await this.resetPasswordForMember(name);
        }

        this.renderTeamManagement();
        this.renderTeamList();
    }

    // --- Sync to Teams ---
    showSyncModal() {
        if (!canUseReports()) { denyAction('Only admins can use Sync to Teams.'); return; }
        document.getElementById('syncModal').classList.add('active');
        document.getElementById('syncStatus').className = 'sync-status';
        document.getElementById('syncStatus').textContent = '';
    }

    syncExport() {
        if (!canUseReports()) { denyAction('Only admins can export data.'); return; }
        // Team Admins export only their own scope; Superuser exports everything
        const json = this.data.exportJSON(isSuperUser() ? undefined : getAdminScopeMembers());
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        a.download = `attendance_sync_${this.currentYear}_${monthNames[this.currentMonth]}.json`;
        a.click();
        URL.revokeObjectURL(url);

        const status = document.getElementById('syncStatus');
        status.className = 'sync-status success';
        status.textContent = 'âœ… File downloaded! Upload it to your Teams channel â†’ Files tab to share with the team.';
    }

    syncImport() {
        if (!canImportData()) { denyAction('Only the Superuser can import data.'); return; }
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    const status = document.getElementById('syncStatus');
                    if (this.data.importJSON(event.target.result)) {
                        status.className = 'sync-status success';
                        status.textContent = 'âœ… Data synced successfully! All attendance records are now up to date.';
                        this.renderCalendar();
                        this.renderTeamList();
                    } else {
                        status.className = 'sync-status error';
                        status.textContent = 'âŒ Invalid file. Please use a valid attendance JSON file from your team.';
                    }
                };
                reader.readAsText(file);
            }
        };
        input.click();
    }

    // --- Monthly Dashboard Report ---
    generateDashboardReport() {
        if (!canUseReports()) return '';
        const scope = getAdminScopeMembers();
        const monthNames = ["January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"];

        const workingDays = this.data.getWorkingDays(this.currentYear, this.currentMonth);
        const today = new Date();
        const reportDate = `${today.getDate()} ${monthNames[today.getMonth()]} ${today.getFullYear()}`;

        let compliantCount = 0;
        let totalAttended = 0;
        const memberData = [];

        scope.forEach(member => {
            const attended = this.data.getAttendanceCount(member, this.currentYear, this.currentMonth);
            const percentage = this.data.getAttendancePercentage(member, this.currentYear, this.currentMonth);
            if (percentage >= REQUIRED_PERCENTAGE) compliantCount++;
            totalAttended += attended;
            let statusOrder;
            if (percentage >= REQUIRED_PERCENTAGE) statusOrder = 1;
            else if (percentage >= 40) statusOrder = 2;
            else statusOrder = 3;
            memberData.push({ name: member, attended, percentage, statusOrder });
        });

        // Sort by current sort settings (null = default team order)
        if (this.sortColumn) {
            memberData.sort((a, b) => {
                let cmp = 0;
                switch (this.sortColumn) {
                    case 'name': cmp = a.name.localeCompare(b.name); break;
                    case 'attended': cmp = a.attended - b.attended; break;
                    case 'percentage': cmp = a.percentage - b.percentage; break;
                    case 'status': cmp = a.statusOrder - b.statusOrder; break;
                }
                return this.sortDirection === 'asc' ? cmp : -cmp;
            });
        }

        const avgAttendance = (workingDays > 0 && scope.length > 0) ? Math.round((totalAttended / (scope.length * workingDays)) * 100) : 0;

        const getArrow = (col) => {
            if (this.sortColumn === col) {
                return this.sortDirection === 'asc' ? ' â–²' : ' â–¼';
            }
            return ' â‡…';
        };

        let html = `
            <div class="report-header">
                <h1>ðŸ“Š Monthly Attendance Report</h1>
                <div class="report-subtitle">${monthNames[this.currentMonth]} ${this.currentYear}</div>
                <div class="report-date">Generated on ${reportDate}</div>
            </div>

            <div class="report-kpis">
                <div class="report-kpi">
                    <span class="kpi-value blue">${scope.length}</span>
                    <span class="kpi-label">Team Members</span>
                </div>
                <div class="report-kpi">
                    <span class="kpi-value blue">${workingDays}</span>
                    <span class="kpi-label">Working Days</span>
                </div>
                <div class="report-kpi">
                    <span class="kpi-value green">${compliantCount}</span>
                    <span class="kpi-label">Compliant (â‰¥60%)</span>
                </div>
                <div class="report-kpi">
                    <span class="kpi-value ${avgAttendance >= 60 ? 'green' : 'orange'}">${avgAttendance}%</span>
                    <span class="kpi-label">Avg Attendance</span>
                </div>
            </div>`;

        html += `
            <table class="report-table" id="reportTable">
                <thead>
                    <tr>
                        <th>#</th>
                        <th class="sortable-report" data-sort="name">Team Member${getArrow('name')}</th>
                        <th class="sortable-report" data-sort="attended">Days Attended${getArrow('attended')}</th>
                        <th>Working Days</th>
                        <th class="sortable-report" data-sort="percentage">Attendance${getArrow('percentage')}</th>
                        <th class="sortable-report" data-sort="status">Status${getArrow('status')}</th>
                    </tr>
                </thead>
                <tbody>`;

        memberData.forEach((m, i) => {
            let badgeClass, badgeText;
            if (m.percentage >= REQUIRED_PERCENTAGE) {
                badgeClass = 'badge-green';
                badgeText = 'âœ“ Compliant';
            } else if (m.percentage >= 40) {
                badgeClass = 'badge-orange';
                badgeText = 'âš  At Risk';
            } else {
                badgeClass = 'badge-red';
                badgeText = 'âœ— Non-Compliant';
            }

            const barColor = m.percentage >= REQUIRED_PERCENTAGE ? 'green' : (m.percentage >= 40 ? 'orange' : 'red');

            html += `
                    <tr>
                        <td>${i + 1}</td>
                        <td><strong>${m.name}</strong></td>
                        <td>${m.attended}</td>
                        <td>${workingDays}</td>
                        <td>
                            <span class="report-bar"><span class="bar-fill ${barColor}" style="width:${Math.min(m.percentage, 100)}%"></span></span>
                            ${m.percentage}%
                        </td>
                        <td><span class="badge ${badgeClass}">${badgeText}</span></td>
                    </tr>`;
        });

        html += `
                </tbody>
            </table>

            <div class="report-footer">
                <span>Required: ${REQUIRED_PERCENTAGE}% (${Math.ceil(workingDays * REQUIRED_PERCENTAGE / 100)} days minimum)</span>
                <span>Compliance: ${compliantCount}/${scope.length} members</span>
                <span>Report by: Attendance Tracker</span>
            </div>`;

        return html;
    }

    generateEmailHTML() {
        if (!canUseReports()) return '';
        const scope = getAdminScopeMembers();
        const monthNames = ["January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"];

        const workingDays = this.data.getWorkingDays(this.currentYear, this.currentMonth);
        const today = new Date();
        const reportDate = `${today.getDate()} ${monthNames[today.getMonth()]} ${today.getFullYear()}`;

        let compliantCount = 0;
        let totalAttended = 0;
        const memberData = [];

        scope.forEach(member => {
            const attended = this.data.getAttendanceCount(member, this.currentYear, this.currentMonth);
            const percentage = this.data.getAttendancePercentage(member, this.currentYear, this.currentMonth);
            if (percentage >= REQUIRED_PERCENTAGE) compliantCount++;
            totalAttended += attended;
            memberData.push({ name: member, attended, percentage });
        });

        const avgAttendance = (workingDays > 0 && scope.length > 0) ? Math.round((totalAttended / (scope.length * workingDays)) * 100) : 0;

        let html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Attendance Report - ${monthNames[this.currentMonth]} ${this.currentYear}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:20px 0;">
<tr><td align="center">
<table width="700" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">

<!-- Header -->
<tr>
<td style="background:#0052CC;padding:24px 32px;text-align:center;">
<h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:600;">ðŸ“Š Monthly Attendance Report</h1>
<p style="margin:4px 0 0;color:#a8c8ff;font-size:14px;">${monthNames[this.currentMonth]} ${this.currentYear}</p>
<p style="margin:4px 0 0;color:#7fb3ff;font-size:12px;">Generated on ${reportDate}</p>
</td>
</tr>

<!-- KPI Cards -->
<tr>
<td style="padding:24px 32px 16px;">
<table width="100%" cellpadding="0" cellspacing="0">
<tr>
<td width="25%" style="text-align:center;padding:12px;background:#f8f9fa;border-radius:8px;">
<div style="font-size:28px;font-weight:700;color:#0052CC;">${scope.length}</div>
<div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;">Team Members</div>
</td>
<td width="4%"></td>
<td width="25%" style="text-align:center;padding:12px;background:#f8f9fa;border-radius:8px;">
<div style="font-size:28px;font-weight:700;color:#0052CC;">${workingDays}</div>
<div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;">Working Days</div>
</td>
<td width="4%"></td>
<td width="25%" style="text-align:center;padding:12px;background:#f8f9fa;border-radius:8px;">
<div style="font-size:28px;font-weight:700;color:#2ea043;">${compliantCount}</div>
<div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;">Compliant (â‰¥60%)</div>
</td>
<td width="4%"></td>
<td width="25%" style="text-align:center;padding:12px;background:#f8f9fa;border-radius:8px;">
<div style="font-size:28px;font-weight:700;color:${avgAttendance >= 60 ? '#2ea043' : '#d29922'};">${avgAttendance}%</div>
<div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;">Avg Attendance</div>
</td>
</tr>
</table>
</td>
</tr>`;

        // Table
        html += `
<!-- Data Table -->
<tr>
<td style="padding:0 32px 24px;">
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;">
<tr style="background:#0052CC;">
<th style="padding:10px 8px;color:#fff;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;border-radius:4px 0 0 0;">#</th>
<th style="padding:10px 8px;color:#fff;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Team Member</th>
<th style="padding:10px 8px;color:#fff;text-align:center;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Days</th>
<th style="padding:10px 8px;color:#fff;text-align:center;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Working</th>
<th style="padding:10px 8px;color:#fff;text-align:center;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">%</th>
<th style="padding:10px 8px;color:#fff;text-align:center;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;border-radius:0 4px 0 0;">Status</th>
</tr>`;

        memberData.forEach((m, i) => {
            let badgeBg, badgeColor, badgeText;
            if (m.percentage >= REQUIRED_PERCENTAGE) {
                badgeBg = '#d4edda'; badgeColor = '#155724'; badgeText = 'âœ“ Compliant';
            } else if (m.percentage >= 40) {
                badgeBg = '#fff3cd'; badgeColor = '#856404'; badgeText = 'âš  At Risk';
            } else {
                badgeBg = '#f8d7da'; badgeColor = '#721c24'; badgeText = 'âœ— Non-Compliant';
            }

            const barColor = m.percentage >= REQUIRED_PERCENTAGE ? '#2ea043' : (m.percentage >= 40 ? '#d29922' : '#da3633');
            const rowBg = i % 2 === 0 ? '#ffffff' : '#f8f9fa';

            html += `
<tr style="background:${rowBg};">
<td style="padding:10px 8px;border-bottom:1px solid #e9ecef;">${i + 1}</td>
<td style="padding:10px 8px;border-bottom:1px solid #e9ecef;font-weight:600;">${m.name}</td>
<td style="padding:10px 8px;border-bottom:1px solid #e9ecef;text-align:center;">${m.attended}</td>
<td style="padding:10px 8px;border-bottom:1px solid #e9ecef;text-align:center;">${workingDays}</td>
<td style="padding:10px 8px;border-bottom:1px solid #e9ecef;text-align:center;">
<div style="display:inline-block;width:60px;height:8px;background:#e9ecef;border-radius:4px;vertical-align:middle;margin-right:4px;">
<div style="width:${Math.min(m.percentage, 100)}%;height:8px;background:${barColor};border-radius:4px;"></div>
</div>
${m.percentage}%
</td>
<td style="padding:10px 8px;border-bottom:1px solid #e9ecef;text-align:center;">
<span style="padding:3px 8px;border-radius:10px;font-size:11px;font-weight:500;background:${badgeBg};color:${badgeColor};">${badgeText}</span>
</td>
</tr>`;
        });

        html += `
</table>
</td>
</tr>

<!-- Footer -->
<tr>
<td style="padding:16px 32px;background:#f8f9fa;border-top:1px solid #e9ecef;">
<table width="100%" cellpadding="0" cellspacing="0">
<tr>
<td style="font-size:11px;color:#888;">Required: ${REQUIRED_PERCENTAGE}% (${Math.ceil(workingDays * REQUIRED_PERCENTAGE / 100)} days minimum)</td>
<td style="font-size:11px;color:#888;text-align:center;">Compliance: ${compliantCount}/${scope.length} members</td>
<td style="font-size:11px;color:#888;text-align:right;">Report by: Attendance Tracker</td>
</tr>
</table>
</td>
</tr>

</table>
</td></tr>
</table>
</body>
</html>`;

        return html;
    }

    showEmailModal() {
        if (!canUseReports()) { denyAction('Only admins can generate reports.'); return; }
        const dashboardHtml = this.generateDashboardReport();
        document.getElementById('reportDashboard').innerHTML = dashboardHtml;
        document.getElementById('emailModal').classList.add('active');
    }

    // --- Email Reminder Check ---
    checkEmailReminder() {
        if (!getCurrentUser() || !canUseReports()) return;
        const today = new Date();
        const day = today.getDate();
        const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

        if (day === 20 || day === lastDay) {
            const reminderKey = `reminder_${today.getFullYear()}_${today.getMonth()}_${day}`;
            if (!localStorage.getItem(reminderKey)) {
                setTimeout(() => {
                    if (!getCurrentUser()) return;
                    if (confirm('ðŸ“§ Reminder: Today is a report submission day (20th or last day of month).\n\nWould you like to generate the attendance report now?')) {
                        this.showEmailModal();
                    }
                    localStorage.setItem(reminderKey, 'shown');
                }, 1000);
            }
        }
    }

    // --- Event Bindings ---
    bindEvents() {
        // Auth: Login / Register / Forgot Password
        document.getElementById('btnLogin').addEventListener('click', () => this.handleLogin());
        document.getElementById('loginPassword').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.handleLogin();
        });

        // Toggle password visibility
        document.getElementById('toggleLoginPw').addEventListener('click', () => {
            const input = document.getElementById('loginPassword');
            const toggle = document.getElementById('toggleLoginPw');
            if (input.type === 'password') { input.type = 'text'; toggle.textContent = 'ðŸ™ˆ'; }
            else { input.type = 'password'; toggle.textContent = 'ðŸ‘ï¸'; }
        });
        document.getElementById('toggleRegPw').addEventListener('click', () => {
            const input = document.getElementById('registerPassword');
            const toggle = document.getElementById('toggleRegPw');
            if (input.type === 'password') { input.type = 'text'; toggle.textContent = 'ðŸ™ˆ'; }
            else { input.type = 'password'; toggle.textContent = 'ðŸ‘ï¸'; }
        });

        document.getElementById('btnRegister').addEventListener('click', () => this.handleRegister());
        document.getElementById('registerConfirm').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.handleRegister();
        });

        document.getElementById('showRegister').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('loginForm').style.display = 'none';
            document.getElementById('registerForm').style.display = 'block';
            document.getElementById('forgotForm').style.display = 'none';
            document.getElementById('authModalTitle').textContent = 'ðŸ“ Register';
            this.loadTeamOptions();
        });

        document.getElementById('showLogin').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('loginForm').style.display = 'block';
            document.getElementById('registerForm').style.display = 'none';
            document.getElementById('forgotForm').style.display = 'none';
            document.getElementById('authModalTitle').textContent = 'ðŸ” Login';
        });

        document.getElementById('showForgotPassword').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('loginForm').style.display = 'none';
            document.getElementById('registerForm').style.display = 'none';
            document.getElementById('forgotForm').style.display = 'block';
            document.getElementById('authModalTitle').textContent = 'ðŸ”‘ Forgot Password';
        });

        document.getElementById('btnBackToLogin').addEventListener('click', () => {
            document.getElementById('loginForm').style.display = 'block';
            document.getElementById('registerForm').style.display = 'none';
            document.getElementById('forgotForm').style.display = 'none';
            document.getElementById('authModalTitle').textContent = 'ðŸ” Login';
        });

        // Logout in another tab (or cleared storage) locks this tab too
        window.addEventListener('storage', (e) => {
            if (e.key === 'attendance_current_user' && !e.newValue) this.lockApp();
        });
        window.addEventListener('pageshow', (e) => {
            if (e.persisted && !getCurrentUser()) this.lockApp();
        });

        // Close user modal with escape or close button (only if already logged in)
        document.getElementById('userModal').addEventListener('click', (e) => {
            if (e.target.id === 'userModal' || e.target.classList.contains('btn-close-user')) {
                if (getCurrentUser()) {
                    document.getElementById('userModal').classList.remove('active');
                }
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                // Auth modal: only close if user is logged in
                if (document.getElementById('userModal').classList.contains('active') && getCurrentUser()) {
                    document.getElementById('userModal').classList.remove('active');
                }
                if (document.getElementById('syncModal').classList.contains('active')) {
                    document.getElementById('syncModal').classList.remove('active');
                }
                if (document.getElementById('emailModal').classList.contains('active')) {
                    document.getElementById('emailModal').classList.remove('active');
                }
                const menu = document.getElementById('dayContextMenu');
                if (menu) menu.remove();
            }
        });

        // Team member selection - always switch to calendar view
        document.getElementById('teamList').addEventListener('click', (e) => {
            const li = e.target.closest('li');
            if (li) {
                if (!canViewMember(li.dataset.member)) return;
                this.selectedMember = li.dataset.member;
                this.renderTeamList();
                this.switchView('calendar');
            }
        });

        // Calendar day click - left click for present toggle, right click for options
        document.getElementById('calendarGrid').addEventListener('click', (e) => {
            const dayEl = e.target.closest('.calendar-day');
            if (dayEl && !dayEl.classList.contains('empty') &&
                !dayEl.classList.contains('weekend') &&
                !dayEl.classList.contains('holiday')) {
                const viewing = this.selectedMember;
                if (!getCurrentUser() || !canViewMember(viewing) || !canEdit(viewing)) return;

                const date = dayEl.dataset.date;
                const isFuture = dayEl.classList.contains('future');

                if (isFuture) {
                    // Only allow planning within 2 months
                    const twoMonthsAhead = new Date();
                    twoMonthsAhead.setMonth(twoMonthsAhead.getMonth() + 2);
                    if (new Date(date) > twoMonthsAhead) return;
                    this.showPlanningMenu(date, dayEl);
                } else {
                    const leaveType = this.data.getLeaveType(viewing, date);
                    if (leaveType) {
                        this.showDayMenu(date, dayEl);
                    } else {
                        const isPresent = this.data.isPresent(viewing, date);
                        this.data.markAttendance(viewing, date, !isPresent);
                        this.renderCalendar();
                    }
                }
            }
        });

        // Right-click for leave/exception menu
        document.getElementById('calendarGrid').addEventListener('contextmenu', (e) => {
            const dayEl = e.target.closest('.calendar-day');
            if (dayEl && !dayEl.classList.contains('empty') &&
                !dayEl.classList.contains('weekend') &&
                !dayEl.classList.contains('holiday')) {
                e.preventDefault();
                const viewing = this.selectedMember;
                if (!getCurrentUser() || !canViewMember(viewing) || !canEdit(viewing)) return;

                const date = dayEl.dataset.date;
                const isFuture = dayEl.classList.contains('future');

                if (isFuture) {
                    const twoMonthsAhead = new Date();
                    twoMonthsAhead.setMonth(twoMonthsAhead.getMonth() + 2);
                    if (new Date(date) > twoMonthsAhead) return;
                    this.showPlanningMenu(date, dayEl);
                } else {
                    this.showDayMenu(date, dayEl);
                }
            }
        });

        // Month navigation - Calendar
        document.getElementById('btnPrevMonth').addEventListener('click', () => {
            this.currentMonth--;
            if (this.currentMonth < 0) { this.currentMonth = 11; this.currentYear--; }
            this.renderCalendar();
        });

        document.getElementById('btnNextMonth').addEventListener('click', () => {
            this.currentMonth++;
            if (this.currentMonth > 11) { this.currentMonth = 0; this.currentYear++; }
            this.renderCalendar();
        });

        // Month navigation - Summary
        document.getElementById('btnPrevMonthSummary').addEventListener('click', () => {
            this.currentMonth--;
            if (this.currentMonth < 0) { this.currentMonth = 11; this.currentYear--; }
            this.renderSummary();
        });

        document.getElementById('btnNextMonthSummary').addEventListener('click', () => {
            this.currentMonth++;
            if (this.currentMonth > 11) { this.currentMonth = 0; this.currentYear++; }
            this.renderSummary();
        });

        // Summary table sorting
        document.getElementById('summaryTable').addEventListener('click', (e) => {
            const th = e.target.closest('.sortable');
            if (th) {
                const col = th.dataset.sort;
                if (this.sortColumn === col) {
                    this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    this.sortColumn = col;
                    this.sortDirection = 'asc';
                }
                this.renderSummary();
            }
        });

        // Theme toggle
        document.getElementById('btnThemeToggle').addEventListener('click', () => this.toggleTheme());

        // Visibility toggle (Superuser only: it is a global setting)
        document.getElementById('toggleVisibility').addEventListener('change', (e) => {
            if (!isSuperUser()) { e.target.checked = !e.target.checked; denyAction('Only the Superuser can change this setting.'); return; }
            if (typeof database !== 'undefined') {
                database.ref('settings/everyoneSeesAll').set(e.target.checked);
            }
            this.renderTeamList();
        });

        // View switching
        document.getElementById('btnCalendarView').addEventListener('click', () => this.switchView('calendar'));
        document.getElementById('btnSummaryView').addEventListener('click', () => this.switchView('summary'));
        document.getElementById('btnHolidayView').addEventListener('click', () => this.switchView('holiday'));
        document.getElementById('btnTeamView').addEventListener('click', () => this.switchView('team'));

        // Team management
        // Team management - Add member
        document.addEventListener('addMemberClick', async () => {
            const input = document.getElementById('memberName');
            const name = input.value;
            if (name && name.trim()) {
                await this.addMember(name, (document.getElementById('memberTeam') || {}).value);
                input.value = '';
            }
        });

        document.getElementById('memberName').addEventListener('keypress', async (e) => {
            if (e.key === 'Enter') {
                const input = document.getElementById('memberName');
                const name = input.value;
                if (name && name.trim()) {
                    await this.addMember(name, (document.getElementById('memberTeam') || {}).value);
                    input.value = '';
                }
            }
        });

        // Superuser: team assignment and Manager/Admin flags (each handler re-checks permission)
        document.getElementById('teamMemberList').addEventListener('change', (e) => {
            const t = e.target;
            const member = t.dataset ? t.dataset.member : null;
            if (!member) return;
            if (t.classList.contains('member-team-select')) {
                if (!this.assignTeam(member, t.value)) this.renderTeamManagement();
            } else if (t.classList.contains('chk-manager')) {
                if (!this.setManager(member, t.checked)) this.renderTeamManagement();
            } else if (t.classList.contains('chk-admin')) {
                if (!this.setAdminRole(member, t.checked)) this.renderTeamManagement();
            }
        });

        // Superuser: create / rename / delete teams
        const createTeamFromInput = () => {
            const input = document.getElementById('newTeamName');
            if (this.createTeam(input.value)) input.value = '';
        };
        document.getElementById('btnCreateTeam').addEventListener('click', createTeamFromInput);
        document.getElementById('newTeamName').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') createTeamFromInput();
        });
        document.getElementById('teamsAdminList').addEventListener('click', (e) => {
            const id = e.target.dataset ? e.target.dataset.team : null;
            if (!id) return;
            if (e.target.classList.contains('btn-team-rename')) this.renameTeam(id);
            else if (e.target.classList.contains('btn-team-delete')) this.deleteTeam(id);
        });

        document.getElementById('teamMemberList').addEventListener('click', (e) => {
            if (e.target.classList.contains('btn-delete')) {
                const member = e.target.dataset.member;
                this.removeMember(member);
            } else if (e.target.classList.contains('btn-edit')) {
                const member = e.target.dataset.member;
                this.editMember(member);
            } else if (e.target.classList.contains('btn-admin-add')) {
                const member = e.target.dataset.member;
                this.makeAdmin(member);
            } else if (e.target.classList.contains('btn-admin-remove')) {
                const member = e.target.dataset.member;
                this.removeAdmin(member);
            } else if (e.target.classList.contains('btn-reset-pw')) {
                const member = e.target.dataset.member;
                this.resetPasswordForMember(member);
            } else if (e.target.classList.contains('btn-restore')) {
                const member = e.target.dataset.member;
                this.restoreMember(member);
            }
        });

        // Holiday management
        document.getElementById('btnAddHoliday').addEventListener('click', () => {
            const date = document.getElementById('holidayDate').value;
            const name = document.getElementById('holidayName').value.trim();
            if (date && name) {
                this.data.addHoliday(date, name);
                document.getElementById('holidayDate').value = '';
                document.getElementById('holidayName').value = '';
                this.renderHolidays();
            }
        });

        document.getElementById('holidayList').addEventListener('click', (e) => {
            if (e.target.classList.contains('btn-delete')) {
                const date = e.target.dataset.date;
                this.data.removeHoliday(date);
                this.renderHolidays();
            }
        });

        // Email Report
        document.getElementById('btnEmailReport').addEventListener('click', () => this.showEmailModal());
        document.getElementById('btnCloseModal').addEventListener('click', () => {
            document.getElementById('emailModal').classList.remove('active');
        });

        // Report table sorting
        document.getElementById('reportDashboard').addEventListener('click', (e) => {
            const th = e.target.closest('.sortable-report');
            if (th) {
                const col = th.dataset.sort;
                if (this.sortColumn === col) {
                    this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    this.sortColumn = col;
                    this.sortDirection = 'asc';
                }
                document.getElementById('reportDashboard').innerHTML = this.generateDashboardReport();
            }
        });

        document.getElementById('btnCopyReport').addEventListener('click', () => {
            const emailHtml = this.generateEmailHTML();
            // Copy as rich HTML to clipboard so it pastes as a dashboard in Outlook/Teams
            const blob = new Blob([emailHtml], { type: 'text/html' });
            const clipboardItem = new ClipboardItem({ 'text/html': blob });
            navigator.clipboard.write([clipboardItem]).then(() => {
                alert('âœ… Dashboard report copied! Paste directly into Outlook or Teams â€” it will look like a visual dashboard.');
            }).catch(() => {
                // Fallback: copy as plain HTML source
                navigator.clipboard.writeText(emailHtml).then(() => {
                    alert('âœ… HTML report copied to clipboard! Paste into an email editor that supports HTML.');
                });
            });
        });

        document.getElementById('btnMailTo').addEventListener('click', () => {
            const monthNames = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];
            const subject = `Monthly Attendance Report - ${monthNames[this.currentMonth]} ${this.currentYear}`;
            const emailHtml = this.generateEmailHTML();

            // Create .eml with HTML body - this is the ONLY way to get rendered HTML into Outlook desktop
            const emlContent = 'MIME-Version: 1.0\r\nTo: \r\nSubject: ' + subject + '\r\nX-Unsent: 1\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n' + emailHtml;

            const blob = new Blob([emlContent], { type: 'message/rfc822' });
            const url = URL.createObjectURL(blob);

            // Use an iframe to trigger the .eml open directly without visible download
            let frame = document.getElementById('emlFrame');
            if (!frame) {
                frame = document.createElement('iframe');
                frame.id = 'emlFrame';
                frame.style.display = 'none';
                document.body.appendChild(frame);
            }
            frame.src = url;
        });

        // Sync to Teams
        document.getElementById('btnSyncTeams').addEventListener('click', () => this.showSyncModal());
        document.getElementById('btnCloseSyncModal').addEventListener('click', () => {
            document.getElementById('syncModal').classList.remove('active');
        });

        document.getElementById('syncExport').addEventListener('click', () => this.syncExport());
        document.getElementById('syncImport').addEventListener('click', () => this.syncImport());

        document.getElementById('syncModal').addEventListener('click', (e) => {
            if (e.target.id === 'syncModal') {
                document.getElementById('syncModal').classList.remove('active');
            }
        });

        // Close modal on outside click
        document.getElementById('emailModal').addEventListener('click', (e) => {
            if (e.target.id === 'emailModal') {
                document.getElementById('emailModal').classList.remove('active');
            }
        });
    }
}

// ==========================================
// INITIALIZE APP
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    new App();
});
