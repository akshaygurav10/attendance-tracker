// ==========================================
// ATTENDANCE TRACKER - Main Application
// ==========================================

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

const SUPER_ADMIN = "Akshay Gurav"; // Cannot be removed as admin

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
    if (saved) {
        const list = JSON.parse(saved);
        if (!list.includes(SUPER_ADMIN)) list.push(SUPER_ADMIN);
        return list;
    }
    return [SUPER_ADMIN];
}

function saveAdminList(admins) {
    localStorage.setItem('attendance_admin_list', JSON.stringify(admins));
    if (typeof database !== 'undefined') {
        database.ref('admins').set(admins);
    }
}

let ADMIN_MEMBERS = getAdminList();

function getCurrentUser() {
    return localStorage.getItem('attendance_current_user');
}

function setCurrentUser(name) {
    localStorage.setItem('attendance_current_user', name);
}

function isAdmin() {
    const user = getCurrentUser();
    if (!user) return false;
    if (user === SUPER_ADMIN) return true;
    return ADMIN_MEMBERS.includes(user);
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
    const currentUser = localStorage.getItem('attendance_current_user');
    if (!currentUser) return false;
    const isAdminUser = ADMIN_MEMBERS.indexOf(currentUser) !== -1 || currentUser === SUPER_ADMIN;
    if (isAdminUser) return true;
    return currentUser === member;
}

// ==========================================
// DATA MANAGEMENT (Firebase + localStorage)
// ==========================================

class AttendanceData {
    constructor(onDataLoaded) {
        this.onDataLoaded = onDataLoaded;
        this.data = this.getDefaultData();
        this.firebaseReady = false;
        this.load();
    }

    getDefaultData() {
        return {
            attendance: {},
            holidays: [],
            leaves: {},
            lastUpdated: new Date().toISOString()
        };
    }

    load() {
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

        // Then sync with Firebase
        if (typeof database !== 'undefined') {
            database.ref('appData').on('value', (snapshot) => {
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
                    // First time — push local data to Firebase
                    this.saveToFirebase();
                }
                this.firebaseReady = true;
                if (this.onDataLoaded) this.onDataLoaded();
            }, (error) => {
                console.error('Firebase read failed:', error);
            });

            // Sync team members
            database.ref('teamMembers').on('value', (snapshot) => {
                const members = snapshot.val();
                if (members && Array.isArray(members)) {
                    TEAM_MEMBERS = members.filter(m => m && m.trim() !== '');
                    localStorage.setItem('attendance_team_members', JSON.stringify(TEAM_MEMBERS));
                    if (this.onDataLoaded) this.onDataLoaded();
                } else {
                    // No team members in Firebase — start fresh
                    TEAM_MEMBERS = [];
                    localStorage.setItem('attendance_team_members', JSON.stringify([]));
                }
            });

            // Sync admin list
            database.ref('admins').on('value', (snapshot) => {
                const admins = snapshot.val();
                if (admins && Array.isArray(admins)) {
                    ADMIN_MEMBERS = admins;
                    localStorage.setItem('attendance_admin_list', JSON.stringify(admins));
                }
            });
        }
    }

    save() {
        this.data.lastUpdated = new Date().toISOString();
        localStorage.setItem('attendance_tracker_data', JSON.stringify(this.data));
        this.saveToFirebase();
    }

    saveToFirebase() {
        if (typeof database !== 'undefined') {
            // Firebase doesn't allow . $ # [ ] / in keys
            // Encode member names that contain these characters
            const sanitized = JSON.parse(JSON.stringify(this.data));
            
            // Sanitize attendance keys
            if (sanitized.attendance) {
                const cleanAttendance = {};
                for (const key in sanitized.attendance) {
                    cleanAttendance[key.replace(/\./g, '___DOT___')] = sanitized.attendance[key];
                }
                sanitized.attendance = cleanAttendance;
            }
            
            // Sanitize leaves keys
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
                    indicator.textContent = '🟢 Synced';
                    indicator.className = 'sync-indicator connected';
                    indicator.style.fontSize = '12px';
                }
            }).catch((error) => {
                console.error('Firebase save failed:', error);
                if (indicator) {
                    indicator.textContent = '🔴 ' + error.message;
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
        this.save();
    }

    markAttendance(member, date, present) {
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
        if (!this.data.holidays.find(h => h.date === date)) {
            this.data.holidays.push({ date, name });
            this.data.holidays.sort((a, b) => a.date.localeCompare(b.date));
            this.save();
        }
    }

    removeHoliday(date) {
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
                if (leaveType === 'leave' || leaveType === 'exception' || leaveType === 'wfh' || leaveType === 'wfh-email') {
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
        }
        return count;
    }

    getAttendancePercentage(member, year, month) {
        const workingDays = this.getEffectiveWorkingDays(member, year, month);
        if (workingDays === 0) return 0;
        const attended = this.getAttendanceCount(member, year, month);
        return Math.round((attended / workingDays) * 100);
    }

    exportJSON() {
        return JSON.stringify(this.data, null, 2);
    }

    importJSON(jsonStr) {
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
        // Re-render when Firebase sends new data
        this.selectedMember = this.selectedMember || TEAM_MEMBERS[0];
        this.renderTeamList();
        if (this.currentView === 'calendar') this.renderCalendar();
        else if (this.currentView === 'summary') this.renderSummary();
        else if (this.currentView === 'holiday') this.renderHolidays();
        else if (this.currentView === 'team') this.renderTeamManagement();
    }

    init() {
        this.loadTheme();
        this.showUserSelection();
        this.renderTeamList();
        this.renderCalendar();
        this.bindEvents();
        this.updateUIPermissions();
        this.checkEmailReminder();
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
        // Show login modal
        this.populateLoginDropdown();
    }

    populateLoginDropdown() {
        const select = document.getElementById('loginUsername');
        if (!select) return;
        select.innerHTML = '<option value="">-- Select your name --</option>';
        // Always show super admin in the list
        const allUsers = [...TEAM_MEMBERS];
        if (!allUsers.includes(SUPER_ADMIN)) {
            allUsers.unshift(SUPER_ADMIN);
        }
        // Filter nulls
        const filteredUsers = allUsers.filter(m => m && m.trim() !== '');

        // Fix 5: Show username alongside full name in dropdown
        if (typeof database !== 'undefined') {
            database.ref('users').once('value').then((snapshot) => {
                const users = snapshot.val() || {};
                filteredUsers.forEach(member => {
                    const sanitizedName = member.replace(/\./g, '___DOT___');
                    const userData = users[sanitizedName];
                    const uname = userData && userData.username ? userData.username : '';
                    const displayText = uname ? `${uname} (${member})` : member;
                    select.innerHTML += `<option value="${member}">${displayText}</option>`;
                });
            });
        } else {
            filteredUsers.forEach(member => {
                select.innerHTML += `<option value="${member}">${member}</option>`;
            });
        }
    }

    async handleLogin() {
        const username = document.getElementById('loginUsername').value;
        const password = document.getElementById('loginPassword').value;
        const errorEl = document.getElementById('loginError');

        if (!username) { errorEl.textContent = 'Please select your name.'; return; }
        if (!password) { errorEl.textContent = 'Please enter your password.'; return; }

        const hash = await hashPassword(password);

        if (typeof database !== 'undefined') {
            const sanitizedName = username.replace(/\./g, '___DOT___');
            try {
                // Check if terminated
                const userSnapshot = await database.ref('users/' + sanitizedName).once('value');
                const userData = userSnapshot.val();

                if (userData && userData.terminated === true) {
                    errorEl.textContent = 'Your account has been terminated. Contact admin.';
                    return;
                }

                const storedHash = userData ? userData.passwordHash : null;

                if (!storedHash) {
                    // Super admin first-time: auto-register with this password
                    if (username === SUPER_ADMIN) {
                        const uname = await generateUniqueUsername(username);
                        await database.ref('users/' + sanitizedName).set({
                            name: username,
                            passwordHash: hash,
                            registeredAt: new Date().toISOString(),
                            isAdmin: true,
                            isSuperAdmin: true,
                            terminated: false,
                            username: uname
                        });
                        // Add to team members
                        if (!TEAM_MEMBERS.includes(username)) {
                            TEAM_MEMBERS.push(username);
                            saveTeamMembers(TEAM_MEMBERS);
                        }
                    } else {
                        errorEl.textContent = 'User not registered. Please register first.';
                        return;
                    }
                } else if (hash !== storedHash) {
                    errorEl.textContent = 'Incorrect password.';
                    return;
                }

                // Fix 1: Check if user must reset password (restored user)
                if (userData && userData.mustResetPassword === true) {
                    errorEl.textContent = 'Please set a new password.';
                    let newPassword = null;
                    while (true) {
                        newPassword = prompt(`Your account was restored. Please set a new password (min 4 characters):`);
                        if (newPassword === null) return; // cancelled
                        if (newPassword.length >= 4) break;
                        alert('Password must be at least 4 characters. Try again.');
                    }
                    const confirmPassword = prompt('Confirm new password:');
                    if (newPassword !== confirmPassword) {
                        errorEl.textContent = 'Passwords do not match. Try logging in again.';
                        return;
                    }
                    const newHash = await hashPassword(newPassword);
                    await database.ref('users/' + sanitizedName + '/passwordHash').set(newHash);
                    await database.ref('users/' + sanitizedName + '/mustResetPassword').remove();
                    errorEl.textContent = '';
                }

                // Fix 5: Generate username for existing users who don't have one yet
                if (userData && !userData.username) {
                    const uname = await generateUniqueUsername(username);
                    await database.ref('users/' + sanitizedName + '/username').set(uname);
                }
            } catch (error) {
                errorEl.textContent = 'Connection error. Please try again.';
                return;
            }
        }

        // Login successful
        errorEl.textContent = '';
        localStorage.setItem('attendance_current_user', username);
        this.selectedMember = username;
        // Ensure user is in team members list
        if (!TEAM_MEMBERS.includes(username)) {
            TEAM_MEMBERS.push(username);
            saveTeamMembers(TEAM_MEMBERS);
        }
        document.getElementById('userModal').classList.remove('active');
        document.getElementById('loginPassword').value = '';
        this.updateUserDisplay();
        this.updateUIPermissions();
        this.renderTeamList();
        this.renderCalendar();
    }

    async handleRegister() {
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

            // Hash and save
            const hash = await hashPassword(password);
            const uname = await generateUniqueUsername(name);
            await database.ref('users/' + sanitizedName).set({
                name: name,
                passwordHash: hash,
                registeredAt: new Date().toISOString(),
                isAdmin: false,
                username: uname
            });

            // Add to team members if not already there
            if (!TEAM_MEMBERS.includes(name)) {
                TEAM_MEMBERS.push(name);
                saveTeamMembers(TEAM_MEMBERS);
            }
        }

        // Auto-login after register
        errorEl.textContent = '';
        localStorage.setItem('attendance_current_user', name);
        this.selectedMember = name;
        document.getElementById('userModal').classList.remove('active');
        document.getElementById('registerName').value = '';
        document.getElementById('registerPassword').value = '';
        document.getElementById('registerConfirm').value = '';
        this.updateUserDisplay();
        this.updateUIPermissions();
        this.renderTeamList();
        this.renderCalendar();
    }

    async resetPasswordForMember(member) {
        if (!isAdmin()) {
            alert('Only admins can reset passwords.');
            return;
        }
        // Fix 6: Loop until valid password entered or cancelled
        let newPassword = null;
        while (true) {
            newPassword = prompt(`Set new password for "${member}" (min 4 characters):`);
            if (newPassword === null) return; // cancelled
            if (newPassword.length >= 4) break;
            alert('Password must be at least 4 characters. Try again.');
        }
        const hash = await hashPassword(newPassword);
        const sanitizedName = member.replace(/\./g, '___DOT___');
        await database.ref('users/' + sanitizedName + '/passwordHash').set(hash);
        alert(`Password reset for ${member}.`);
    }

    updateUserDisplay() {
        const user = getCurrentUser();
        const display = document.getElementById('currentUserDisplay');
        if (user) {
            const badge = isAdmin() ? ' 👑' : '';
            // Fix 5: Show username instead of full name
            const sanitizedName = user.replace(/\./g, '___DOT___');
            if (typeof database !== 'undefined') {
                database.ref('users/' + sanitizedName + '/username').once('value').then((snapshot) => {
                    const uname = snapshot.val() || user;
                    display.innerHTML = `<span class="logged-in-label">Logged in:</span> ${uname}${badge} <span class="switch-user-btn" id="btnChangePassword">🔑</span> <span class="switch-user-btn" id="btnLogout">⇄ Logout</span>`;
                    this.bindUserDisplayEvents(display);
                });
            } else {
                display.innerHTML = `<span class="logged-in-label">Logged in:</span> ${user}${badge} <span class="switch-user-btn" id="btnChangePassword">🔑</span> <span class="switch-user-btn" id="btnLogout">⇄ Logout</span>`;
                this.bindUserDisplayEvents(display);
            }
        } else {
            display.innerHTML = '';
        }
    }

    bindUserDisplayEvents(display) {
        document.getElementById('btnLogout').onclick = () => {
            localStorage.removeItem('attendance_current_user');
            document.getElementById('userModal').classList.add('active');
            document.getElementById('loginForm').style.display = 'block';
            document.getElementById('registerForm').style.display = 'none';
            document.getElementById('forgotForm').style.display = 'none';
            document.getElementById('loginError').textContent = '';
            document.getElementById('loginPassword').value = '';
            this.populateLoginDropdown();
            display.innerHTML = '';
        };
        document.getElementById('btnChangePassword').onclick = () => {
            this.changeOwnPassword();
        };
    }

    // Fix 3: Hide/show UI elements based on permissions
    updateUIPermissions() {
        const admin = isAdmin();
        const holidayBtn = document.getElementById('btnHolidayView');
        if (holidayBtn) holidayBtn.style.display = admin ? 'block' : 'none';
        const teamBtn = document.getElementById('btnTeamView');
        if (teamBtn) teamBtn.style.display = admin ? 'block' : 'none';
        const syncBtn = document.getElementById('btnSyncTeams');
        if (syncBtn) syncBtn.style.display = admin ? '' : 'none';
        const reportBtn = document.getElementById('btnEmailReport');
        if (reportBtn) reportBtn.style.display = admin ? '' : 'none';
    }

    async changeOwnPassword() {
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
            alert('❌ Current password is incorrect.');
            return;
        }

        const newPassword = prompt('Enter new password (min 4 characters):');
        if (!newPassword || newPassword.length < 4) {
            alert('Password must be at least 4 characters.');
            return;
        }

        const confirmPassword = prompt('Confirm new password:');
        if (newPassword !== confirmPassword) {
            alert('❌ Passwords do not match.');
            return;
        }

        const newHash = await hashPassword(newPassword);
        await database.ref('users/' + sanitizedName + '/passwordHash').set(newHash);
        alert('✅ Password changed successfully.');
    }

    // --- Team List ---
    renderTeamList() {
        const list = document.getElementById('teamList');
        const currentUser = getCurrentUser();
        // Put logged-in user on top
        let orderedMembers = [...TEAM_MEMBERS];
        if (currentUser && orderedMembers.includes(currentUser)) {
            orderedMembers = orderedMembers.filter(m => m !== currentUser);
            orderedMembers.unshift(currentUser);
        }
        list.innerHTML = orderedMembers.map((member, i) => {
            const initials = member.split(' ').map(n => n[0]).join('').substring(0, 2);
            const isActive = member === this.selectedMember ? 'active' : '';
            const isMe = member === currentUser ? '<span class="me-tag">(You)</span>' : '';
            return `<li class="${isActive}" data-member="${member}">
                <span class="avatar" style="background:${AVATAR_COLORS[i % AVATAR_COLORS.length]}">${initials}</span>
                ${member} ${isMe}
            </li>`;
        }).join('');
    }

    // --- Calendar ---
    renderCalendar() {
        const monthNames = ["January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"];

        document.getElementById('currentMonthYear').textContent =
            `${monthNames[this.currentMonth]} ${this.currentYear}`;

        this.renderViewingInfo();
        this.renderStats();
        this.renderCalendarGrid();
    }

    renderViewingInfo() {
        const currentUser = localStorage.getItem('attendance_current_user');
        const viewing = this.selectedMember;
        const info = document.getElementById('viewingInfo');
        if (!info) return;
        const isAdminUser = currentUser && (ADMIN_MEMBERS.indexOf(currentUser) !== -1 || currentUser === SUPER_ADMIN);
        const isSelf = currentUser && currentUser === viewing;

        if (isSelf) {
            info.innerHTML = `<span class="viewing-member editing">📝 Editing: ${viewing}</span>`;
        } else if (isAdminUser) {
            info.innerHTML = `<span class="viewing-member editing">📝 Admin Editing: ${viewing}</span>`;
        } else {
            info.innerHTML = `<span class="view-only-tag">👁️ View Only</span> <span class="viewing-member">Viewing: ${viewing}</span>`;
        }
    }

    renderStats() {
        const workingDays = this.data.getEffectiveWorkingDays(this.selectedMember, this.currentYear, this.currentMonth);
        const attended = this.data.getAttendanceCount(this.selectedMember, this.currentYear, this.currentMonth);
        const percentage = this.data.getAttendancePercentage(this.selectedMember, this.currentYear, this.currentMonth);
        const required = Math.ceil(workingDays * REQUIRED_PERCENTAGE / 100);

        const statusColor = percentage >= REQUIRED_PERCENTAGE ? 'green' : (percentage >= 40 ? 'orange' : 'red');

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
                <span class="stat-label">Required (60%)</span>
                <span class="stat-value orange">${required}</span>
            </div>
            <div class="stat-card">
                <span class="stat-label">Attendance %</span>
                <span class="stat-value ${statusColor}">${percentage}%</span>
            </div>
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

            let classes = ['calendar-day'];
            let statusIcon = '';
            let title = '';

            if (isWeekend) {
                classes.push('weekend');
                statusIcon = '🔒';
                title = 'Weekend';
            } else if (isHoliday) {
                classes.push('holiday');
                statusIcon = '🏖️';
                title = this.data.getHolidayName(dateStr);
            } else if (leaveType) {
                if (leaveType === 'leave') {
                    classes.push('on-leave');
                    statusIcon = '🚫';
                    title = 'Leave (not counted as working day)';
                } else if (leaveType === 'wfh') {
                    classes.push('wfh');
                    statusIcon = '🏠';
                    title = 'Work From Home (not counted as working day)';
                } else if (leaveType === 'wfh-email') {
                    classes.push('wfh-email');
                    statusIcon = '📧';
                    title = 'WFH Email (excluded from total days)';
                } else if (leaveType === 'exception') {
                    classes.push('exception');
                    statusIcon = '⚡';
                    title = 'Exception (not counted as working day)';
                }
            } else if (isToday) {
                if (isPresent) {
                    classes.push('present');
                    statusIcon = '✅';
                }
            } else if (isFuture) {
                classes.push('future');
            } else if (isPresent) {
                classes.push('present');
                statusIcon = '✅';
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
            <button class="menu-item ${isPresent && !leaveType ? 'active' : ''}" data-action="present">✅ Present</button>
            <button class="menu-item ${leaveType === 'leave' ? 'active' : ''}" data-action="leave">🚫 Leave</button>
            <button class="menu-item ${leaveType === 'wfh' ? 'active' : ''}" data-action="wfh">🏠 Work From Home</button>
            <button class="menu-item ${leaveType === 'wfh-email' ? 'active' : ''}" data-action="wfh-email">📧 WFH Email</button>
            <button class="menu-item ${leaveType === 'exception' ? 'active' : ''}" data-action="exception">⚡ Exception</button>
            <hr>
            <button class="menu-item" data-action="clear">❌ Clear</button>
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

    // --- Summary View ---
    renderSummary() {
        const monthNames = ["January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"];

        document.getElementById('summaryMonthYear').textContent =
            `${monthNames[this.currentMonth]} ${this.currentYear}`;

        const workingDays = this.data.getWorkingDays(this.currentYear, this.currentMonth);

        // Build data array
        let memberData = TEAM_MEMBERS.map(member => {
            const attended = this.data.getAttendanceCount(member, this.currentYear, this.currentMonth);
            const percentage = this.data.getAttendancePercentage(member, this.currentYear, this.currentMonth);
            let statusClass, statusText, statusOrder;
            if (percentage >= REQUIRED_PERCENTAGE) {
                statusClass = 'compliant'; statusText = '✓ Compliant'; statusOrder = 1;
            } else if (percentage >= 40) {
                statusClass = 'on-track'; statusText = '⚠ At Risk'; statusOrder = 2;
            } else {
                statusClass = 'non-compliant'; statusText = '✗ Non-Compliant'; statusOrder = 3;
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
                return this.sortDirection === 'asc' ? ' ▲' : ' ▼';
            }
            return ' ⇅';
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
                <td>${m.name}</td>
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
                    <span class="holiday-date">📅 ${dateDisplay}</span>
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
        const currentUserIsAdmin = isAdmin();
        let html = TEAM_MEMBERS.map((member, i) => {
            const initials = member.split(' ').map(n => n[0]).join('').substring(0, 2);
            const memberIsAdmin = ADMIN_MEMBERS.includes(member);
            const isSuperAdmin = member === SUPER_ADMIN;
            let adminBtn = '';
            if (currentUserIsAdmin) {
                if (memberIsAdmin && !isSuperAdmin) {
                    adminBtn = `<button class="btn-admin btn-admin-remove" data-member="${member}" title="Remove admin role">👑 Remove Admin</button>`;
                } else if (!memberIsAdmin) {
                    adminBtn = `<button class="btn-admin btn-admin-add" data-member="${member}" title="Make admin">Make Admin</button>`;
                } else if (isSuperAdmin) {
                    adminBtn = `<span class="super-admin-badge">👑 Super Admin</span>`;
                }
            } else if (memberIsAdmin) {
                adminBtn = `<span class="admin-tag">Admin</span>`;
            }

            return `<div class="team-member-item" draggable="true" data-index="${i}" data-member="${member}">
                <div class="team-member-info">
                    <span class="drag-handle" title="Drag to reorder">☰</span>
                    <span class="avatar" style="background:${AVATAR_COLORS[i % AVATAR_COLORS.length]}">${initials}</span>
                    <span class="team-member-name">${member}</span>
                    ${adminBtn}
                </div>
                <div class="team-member-actions">
                    <button class="btn-edit" data-member="${member}" title="Edit name">✏️</button>
                    ${currentUserIsAdmin ? `<button class="btn-reset-pw" data-member="${member}" title="Reset password">🔑</button>` : ''}
                    <button class="btn-delete" data-member="${member}" title="Remove">Remove</button>
                </div>
            </div>`;
        }).join('');

        if (TEAM_MEMBERS.length === 0) {
            html = '<p style="color: var(--text-secondary); padding: 20px;">No team members added yet.</p>';
        }

        // Show terminated users section (admin only)
        if (currentUserIsAdmin) {
            html += `<div id="terminatedSection"></div>`;
        }

        list.innerHTML = html;

        // Load terminated users from Firebase
        if (currentUserIsAdmin && typeof database !== 'undefined') {
            database.ref('users').once('value').then((snapshot) => {
                const users = snapshot.val();
                if (!users) return;
                const terminatedUsers = [];
                for (const key in users) {
                    const user = users[key];
                    if (user.terminated === true) {
                        terminatedUsers.push(user.name || key.replace(/___DOT___/g, '.'));
                    }
                }
                const section = document.getElementById('terminatedSection');
                if (section && terminatedUsers.length > 0) {
                    section.innerHTML = `
                        <h4 class="terminated-header">🚫 Terminated Members (${terminatedUsers.length})</h4>
                        ${terminatedUsers.map(name => `
                            <div class="team-member-item terminated-item">
                                <div class="team-member-info">
                                    <span class="avatar" style="background:#666">✗</span>
                                    <span class="team-member-name terminated-name">${name}</span>
                                </div>
                                <div class="team-member-actions">
                                    <button class="btn-restore" data-member="${name}" title="Restore member">♻️ Restore</button>
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
        let draggedIndex = -1;

        list.querySelectorAll('.team-member-item').forEach(item => {
            item.addEventListener('dragstart', (e) => {
                draggedItem = item;
                draggedIndex = parseInt(item.dataset.index);
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
                const dropIndex = parseInt(item.dataset.index);
                if (draggedIndex !== dropIndex && draggedIndex >= 0) {
                    // Reorder array
                    const movedMember = TEAM_MEMBERS.splice(draggedIndex, 1)[0];
                    TEAM_MEMBERS.splice(dropIndex, 0, movedMember);
                    saveTeamMembers(TEAM_MEMBERS);
                    this.renderTeamManagement();
                    this.renderTeamList();
                }
            });
        });
    }

    resetTeamToDefault() {
        if (!isAdmin()) {
            alert('⚠️ Only admins can reset the team list.');
            return;
        }
        if (!confirm('Reset team list to the default members?\n\nThis will replace the current list. Attendance data is preserved.')) return;
        TEAM_MEMBERS = [...DEFAULT_TEAM_MEMBERS];
        saveTeamMembers(TEAM_MEMBERS);
        this.selectedMember = TEAM_MEMBERS[0];
        this.renderTeamList();
        this.renderTeamManagement();
    }

    // --- Admin Management ---
    makeAdmin(member) {
        if (!isAdmin()) return;
        if (ADMIN_MEMBERS.includes(member)) return;
        if (!confirm(`Make "${member}" an admin?\n\nAdmins can edit everyone's attendance and manage the team.`)) return;
        ADMIN_MEMBERS.push(member);
        saveAdminList(ADMIN_MEMBERS);
        // Update in Firebase
        if (typeof database !== 'undefined') {
            const sanitizedName = member.replace(/\./g, '___DOT___');
            database.ref('users/' + sanitizedName + '/isAdmin').set(true);
        }
        this.renderTeamManagement();
    }

    removeAdmin(member) {
        if (!isAdmin()) return;
        if (member === SUPER_ADMIN) {
            alert('⚠️ Cannot remove the super admin.');
            return;
        }
        // Fix 4: Only SUPER_ADMIN can remove other admins
        if (getCurrentUser() !== SUPER_ADMIN) {
            alert('⚠️ Only super admin can remove other admins.');
            return;
        }
        if (!confirm(`Remove admin rights from "${member}"?`)) return;
        ADMIN_MEMBERS = ADMIN_MEMBERS.filter(m => m !== member);
        saveAdminList(ADMIN_MEMBERS);
        this.renderTeamManagement();
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
        btn.textContent = isLight ? '🌙 Dark' : '☀️ Light';
    }

    loadTheme() {
        const saved = localStorage.getItem('attendance_theme');
        if (saved === 'light') {
            document.body.classList.add('light-theme');
        }
        this.updateThemeButton();
    }

    async addMember(name) {
        if (!isAdmin()) {
            alert('⚠️ Only admins can add team members.');
            return;
        }
        if (!name || name.trim() === '') return;
        name = name.trim();
        if (TEAM_MEMBERS.includes(name)) {
            alert('⚠️ This member already exists!');
            return;
        }

        // Check if member exists in Firebase (might be terminated)
        try {
            if (typeof database !== 'undefined') {
                const sanitizedName = name.replace(/\./g, '___DOT___');
                const snapshot = await database.ref('users/' + sanitizedName).once('value');
                const userData = snapshot.val();
                if (userData && userData.terminated === true) {
                    if (confirm(`"${name}" is a terminated member. Do you want to restore them instead?`)) {
                        await this.restoreMember(name);
                    }
                    return;
                }
            }
        } catch (e) {
            // Ignore Firebase errors — just add locally
        }

        // Add to team members — they can register themselves later
        TEAM_MEMBERS.push(name);
        saveTeamMembers(TEAM_MEMBERS);
        this.selectedMember = name;
        this.renderTeamList();
        this.renderTeamManagement();
        this.renderCalendar();
    }

    editMember(oldName) {
        if (!isAdmin()) {
            alert('⚠️ Only admins can edit team member names.');
            return;
        }
        const newName = prompt(`Edit name for "${oldName}":`, oldName);
        if (!newName || newName.trim() === '' || newName.trim() === oldName) return;
        const trimmed = newName.trim();
        if (TEAM_MEMBERS.includes(trimmed)) {
            alert('⚠️ A member with this name already exists!');
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
            alert('⚠️ Only admins can remove team members.');
            return;
        }
        if (name === SUPER_ADMIN) {
            alert('⚠️ Cannot remove the super admin.');
            return;
        }
        if (!confirm(`Are you sure you want to remove "${name}" from the team?\n\nThey will be marked as terminated but can be restored later.`)) return;

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
        if (!isAdmin()) return;

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
        document.getElementById('syncModal').classList.add('active');
        document.getElementById('syncStatus').className = 'sync-status';
        document.getElementById('syncStatus').textContent = '';
    }

    syncExport() {
        const json = this.data.exportJSON();
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
        status.textContent = '✅ File downloaded! Upload it to your Teams channel → Files tab to share with the team.';
    }

    syncImport() {
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
                        status.textContent = '✅ Data synced successfully! All attendance records are now up to date.';
                        this.renderCalendar();
                        this.renderTeamList();
                    } else {
                        status.className = 'sync-status error';
                        status.textContent = '❌ Invalid file. Please use a valid attendance JSON file from your team.';
                    }
                };
                reader.readAsText(file);
            }
        };
        input.click();
    }

    // --- Monthly Dashboard Report ---
    generateDashboardReport() {
        const monthNames = ["January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"];

        const workingDays = this.data.getWorkingDays(this.currentYear, this.currentMonth);
        const today = new Date();
        const reportDate = `${today.getDate()} ${monthNames[today.getMonth()]} ${today.getFullYear()}`;

        let compliantCount = 0;
        let totalAttended = 0;
        const memberData = [];

        TEAM_MEMBERS.forEach(member => {
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

        const avgAttendance = workingDays > 0 ? Math.round((totalAttended / (TEAM_MEMBERS.length * workingDays)) * 100) : 0;

        const getArrow = (col) => {
            if (this.sortColumn === col) {
                return this.sortDirection === 'asc' ? ' ▲' : ' ▼';
            }
            return ' ⇅';
        };

        let html = `
            <div class="report-header">
                <h1>📊 Monthly Attendance Report</h1>
                <div class="report-subtitle">${monthNames[this.currentMonth]} ${this.currentYear}</div>
                <div class="report-date">Generated on ${reportDate}</div>
            </div>

            <div class="report-kpis">
                <div class="report-kpi">
                    <span class="kpi-value blue">${TEAM_MEMBERS.length}</span>
                    <span class="kpi-label">Team Members</span>
                </div>
                <div class="report-kpi">
                    <span class="kpi-value blue">${workingDays}</span>
                    <span class="kpi-label">Working Days</span>
                </div>
                <div class="report-kpi">
                    <span class="kpi-value green">${compliantCount}</span>
                    <span class="kpi-label">Compliant (≥60%)</span>
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
                badgeText = '✓ Compliant';
            } else if (m.percentage >= 40) {
                badgeClass = 'badge-orange';
                badgeText = '⚠ At Risk';
            } else {
                badgeClass = 'badge-red';
                badgeText = '✗ Non-Compliant';
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
                <span>Compliance: ${compliantCount}/${TEAM_MEMBERS.length} members</span>
                <span>Report by: Attendance Tracker</span>
            </div>`;

        return html;
    }

    generateEmailHTML() {
        const monthNames = ["January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"];

        const workingDays = this.data.getWorkingDays(this.currentYear, this.currentMonth);
        const today = new Date();
        const reportDate = `${today.getDate()} ${monthNames[today.getMonth()]} ${today.getFullYear()}`;

        let compliantCount = 0;
        let totalAttended = 0;
        const memberData = [];

        TEAM_MEMBERS.forEach(member => {
            const attended = this.data.getAttendanceCount(member, this.currentYear, this.currentMonth);
            const percentage = this.data.getAttendancePercentage(member, this.currentYear, this.currentMonth);
            if (percentage >= REQUIRED_PERCENTAGE) compliantCount++;
            totalAttended += attended;
            memberData.push({ name: member, attended, percentage });
        });

        const avgAttendance = workingDays > 0 ? Math.round((totalAttended / (TEAM_MEMBERS.length * workingDays)) * 100) : 0;

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
<h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:600;">📊 Monthly Attendance Report</h1>
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
<div style="font-size:28px;font-weight:700;color:#0052CC;">${TEAM_MEMBERS.length}</div>
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
<div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;">Compliant (≥60%)</div>
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
                badgeBg = '#d4edda'; badgeColor = '#155724'; badgeText = '✓ Compliant';
            } else if (m.percentage >= 40) {
                badgeBg = '#fff3cd'; badgeColor = '#856404'; badgeText = '⚠ At Risk';
            } else {
                badgeBg = '#f8d7da'; badgeColor = '#721c24'; badgeText = '✗ Non-Compliant';
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
<td style="font-size:11px;color:#888;text-align:center;">Compliance: ${compliantCount}/${TEAM_MEMBERS.length} members</td>
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
        const dashboardHtml = this.generateDashboardReport();
        document.getElementById('reportDashboard').innerHTML = dashboardHtml;
        document.getElementById('emailModal').classList.add('active');
    }

    // --- Email Reminder Check ---
    checkEmailReminder() {
        const today = new Date();
        const day = today.getDate();
        const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

        if (day === 20 || day === lastDay) {
            const reminderKey = `reminder_${today.getFullYear()}_${today.getMonth()}_${day}`;
            if (!localStorage.getItem(reminderKey)) {
                setTimeout(() => {
                    if (confirm('📧 Reminder: Today is a report submission day (20th or last day of month).\n\nWould you like to generate the attendance report now?')) {
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
            if (input.type === 'password') { input.type = 'text'; toggle.textContent = '🙈'; }
            else { input.type = 'password'; toggle.textContent = '👁️'; }
        });
        document.getElementById('toggleRegPw').addEventListener('click', () => {
            const input = document.getElementById('registerPassword');
            const toggle = document.getElementById('toggleRegPw');
            if (input.type === 'password') { input.type = 'text'; toggle.textContent = '🙈'; }
            else { input.type = 'password'; toggle.textContent = '👁️'; }
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
            document.getElementById('authModalTitle').textContent = '📝 Register';
        });

        document.getElementById('showLogin').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('loginForm').style.display = 'block';
            document.getElementById('registerForm').style.display = 'none';
            document.getElementById('forgotForm').style.display = 'none';
            document.getElementById('authModalTitle').textContent = '🔐 Login';
        });

        document.getElementById('showForgotPassword').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('loginForm').style.display = 'none';
            document.getElementById('registerForm').style.display = 'none';
            document.getElementById('forgotForm').style.display = 'block';
            document.getElementById('authModalTitle').textContent = '🔑 Forgot Password';
        });

        document.getElementById('btnBackToLogin').addEventListener('click', () => {
            document.getElementById('loginForm').style.display = 'block';
            document.getElementById('registerForm').style.display = 'none';
            document.getElementById('forgotForm').style.display = 'none';
            document.getElementById('authModalTitle').textContent = '🔐 Login';
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
                !dayEl.classList.contains('holiday') &&
                !dayEl.classList.contains('future')) {
                const currentUser = localStorage.getItem('attendance_current_user');
                const viewing = this.selectedMember;
                if (!currentUser) return;
                // Check permission: admin OR own calendar
                const isAdminUser = ADMIN_MEMBERS.indexOf(currentUser) !== -1 || currentUser === SUPER_ADMIN;
                const isSelf = currentUser === viewing;
                if (!isAdminUser && !isSelf) {
                    return;
                }
                const date = dayEl.dataset.date;
                const leaveType = this.data.getLeaveType(viewing, date);
                if (leaveType) {
                    this.showDayMenu(date, dayEl);
                } else {
                    const isPresent = this.data.isPresent(viewing, date);
                    this.data.markAttendance(viewing, date, !isPresent);
                    this.renderCalendar();
                }
            }
        });

        // Right-click for leave/exception menu
        document.getElementById('calendarGrid').addEventListener('contextmenu', (e) => {
            const dayEl = e.target.closest('.calendar-day');
            if (dayEl && !dayEl.classList.contains('empty') &&
                !dayEl.classList.contains('weekend') &&
                !dayEl.classList.contains('holiday') &&
                !dayEl.classList.contains('future')) {
                e.preventDefault();
                const currentUser = localStorage.getItem('attendance_current_user');
                const viewing = this.selectedMember;
                if (!currentUser) return;
                const isAdminUser = ADMIN_MEMBERS.indexOf(currentUser) !== -1 || currentUser === SUPER_ADMIN;
                const isSelf = currentUser === viewing;
                if (!isAdminUser && !isSelf) {
                    return;
                }
                const date = dayEl.dataset.date;
                this.showDayMenu(date, dayEl);
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
                await this.addMember(name);
                input.value = '';
            }
        });

        document.getElementById('memberName').addEventListener('keypress', async (e) => {
            if (e.key === 'Enter') {
                const input = document.getElementById('memberName');
                const name = input.value;
                if (name && name.trim()) {
                    await this.addMember(name);
                    input.value = '';
                }
            }
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
                alert('✅ Dashboard report copied! Paste directly into Outlook or Teams — it will look like a visual dashboard.');
            }).catch(() => {
                // Fallback: copy as plain HTML source
                navigator.clipboard.writeText(emailHtml).then(() => {
                    alert('✅ HTML report copied to clipboard! Paste into an email editor that supports HTML.');
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
