// ==========================================
// OPTIONAL FIREBASE APP CHECK (reCAPTCHA v3)
// ==========================================
// Off by default: with APP_CHECK_SITE_KEY = "" (firebase-config.js) this file
// loads nothing and calls nothing. App Check raises the bar against copied or
// scripted clients; it is NOT authorization. The database rules are.
//
// Loaded by index.html right after firebase-config.js. When a key is set it runs
// twice: pass 1 writes the App Check SDK tag and a second copy of this file into
// the page (document.write keeps the load synchronous, so activation happens
// before app.js runs); pass 2 activates. Any failure is swallowed: the app must
// keep working without App Check.
(function () {
    var SDK = 'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-check-compat.js';
    try {
        var key = (typeof APP_CHECK_SITE_KEY !== 'undefined') ? APP_CHECK_SITE_KEY : '';
        if (typeof key !== 'string' || key.trim() === '') return; // disabled
        if (globalThis.__appCheckActivated) return;

        if (typeof firebase !== 'undefined' && typeof firebase.appCheck === 'function') {
            globalThis.__appCheckActivated = true;
            firebase.appCheck().activate(key.trim(), true); // true = auto-refresh tokens
            return;
        }
        if (globalThis.__appCheckTried) return; // SDK failed to load: continue without it
        globalThis.__appCheckTried = true;
        document.write('<script src="' + SDK + '"><\/script>');
        document.write('<script src="app-check-init.js"><\/script>');
    } catch (e) {
        if (typeof console !== 'undefined' && console.warn) console.warn('App Check not started:', e && e.message);
    }
})();
