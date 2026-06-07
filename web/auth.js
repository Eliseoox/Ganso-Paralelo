// auth.js — Módulo de autenticación y roles
(function () {
    'use strict';

    let _user = null;
    let _profile = null;
    let _ready = false;
    let _queue = [];

    firebase.auth().onAuthStateChanged(async (user) => {
        _user = user;
        if (user) {
            try {
                const doc = await firebase.firestore().collection('users').doc(user.uid).get();
                _profile = doc.exists
                    ? { id: user.uid, ...doc.data() }
                    : { id: user.uid, name: user.email, email: user.email, role: 'profesor', institutionId: '' };
            } catch (_) {
                _profile = { id: user.uid, name: user.email, email: user.email, role: 'profesor', institutionId: '' };
            }
        } else {
            _profile = null;
        }
        _ready = true;
        _queue.forEach(fn => fn(_profile));
        _queue = [];
    });

    // APK (Capacitor): forzar re-login si la app estuvo en background más de 15 minutos.
    // Cambios breves (notificaciones, llamadas cortas) no interrumpen la sesión.
    // En web/Electron el sessionStorage se limpia solo al cerrar pestaña/ventana.
    if (typeof window.Capacitor !== 'undefined') {
        var _bgTimestamp = null;
        var APK_REAUTH_MS = 15 * 60 * 1000;
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'hidden') {
                _bgTimestamp = Date.now();
            } else if (document.visibilityState === 'visible' &&
                       !window.location.href.includes('login.html')) {
                var elapsed = _bgTimestamp ? (Date.now() - _bgTimestamp) : 0;
                _bgTimestamp = null;
                if (elapsed >= APK_REAUTH_MS) {
                    sessionStorage.removeItem('gp_authenticated');
                    window._gansoNavAway = true;
                    firebase.auth().signOut().catch(function () {});
                    window.location.href = 'login.html';
                }
            }
        });
    }

    window.Auth = {
        onReady(fn) {
            if (_ready) { fn(_profile); } else { _queue.push(fn); }
        },

        requireAuth(allowedRoles) {
            // sessionStorage is cleared when the WebView/tab is destroyed (app closed).
            // This forces re-login on every fresh app open even if Firebase LOCAL persistence
            // kept a cached session (relevant for the Android APK).
            if (!sessionStorage.getItem('gp_authenticated')) {
                window.location.href = 'login.html';
                return;
            }
            this.onReady((profile) => {
                if (!profile) { window.location.href = 'login.html'; return; }
                if (allowedRoles && !allowedRoles.includes(profile.role)) {
                    window.location.href = 'index.html'; return;
                }
                document.body.style.visibility = 'visible';
            });
        },

        async signIn(email, password) {
            return firebase.auth().signInWithEmailAndPassword(email, password);
        },

        async signOut() {
            sessionStorage.removeItem('gp_authenticated');
            window._gansoLogout = true;
            return firebase.auth().signOut().then(() => { window.location.href = 'login.html'; });
        },

        // Crea usuario sin cerrar sesión del admin (usa app secundaria)
        async createUser(email, password) {
            const secondary = firebase.initializeApp(FIREBASE_CONFIG, `sec_${Date.now()}`);
            try {
                const cred = await firebase.auth(secondary).createUserWithEmailAndPassword(email, password);
                const uid = cred.user.uid;
                await firebase.auth(secondary).signOut();
                return uid;
            } finally {
                await secondary.delete();
            }
        },

        getUser()          { return _user; },
        getProfile()       { return _profile; },
        isAdmin()          { return _profile?.role === 'admin'; },
        isProfesor()       { return _profile?.role === 'profesor'; },
        isPreceptoria()    { return _profile?.role === 'preceptoria'; },
        canEdit()          { return ['admin', 'profesor'].includes(_profile?.role); },
        getInstitutionId() { return _profile?.institutionId || ''; },
        getInstitutionName() { return _profile?.institutionName || ''; },
        getName()          { return _profile?.name || _user?.email || ''; },
        getRole()          { return _profile?.role || ''; },
        getRoleLabel()     {
            const labels = { admin: 'Administrador', profesor: 'Profesor', preceptoria: 'Preceptoría' };
            return labels[_profile?.role] || _profile?.role || '';
        }
    };
})();
