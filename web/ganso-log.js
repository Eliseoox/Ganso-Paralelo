// ganso-log.js — Módulo de logs técnicos estructurados para debugging de sincronización
// Activar con: localStorage.setItem("ganso_debug", "1")
// Desactivar con: localStorage.removeItem("ganso_debug")
(function () {
    'use strict';

    function _isDebug() {
        try { return localStorage.getItem('ganso_debug') === '1'; } catch (_) { return false; }
    }

    // Recolecta contexto de las variables globales de script.js de forma segura.
    // Si GansoLog se carga en una página sin esas variables, no lanza error.
    function _ctx(extra) {
        const base = { ts: new Date().toISOString() };
        try {
            if (typeof institutionId !== 'undefined' && institutionId)
                base.inst = institutionId;
            if (typeof appState !== 'undefined' && appState.subject)
                base.subject = appState.subject;
        } catch (_) {}
        return extra ? Object.assign(base, extra) : base;
    }

    function _emit(level, event, data) {
        const entry = _ctx(data);
        try {
            if (level === 'error') {
                console.error('[Ganso:' + event + ']', entry);
            } else if (_isDebug()) {
                if (level === 'warn') console.warn('[Ganso:' + event + ']', entry);
                else                  console.log( '[Ganso:' + event + ']', entry);
            }
        } catch (_) {}
    }

    window.GansoLog = {
        // ── Persistencia ──────────────────────────────────────────
        SAVE_QUEUED:         function(d) { _emit('info',  'SAVE_QUEUED',         d); },
        SAVE_STARTED:        function(d) { _emit('info',  'SAVE_STARTED',        d); },
        SAVE_SUCCESS:        function(d) { _emit('info',  'SAVE_SUCCESS',        d); },
        SAVE_FAILED:         function(d) { _emit('warn',  'SAVE_FAILED',         d); },
        SAVE_RETRY:          function(d) { _emit('warn',  'SAVE_RETRY',          d); },
        SAVE_ABORTED_STALE:  function(d) { _emit('info',  'SAVE_ABORTED_STALE',  d); },
        SAVE_CANCELLED:      function(d) { _emit('info',  'SAVE_CANCELLED',      d); },
        FLUSH_START:         function(d) { _emit('info',  'FLUSH_START',         d); },
        FLUSH_COMPLETE:      function(d) { _emit('info',  'FLUSH_COMPLETE',      d); },
        FLUSH_FAILED:        function(d) { _emit('warn',  'FLUSH_FAILED',        d); },

        // ── Snapshots remotos ─────────────────────────────────────
        SNAPSHOT_RECEIVED:   function(d) { _emit('info',  'SNAPSHOT_RECEIVED',   d); },
        REMOTE_APPLIED:      function(d) { _emit('info',  'REMOTE_APPLIED',      d); },
        REMOTE_SKIPPED_ECHO: function(d) { _emit('info',  'REMOTE_SKIPPED_ECHO', d); },
        REMOTE_SKIPPED_STALE:function(d) { _emit('info',  'REMOTE_SKIPPED_STALE',d); },
        REMOTE_CONFLICT:     function(d) { _emit('warn',  'REMOTE_CONFLICT',     d); },
        SNAPSHOT_IGNORED:    function(d) { _emit('info',  'SNAPSHOT_IGNORED',    d); },

        // ── Red ───────────────────────────────────────────────────
        OFFLINE_ENTER:       function(d) { _emit('warn',  'OFFLINE_ENTER',       d); },
        ONLINE_ENTER:        function(d) { _emit('info',  'ONLINE_ENTER',        d); },

        // ── Ciclo de vida ─────────────────────────────────────────
        APP_SUSPEND:         function(d) { _emit('info',  'APP_SUSPEND',         d); },
        APP_RESUME:          function(d) { _emit('info',  'APP_RESUME',          d); },

        // ── Backup / Recovery ─────────────────────────────────────
        BACKUP_CREATED:      function(d) { _emit('info',  'BACKUP_CREATED',      d); },
        BACKUP_RESTORED:     function(d) { _emit('info',  'BACKUP_RESTORED',     d); },
        CORRUPTION_DETECTED: function(d) { _emit('error', 'CORRUPTION_DETECTED', d); },
        RECOVERY_FAILED:     function(d) { _emit('error', 'RECOVERY_FAILED',     d); },

        // ── Recovery / errores ────────────────────────────────────
        RECOVERY_TRIGGERED:  function(d) { _emit('warn',  'RECOVERY_TRIGGERED',  d); },
        CACHE_INVALIDATED:   function(d) { _emit('info',  'CACHE_INVALIDATED',   d); },

        // ── Conflictos ────────────────────────────────────────────
        CONFLICT_DETECTED:   function(d) { _emit('warn',  'CONFLICT_DETECTED',   d); },

        // ── Lock ──────────────────────────────────────────────────
        LOCK_ACQUIRED:       function(d) { _emit('info',  'LOCK_ACQUIRED',       d); },
        LOCK_RELEASED:       function(d) { _emit('info',  'LOCK_RELEASED',       d); },

        // ── Schema ────────────────────────────────────────────────
        SCHEMA_MIGRATED:     function(d) { _emit('info',  'SCHEMA_MIGRATED',     d); },
        SCHEMA_INVALID:      function(d) { _emit('error', 'SCHEMA_INVALID',      d); },
    };
})();
