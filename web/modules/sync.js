/* web/modules/sync.js — Firestore debounce, retry, y listener en tiempo real */
(function () {
    "use strict";

    const FS_DEBOUNCE_MS = 300;
    const FS_MAX_RETRIES = 3;

    let _fsWriteTimer    = null;
    let _fsPendingSnap   = null;
    let _fsRetryTimer    = null;
    let _fsListener      = null;
    let _lastOwnUpdatedAt = null;
    let _listenerFirst   = true;

    function _doFirestoreSave(snap, updatedAt, attempt) {
        if (attempt === 0) {
            if (typeof GansoLog !== "undefined") GansoLog.SAVE_STARTED({ subject: snap.subject, updatedAt });
        } else {
            if (typeof GansoLog !== "undefined") GansoLog.SAVE_RETRY({ subject: snap.subject, updatedAt, attempt });
        }
        DB.saveSubjectData(institutionId, snap.subject, snap, updatedAt)
            .then(() => {
                _fsRetryTimer = null;
                setSyncStatus("Guardado en la nube", "online");
                if (typeof GansoLog !== "undefined") GansoLog.SAVE_SUCCESS({ subject: snap.subject, updatedAt, attempt });
            })
            .catch(err => {
                const code = err?.code || err?.message || String(err);
                if (typeof GansoLog !== "undefined") GansoLog.SAVE_FAILED({ subject: snap.subject, updatedAt, attempt, code });
                console.warn("[Ganso] SAVE_FAILED attempt=" + (attempt + 1) + "/" + (FS_MAX_RETRIES + 1), code);
                if (_fsPendingSnap !== null) {
                    if (typeof GansoLog !== "undefined") GansoLog.SAVE_ABORTED_STALE({ reason: "newer_snap_queued" });
                    return;
                }
                if (attempt < FS_MAX_RETRIES) {
                    const delay = Math.pow(2, attempt) * 1000;
                    setSyncStatus("Reintentando guardado...", "pending");
                    _fsRetryTimer = setTimeout(() => {
                        _fsRetryTimer = null;
                        if (_fsPendingSnap !== null || _fsWriteTimer !== null) {
                            if (typeof GansoLog !== "undefined") GansoLog.SAVE_ABORTED_STALE({ reason: "new_cycle_started" });
                            return;
                        }
                        _doFirestoreSave(snap, updatedAt, attempt + 1);
                    }, delay);
                } else {
                    setSyncStatus("Guardado local (sin nube)", "pending");
                }
            });
    }

    function schedule(snapshot) {
        if (!firebaseMode || !institutionId || !snapshot.subject || typeof DB === "undefined") return;
        clearTimeout(_fsRetryTimer);
        _fsRetryTimer  = null;
        _fsPendingSnap = snapshot;
        clearTimeout(_fsWriteTimer);
        if (typeof GansoLog !== "undefined") GansoLog.SAVE_QUEUED({ subject: snapshot.subject });
        _fsWriteTimer = setTimeout(() => {
            const snap = _fsPendingSnap;
            _fsPendingSnap = null;
            _fsWriteTimer  = null;
            if (!snap || !snap.subject) return;
            const updatedAt = new Date().toISOString();
            _lastOwnUpdatedAt = updatedAt;
            _doFirestoreSave(snap, updatedAt, 0);
        }, FS_DEBOUNCE_MS);
        setSyncStatus("Sincronizando...", "pending");
    }

    function flush() {
        if (_fsWriteTimer === null && _fsPendingSnap === null) return;
        clearTimeout(_fsWriteTimer);
        _fsWriteTimer = null;
        const snap = _fsPendingSnap;
        _fsPendingSnap = null;
        if (!snap || !snap.subject || !institutionId || typeof DB === "undefined") return;
        const updatedAt = new Date().toISOString();
        _lastOwnUpdatedAt = updatedAt;
        if (typeof GansoLog !== "undefined") GansoLog.FLUSH_START({ subject: snap.subject, updatedAt });
        DB.saveSubjectData(institutionId, snap.subject, snap, updatedAt)
            .then(() => {
                if (typeof GansoLog !== "undefined") GansoLog.FLUSH_COMPLETE({ subject: snap.subject });
            })
            .catch(err => {
                setSyncStatus("Guardado local (sin nube)", "pending");
                if (typeof GansoLog !== "undefined") GansoLog.FLUSH_FAILED({ subject: snap.subject, code: err?.code });
            });
    }

    function cancel() {
        const hadPending = _fsWriteTimer !== null || _fsPendingSnap !== null || _fsRetryTimer !== null;
        clearTimeout(_fsWriteTimer);
        clearTimeout(_fsRetryTimer);
        _fsWriteTimer  = null;
        _fsPendingSnap = null;
        _fsRetryTimer  = null;
        if (hadPending && typeof GansoLog !== "undefined") {
            GansoLog.SAVE_CANCELLED({ subject: appState?.subject || null });
        }
    }

    function attach(subject) {
        detach();
        if (!firebaseMode || !institutionId || !subject || typeof DB === "undefined") return;
        _listenerFirst = true;
        _fsListener = DB.subscribeToSubject(institutionId, subject, (docSnap) => {
            if (_listenerFirst) { _listenerFirst = false; return; }
            if (docSnap.metadata.hasPendingWrites) return;
            if (docSnap.metadata.fromCache) return;
            const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
            if (norm(subject) !== norm(appState.subject)) return;
            if (!docSnap.exists) return;
            const remoteData = { id: docSnap.id, ...docSnap.data() };
            if (typeof GansoLog !== "undefined") GansoLog.SNAPSHOT_RECEIVED({ subject: remoteData.subject, remoteUpdatedAt: remoteData.updatedAt });
            if (!remoteData.courses || !remoteData.courses.length) {
                if (typeof GansoLog !== "undefined") GansoLog.SNAPSHOT_IGNORED({ reason: "empty_courses" });
                return;
            }
            if (_lastOwnUpdatedAt && remoteData.updatedAt === _lastOwnUpdatedAt) {
                if (typeof GansoLog !== "undefined") GansoLog.REMOTE_SKIPPED_ECHO({ updatedAt: remoteData.updatedAt });
                return;
            }
            const localTs  = savedSnapshot ? parseDateTime(savedSnapshot.lastSavedAt) : 0;
            const remoteTs = remoteData.updatedAt
                ? new Date(remoteData.updatedAt).getTime()
                : parseDateTime(remoteData.lastSavedAt);
            if (remoteTs <= localTs) {
                if (typeof GansoLog !== "undefined") GansoLog.REMOTE_SKIPPED_STALE({ remoteTs, localTs });
                return;
            }
            const hasFocusedInput = document.activeElement?.classList.contains("grade-cell-input");
            const isEditing = _fsWriteTimer !== null || _fsPendingSnap !== null || _fsRetryTimer !== null || hasFocusedInput;
            if (!isEditing) {
                if (typeof GansoLog !== "undefined") GansoLog.REMOTE_APPLIED({ subject: remoteData.subject, remoteTs, localTs });
                // Preservar overrides locales antes de reemplazar el estado con el remoto.
                // Si no los fusionamos, un update de otra pestaña/dispositivo que no incluya
                // studentOverrides borraría las bajas/altas manuales del usuario actual.
                const prevOverrides = cloneData(appState.studentOverrides || { additions: {}, removals: {} });
                const prevCourse = selectedCourse;
                loadStateFromSnapshot(remoteData);
                // Fusionar overrides locales con los del doc remoto, luego re-aplicar
                const mergedOverrides = Utils.mergeOverrides(prevOverrides, appState.studentOverrides || { additions: {}, removals: {} });
                applyStudentOverrides(appState, mergedOverrides);
                if (appState.courses.includes(prevCourse)) selectedCourse = prevCourse;
                hydrateControls(); renderAll(); renderSavedSession(); renderFlow(); updateDisabledState();
                try {
                    const snap = createSnapshot();
                    localStorage.setItem(storageKey(appState.subject), JSON.stringify(snap));
                    if (appState.subject) localStorage.setItem(lastSubjectKey(), appState.subject);
                    savedSnapshot = snap;
                    setSyncStatus("Sincronizado", "online");
                } catch(_) { /* localStorage write failed — non-fatal */ }
                if (elements.dbDataBox) elements.dbDataBox.classList.add("hidden");
                showToast("Notas actualizadas desde otro dispositivo.");
                return;
            }
            if (typeof GansoLog !== "undefined") GansoLog.REMOTE_CONFLICT({ subject: remoteData.subject, remoteTs, localTs, reason: "user_editing" });
            const boxAlreadyVisible = elements.dbDataBox && !elements.dbDataBox.classList.contains("hidden");
            showDbDataBox(remoteData);
            if (!boxAlreadyVisible) showToast("Otro dispositivo guardó cambios. Ir al Paso 2 para cargar.");
        });
    }

    function detach() {
        if (_fsListener) { _fsListener(); _fsListener = null; }
        _listenerFirst = true;
    }

    // Permite que script.js estampe el updatedAt propio en contextos fuera del módulo
    // (ej: guardado final en logout, o al anclar datos recibidos de Firestore).
    function setLastOwnUpdatedAt(ts) {
        _lastOwnUpdatedAt = ts;
    }

    window.SyncModule = { schedule, cancel, flush, attach, detach, setLastOwnUpdatedAt };
})();
