// ==========================================
// FIREBASE CONFIGURATION
// ==========================================

const firebaseConfig = {
    apiKey: "AIzaSyClCYh21_u4LTnlIP9tl0ahHrVQEvvFIgM",
    authDomain: "attendance-tracker-dca2b.firebaseapp.com",
    projectId: "attendance-tracker-dca2b",
    storageBucket: "attendance-tracker-dca2b.firebasestorage.app",
    messagingSenderId: "1073028755352",
    appId: "1:1073028755352:web:ee8a2f917970f21c8045ed",
    measurementId: "G-P5E39BVNCB",
    databaseURL: "https://attendance-tracker-dca2b-default-rtdb.asia-southeast1.firebasedatabase.app"
};

// Initialize Firebase
const app = firebase.initializeApp(firebaseConfig);
const database = firebase.database(app);

// Test Firebase connection immediately
database.ref('connectionTest').set({ timestamp: Date.now(), status: 'connected' })
    .then(() => {
        const indicator = document.getElementById('syncIndicator');
        if (indicator) {
            indicator.textContent = '🟢 Connected';
            indicator.className = 'sync-indicator connected';
            indicator.style.fontSize = '12px';
        }
    })
    .catch((error) => {
        const indicator = document.getElementById('syncIndicator');
        if (indicator) {
            indicator.textContent = '🔴 ' + error.message;
            indicator.className = 'sync-indicator disconnected';
            indicator.style.fontSize = '12px';
        }
    });

// Monitor connection status
database.ref('.info/connected').on('value', (snapshot) => {
    const indicator = document.getElementById('syncIndicator');
    if (indicator) {
        if (snapshot.val() === true) {
            indicator.textContent = '🟢 Synced';
            indicator.className = 'sync-indicator connected';
            indicator.style.fontSize = '12px';
        } else {
            indicator.textContent = '🔴 Offline';
            indicator.className = 'sync-indicator disconnected';
            indicator.style.fontSize = '12px';
        }
    }
});
