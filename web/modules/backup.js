/* web/modules/backup.js — descarga, restauración y borrado de datos locales */
(function () {
    "use strict";

    function download() {
        if (!hasData() && !snapshotHasData(savedSnapshot)) { showToast("No hay datos para respaldar."); return; }
        const snapshot = hasData() ? createSnapshot() : savedSnapshot;
        const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
        ExcelModule.downloadBlob(blob, ExcelModule.buildExportFileName("json", "backup"));
        showToast("Backup descargado.");
    }

    async function importRestore(event) {
        const [file] = event.target.files;
        event.target.value = "";
        if (!file) return;
        try {
            const text = await file.text();
            const snapshot = JSON.parse(text);
            if (!snapshot || !Array.isArray(snapshot.courses)) {
                showToast("El archivo no es un backup válido.");
                return;
            }
            const stats = getSnapshotStats(snapshot);
            if (!await confirmDialog(
                `¿Restaurar este backup?\n\nMateria: ${snapshot.subject || "—"}\nCursos: ${stats.courses} | Alumnos: ${stats.students}\nGuardado: ${snapshot.lastSavedAt || "—"}\n\nLos datos actuales serán reemplazados.`,
                { confirmText: "Sí, restaurar", cancelText: "Cancelar" }
            )) return;
            SyncModule.cancel();
            createPreOpBackup("backup_restore");
            loadStateFromSnapshot(snapshot);
            selectedCourse = appState.courses[0] || "";
            activeStep    = 3;
            hasReviewed   = false;
            saveLocalState(true);
            hydrateControls(); renderAll(); renderSavedSession(); renderFlow(); updateDisabledState();
            setSyncStatus("Backup restaurado", "online");
            updateNotice("ready", "Backup restaurado.", "Los datos del backup están listos.");
            showToast("Backup restaurado correctamente.");
        } catch (_) {
            showToast("No se pudo leer el archivo de backup. Verificá que sea un JSON válido.");
        }
    }

    async function clearAll() {
        if (!hasData() && !snapshotHasData(savedSnapshot)) { showToast("No hay datos guardados para borrar."); return; }
        if (!await confirmDialog(
            "¿Borrar todos los datos guardados en este navegador? El archivo original no se modifica.",
            { confirmText: "Sí, borrar", cancelText: "Cancelar" }
        )) return;
        SyncModule.detach();
        SyncModule.cancel();
        createPreOpBackup("clear_all");
        clearAllLocalSnapshots();
        savedSnapshot  = null;
        dbPendingData  = null;
        appState       = createInitialState();
        selectedCourse = "";
        activeStep     = 1;
        hasReviewed    = false;
        lockState      = { locked: false, lockedBy: null, lockedByName: null };
        if (elements.subjectInput) elements.subjectInput.value = "";
        if (elements.dbDataBox) elements.dbDataBox.classList.add("hidden");
        hydrateControls(); renderAll(); renderSavedSession(); renderFlow(); updateDisabledState();
        updateLockUI();
        setSyncStatus("Sin datos cargados", "pending");
        updateNotice("warning", "Para comenzar, seleccioná la materia.", "El sistema te guiará paso a paso.");
        showToast("Datos locales borrados.");
    }

    window.BackupModule = { download, importRestore, clearAll };
})();
