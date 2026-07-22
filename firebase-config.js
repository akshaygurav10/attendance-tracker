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
firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// Monitor connection status
database.ref('.info/connected').on('value', (snapshot) => {
    const indicator = document.getElementById('syncIndicator');
    if (indicator) {
        if (snapshot.val() === true) {
            indicator.className = 'sync-indicator connected';
            indicator.title = 'Connected to cloud - data syncs in real-time';
        } else {
            indicator.className = 'sync-indicator disconnected';
            indicator.title = 'Disconnected - working offline (data saved locally)';
        }
    }
});
