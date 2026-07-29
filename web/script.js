// ── Constantes ────────────────────────────────────────────────────────────────
const APP_VERSION        = 2;
const SCHEMA_VERSION     = 3;   // Versión del esquema de snapshots (distinto de la versión de app)
const INST_SESSION_KEY   = "app_institution";
const STORAGE_KEY        = "notas_docente_estado_v2";
const DEMO_STORAGE_KEY   = "ganso_demo_data_v1";
const GRADE_COLUMNS      = ["Nota 1", "Nota 2", "Nota 3", "Nota 4", "Nota 5", "Nota 6"];
const FIXED_COURSES      = ["1ero", "2do", "3ero", "4to", "5to", "6to"];
const HISTORY_SHEET      = "Historial";
const SUMMARY_SHEET      = "Resumen";
const HISTORY_HEADERS    = ["Fecha", "Accion", "Curso", "Alumno", "Columna", "Nota anterior", "Nota nueva"];
const REQUIRED_IMPORT_HEADERS = ["Alumno"];
const OPTIONAL_IMPORT_HEADERS = ["N", "Promedio", "Ultima actualizacion"];
const EXCEL_MIME         = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PASS_THRESHOLD     = 6.5;
const TEA_MIN            = 7.0;
const TEP_MIN            = 4.0;
const BACKUP_KEY         = "ganso_backup_v1";
const BACKUP_TS_KEY      = "ganso_backup_ts";
const BACKUP_INTERVAL_MS = 30 * 60 * 1000;

// ── Estado de la aplicación ───────────────────────────────────────────────────
let appState         = createInitialState();
let selectedCourse   = "";
let activeStep       = 1;
let hasReviewed      = false;
let savedSnapshot    = null;
let toastTimer       = 0;
let isSaving         = false;
let dbPendingData    = null;
// Sync state moved to SyncModule (web/modules/sync.js)

// Estado institucional (Firebase)
let institutionId    = "";
let institutionName  = "";
let currentUserName  = "";
let currentUserRole  = "";
let canUserEdit      = true;
let lockState        = { locked: false, lockedBy: null, lockedByName: null };
let firebaseMode     = false;
let _lastExportData      = null;   // { data: Uint8Array, fileName: string } — para compartir post-export
// _electronMailCfg  → EmailModule  |  _historyDisplayRows/_historyModalOpen → HistoryModule

const elements = {};

// ── Inicialización ────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    cacheElements();

    const _needsXlsx = Boolean(
        document.getElementById("exportExcelButton") ||
        document.getElementById("openWorkbookButton") ||
        document.getElementById("importStudentsExcelBtn")
    );
    if (!window.XLSX && _needsXlsx) {
        setSyncStatus("Falta libreria Excel", "error");
        updateNotice("error", "No se pudo cargar la libreria Excel.", "Revisa web/vendor/xlsx.full.min.js.");
        return;
    }

    // Detectar si Firebase está configurado
    const configured = typeof FIREBASE_CONFIG !== "undefined" &&
        !String(FIREBASE_CONFIG.apiKey).includes("REEMPLAZAR");

    if (configured && typeof Auth !== "undefined") {
        firebaseMode = true;
        if (!sessionStorage.getItem('gp_authenticated')) {
            window.location.href = 'login.html';
            return;
        }
        Auth.onReady((profile) => {
            if (!profile) { window.location.href = "login.html"; return; }
            document.body.style.visibility = 'visible';
            currentUserName = Auth.getName();
            currentUserRole = Auth.getRole();
            canUserEdit     = Auth.canEdit();
            updateUserHeaderUI(profile);

            const saved = getSessionInstitution();
            if (saved) {
                institutionId   = saved.id;
                institutionName = saved.name;
                updateInstitutionDisplay();
                startApp();
            } else {
                showInstitutionPickerModal(({ id, name }) => {
                    institutionId   = id;
                    institutionName = name;
                    setSessionInstitution(id, name);
                    updateInstitutionDisplay();
                    startApp();
                });
            }
        });
    } else {
        // Modo local (sin Firebase) — compatible con el flujo original
        document.body.style.visibility = 'visible';
        startApp();
    }
});

function startApp() {
    bindEvents();
    setupTableTopScroll();
    restorePanelState();
    seedDemoDataIfNeeded();
    savedSnapshot = readLocalSnapshot();
    initializePage();
    if (navigator.userAgent.includes("Electron")) EmailModule.fetchConfig();
    // Allow intentional navigation (header links) to bypass the beforeunload guard.
    // Data is always auto-saved to localStorage so nothing is lost.
    document.querySelectorAll("a.nav-button[href]").forEach(link => {
        link.addEventListener("click", () => {
            window._gansoNavAway = true;
            if (hasData()) {
                try { saveLocalState(false); } catch(_) {}
                SyncModule.flush(); // enviar el write pendiente antes de navegar
            }
        });
    });
    window.addEventListener("beforeunload", e => {
        if (hasData()) {
            try { saveLocalState(false); } catch(_) {}
            SyncModule.flush();
        }
        // Si el último guardado a la nube falló (se agotaron los reintentos),
        // advertir SIEMPRE al cerrar/navegar — incluso si es _gansoNavAway —
        // porque el riesgo es que el usuario cambie de dispositivo antes de
        // que la nota llegue a Firestore. Un logout intencional no advierte.
        if (window._gansoUnsavedToCloud && !window._gansoLogout) {
            e.preventDefault();
            e.returnValue = "";
            return;
        }
        if (window._gansoLogout || window._gansoNavAway || !hasData()) return;
        e.preventDefault();
        e.returnValue = "";
    });

    // ── Conectividad ─────────────────────────────────────────────────────────
    window.addEventListener("offline", () => {
        if (typeof GansoLog !== "undefined") GansoLog.OFFLINE_ENTER({});
        setSyncStatus("Sin conexión", "pending");
    });
    window.addEventListener("online", () => {
        if (typeof GansoLog !== "undefined") GansoLog.ONLINE_ENTER({ hasPendingData: hasData() && firebaseMode });
        // When reconnecting, flush any localStorage-only state to Firestore.
        if (firebaseMode && institutionId && appState.subject && hasData()) {
            setSyncStatus("Reconectado — guardando...", "pending");
            SyncModule.schedule(createSnapshot());
        } else {
            setSyncStatus("Conectado", "online");
        }
    });

    // ── Ciclo de vida (suspensión / APK) ─────────────────────────────────────
    // visibilitychange es más confiable que beforeunload en mobile/Android/Electron:
    // dispara cuando el usuario cambia de pestaña, bloquea la pantalla, o cierra la app.
    // Combinado con enablePersistence (firebase-config.js), el write queda en IndexedDB
    // aunque la página muera antes de que Firebase confirme la escritura en la nube.
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            if (typeof GansoLog !== "undefined") GansoLog.APP_SUSPEND({ subject: appState?.subject || null });
            if (hasData()) {
                try { saveLocalState(false); } catch(_) {}
                SyncModule.flush();
            }
        } else {
            if (typeof GansoLog !== "undefined") GansoLog.APP_RESUME({ subject: appState?.subject || null });
        }
    });
}

function updateUserHeaderUI(profile) {
    const pill   = document.getElementById("userPill");
    const nameEl = document.getElementById("headerUserName");
    const roleEl = document.getElementById("headerRoleTag");
    const instEl = document.getElementById("headerInstitution");
    if (pill)   { pill.style.display = ""; }
    if (nameEl) { nameEl.textContent = Auth.getName(); }
    if (roleEl) { roleEl.textContent = Auth.getRoleLabel(); roleEl.className = `role-tag ${currentUserRole}`; }
    if (instEl) { instEl.textContent = institutionName || "Seleccioná una institución"; }
    if (elements.adminPanelLink && ['admin','superadmin'].includes(currentUserRole)) {
        elements.adminPanelLink.style.display = "";
    }
    // Estadísticas y boletines visibles para admin, superadmin, preceptoría y profesor
    const statsLink    = document.getElementById("statsLink");
    const boletinesLink = document.getElementById("boletinesLink");
    if (statsLink    && ['admin','superadmin','preceptoria','profesor'].includes(currentUserRole)) statsLink.style.display    = "";
    if (boletinesLink && ['admin','superadmin','preceptoria','profesor'].includes(currentUserRole)) boletinesLink.style.display = "";
}

function updateInstitutionDisplay() {
    const instEl = document.getElementById("headerInstitution");
    if (!instEl) return;
    instEl.textContent = institutionName || "Seleccioná una institución";
}

// ── Estado inicial ─────────────────────────────────────────────────────────────
function createInitialState(subject = "") {
    const students = {};
    const records  = {};
    FIXED_COURSES.forEach(c => { students[c] = []; records[c] = {}; });
    return {
        version: APP_VERSION, subject, fileName: "", source: "",
        courses: [...FIXED_COURSES], students, records, historyRows: [],
        gradeColumns: Object.fromEntries(FIXED_COURSES.map(c => [c, [...GRADE_COLUMNS]])),
        gradeColumnsMeta: {},
        studentOverrides: { additions: {}, removals: {} },
        pendingHistoryRows: [],
        validation: { errors: [], warnings: [] }, lastSavedAt: ""
    };
}

function getColMeta(col, course) {
    const c = course || selectedCourse;
    return appState.gradeColumnsMeta?.[c]?.[col] || {};
}

function getColLabel(col, course) {
    return getColMeta(col, course).label || col;
}

function getCourseColumns(course) {
    const c = course || selectedCourse;
    const cols = appState.gradeColumns;
    if (Array.isArray(cols)) return cols;
    return (cols && Array.isArray(cols[c]) && cols[c].length) ? cols[c] : [...GRADE_COLUMNS];
}

function checkColMetaReady(col, course) {
    const c = course || selectedCourse;
    const meta = getColMeta(col, c);
    if (meta.label && meta.description) return true;
    const displayName = meta.label || col;
    showToast(`Completá nombre y descripción de "${displayName}" para ${c} antes de cargar notas.`);
    openGradeColInfoModal(col, c);
    return false;
}

// ── Cache de elementos DOM ────────────────────────────────────────────────────
function cacheElements() {
    [
        "stepper","syncStatus","fileNotice","statusSubject","statusFile","statusNotes",
        "subjectForm","subjectInput","confirmSubjectButton",
        "savedDataBox","savedDraftText","continueSavedButton","startNewButton",
        "dbDataBox","dbDataTitle","dbDataText","loadFromDbButton","dismissDbDataBtn",
        "sourceSummary","validationList","openWorkbookButton","workbookInput",
        "restoreInput","restoreButton","backupButton","backupButtonSecondary","clearAllButton","logoutButton",
        "courseSelect","studentSelect","gradeColumnSelect","gradeInput",
        "currentNote","insertButton","changeButton","deleteGradeButton",
        "goReviewButton","backToEditButton","exportExcelButton","exportSummary",
        "courseTabs","tableTitle","tableHead","tableBody","studentSearch",
        "loadedCount","courseAverage","lastUpdatedAt",
        "reviewSubject","reviewCourses","reviewStudents","reviewLoaded",
        "reviewMissing","reviewAverage","reviewTableBody",
        "toast","gradeForm","courseForm","studentsForm","removeStudentForm",
        "newCourseName","newCourseStudentsCount","studentCourseSelect","extraStudents",
        "adminPanelLink",
        "addCourseButton","addStudentsButton",
        "removeStudentCourseSelect","removeStudentSelect","removeStudentButton",
        "lockBadge",
        "exportSuccessOverlay","exportSuccessFile","exportSuccessBtn","exportCountdown",
        "exportShareBtn","exportCountdownPara",
        "shareEmailModal","shareEmailForm","shareEmailInput","shareEmailSendBtn","cancelShareEmailBtn",
        "cancelAddGradeColBtn","closeGradeColInfoBtn",
        "addColCtaBtn",
        "generateSampleBtn",
        "tableTopScroll","tableTopScrollInner",
        "studentActionNotice",
        "openHistoryBtn","closeHistoryBtn","historySearch","historyModalBody",
        "studentStatusSelect","studentNotesInput","saveStudentExtrasBtn","studentExtrasPanel",
        "restoreAutoBackupButton",
        "importStudentsExcelBtn","studentImportInput",
        "headerToolsToggle","headerToolsPanel"
    ].forEach(id => { elements[id] = document.getElementById(id); });
}

// ── Eventos ───────────────────────────────────────────────────────────────────
function bindEvents() {
    on(document.getElementById("changeInstButton"), "click", () => { closeHeaderTools(); changeInstitution(); });
    on(elements.subjectForm, "submit", confirmSubject);
    on(elements.continueSavedButton, "click", continueFromSaved);
    on(elements.startNewButton, "click", startNewSession);
    on(elements.openWorkbookButton, "click", openWorkbook);
    on(elements.workbookInput, "change", ExcelModule.importFromInput);
    on(elements.loadFromDbButton, "click", loadFromDbButton_click);
    on(elements.dismissDbDataBtn, "click", () => {
        if (elements.dbDataBox) elements.dbDataBox.classList.add("hidden");
        dbPendingData = null;
    });
    on(elements.backupButton, "click", () => { closeHeaderTools(); BackupModule.download(); });
    on(elements.backupButtonSecondary, "click", () => BackupModule.download());
    on(elements.clearAllButton, "click", () => { closeHeaderTools(); BackupModule.clearAll(); });
    on(elements.logoutButton, "click", handleLogout);
    on(elements.goReviewButton, "click", () => setActiveStep(4));
    on(elements.backToEditButton, "click", () => setActiveStep(3));
    on(elements.exportExcelButton, "click", exportFinalExcel);
    on(elements.restoreInput,  "change", BackupModule.importRestore);
    on(elements.restoreButton, "click",  () => { closeHeaderTools(); elements.restoreInput?.click(); });

    document.querySelectorAll("[data-go-step]").forEach(btn => {
        btn.addEventListener("click", () => setActiveStep(Number(btn.dataset.goStep)));
    });

    on(elements.courseSelect, "change", () => {
        selectedCourse = elements.courseSelect.value;
        refreshStudents();
        saveLocalState(false);
        renderAll();
    });

    on(elements.studentSelect, "change", () => { renderTable(); updateCurrentNote(); });
    on(elements.gradeColumnSelect, "change", updateCurrentNote);
    on(elements.gradeForm, "submit", e => { e.preventDefault(); insertGrade(); });
    on(elements.changeButton, "click", changeGrade);
    on(elements.deleteGradeButton, "click", deleteSelectedGrade);

    on(elements.studentSearch, "input", filterTable);
    on(elements.cancelAddGradeColBtn, "click", closeAllModals);
    on(elements.closeGradeColInfoBtn, "click", closeAllModals);
    on(elements.addColCtaBtn, "click", openAddGradeColModal);
    on(elements.generateSampleBtn, "click", generateSampleData);

    on(elements.openHistoryBtn,      "click", HistoryModule.openModal);
    on(elements.closeHistoryBtn,     "click", HistoryModule.closeModal);
    on(elements.historySearch,       "input", HistoryModule.filterModal);
    on(elements.saveStudentExtrasBtn,"click", saveStudentExtras);

    on(elements.restoreAutoBackupButton, "click", () => { closeHeaderTools(); restoreAutoBackup(); });
    on(elements.importStudentsExcelBtn,  "click", () => elements.studentImportInput?.click());
    on(elements.studentImportInput,      "change", importStudentsFromExcel);

    // BUG 3: seleccionar el texto del input al hacer focus para evitar concatenación
    on(elements.subjectInput, "focus", () => { elements.subjectInput?.select(); });

    on(elements.headerToolsToggle, "click", toggleHeaderTools);
    document.addEventListener("click", e => {
        const wrap = document.getElementById("headerToolsWrap");
        if (wrap && !wrap.contains(e.target)) closeHeaderTools();
    });

    // Cerrar modales al clic en el fondo o con Escape
    ["addGradeColModal", "gradeColInfoModal", "historyModal"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("click", e => { if (e.target === el) closeAllModals(); });
    });
    document.addEventListener("keydown", e => {
        if (e.key === "Escape") closeAllModals();
    });

    // Focus trap para modales estáticos
    ["addGradeColModal", "gradeColInfoModal", "historyModal", "shareEmailModal"].forEach(id => {
        const el = document.getElementById(id);
        if (el) trapFocus(el);
    });

    on(elements.tableBody, "click", handleTableClick);
    on(elements.tableBody, "focusin", handleTableFocus);
    on(elements.tableBody, "keydown", handleTableKeydown);
    on(elements.tableBody, "change", handleInlineGradeChange);

    on(elements.courseForm, "submit", addCourse);
    on(elements.studentsForm, "submit", addStudents);
    on(elements.removeStudentForm, "submit", removeStudent);
    on(elements.removeStudentCourseSelect, "change", refreshRemoveStudents);

    on(document.getElementById("panelToggleBtn"), "click", function(e) {
        e.stopPropagation();
        toggleGradePanel();
    });
    on(document.querySelector(".grade-panel"), "click", function(e) {
        if (this.classList.contains("collapsed")) toggleGradePanel();
    });
}

// ── Panel lateral colapsable ──────────────────────────────────────────────────
const PANEL_COLLAPSED_KEY = "ganso_panel_collapsed";

function toggleGradePanel() {
    const gradePanel = document.querySelector(".grade-panel");
    if (!gradePanel) return;
    const isNowCollapsed = !gradePanel.classList.contains("collapsed");
    setGradePanelCollapsed(isNowCollapsed);
    try { localStorage.setItem(PANEL_COLLAPSED_KEY, String(isNowCollapsed)); } catch(_) {}
}

function setGradePanelCollapsed(collapsed) {
    const gradePanel = document.querySelector(".grade-panel");
    const mainGrid   = document.querySelector(".main-grid");
    const btn        = document.getElementById("panelToggleBtn");
    if (!gradePanel || !mainGrid) return;

    if (collapsed) {
        gradePanel.classList.add("collapsed");
        mainGrid.classList.add("panel-collapsed");
        if (btn) { btn.classList.add("is-collapsed"); btn.title = "Mostrar panel lateral"; btn.setAttribute("aria-label", "Mostrar panel lateral"); }
    } else {
        gradePanel.classList.remove("collapsed");
        mainGrid.classList.remove("panel-collapsed");
        if (btn) { btn.classList.remove("is-collapsed"); btn.title = "Ocultar panel lateral"; btn.setAttribute("aria-label", "Ocultar panel lateral"); }
    }
}

function restorePanelState() {
    try {
        if (localStorage.getItem(PANEL_COLLAPSED_KEY) === "true") {
            setGradePanelCollapsed(true);
        }
    } catch(_) {}
}

async function handleLogout() {
    SyncModule.detach();
    commitFocusedGradeInput();
    window._gansoLogout = true;
    // Cancelar write con debounce pendiente y hacer un save explícito y síncrono
    // antes de cerrar la sesión, para garantizar que todos los datos llegaron a Firestore.
    SyncModule.cancel();
    if (firebaseMode && institutionId && appState.subject && hasData() && typeof DB !== "undefined") {
        if (elements.logoutButton) {
            elements.logoutButton.disabled = true;
            elements.logoutButton.textContent = 'Guardando...';
        }
        try {
            const snap = createSnapshot();
            const updatedAt = new Date().toISOString();
            SyncModule.setLastOwnUpdatedAt(updatedAt);
            await DB.saveSubjectData(institutionId, appState.subject, snap, updatedAt);
        } catch (_) {}
    }
    // Limpiar localStorage ANTES de cerrar sesión para evitar que el próximo usuario
    // que abra el browser encuentre datos de esta sesión (ghost state en PCs compartidas).
    // Es seguro: la escritura a Firestore ya fue esperada (await) arriba; cualquier
    // write pendiente sin conexión vive en el IndexedDB de Firebase y sincroniza solo.
    clearAllLocalSnapshots();
    try { sessionStorage.removeItem(INST_SESSION_KEY); } catch(_) {}
    if (firebaseMode && typeof Auth !== "undefined") {
        Auth.signOut();
    } else {
        window.location.href = "login.html";
    }
}

// ── Inicialización de página ──────────────────────────────────────────────────
function initializePage() {
    if (isFlowPage()) {
        if (savedSnapshot && snapshotHasData(savedSnapshot)) {
            // Restore data into appState so hasData() is true and grade controls are enabled.
            // Immediately clear the subject input so the datalist is unfiltered and no subject looks "open".
            loadStateFromSnapshot(savedSnapshot);
            if (elements.subjectInput) elements.subjectInput.value = "";
            activeStep = 1;
            setSyncStatus("Datos guardados", "online");
            updateNotice("ready",
                savedSnapshot.subject
                    ? `Tenés datos guardados de "${savedSnapshot.subject}".`
                    : "Hay datos guardados en este navegador.",
                "Seleccioná la materia o usá el paso 3 del menú para continuar editando.");
        } else {
            setSyncStatus("Sin datos cargados", "pending");
            updateNotice("warning", "Para comenzar, seleccioná la materia.", "El sistema te guiará paso a paso hasta generar el archivo final.");
        }
    } else if (savedSnapshot && snapshotHasData(savedSnapshot)) {
        loadStateFromSnapshot(savedSnapshot);
        activeStep = 3;
        setSyncStatus("Datos locales cargados", "online");
        updateNotice("ready", "Datos locales cargados.", "Ya podés administrar cursos y alumnos.");
    } else {
        setSyncStatus("Sin datos cargados", "pending");
        updateNotice("warning", "Sin datos previos.", isFlowPage()
            ? "Para comenzar, seleccioná la materia."
            : "Podés agregar alumnos directamente. Los cursos ya están disponibles.");
    }

    hydrateControls();
    renderAll();
    renderSavedSession();
    renderFlow();
    updateDisabledState();
}

function isFlowPage() { return Boolean(elements.stepper); }

// ── Paso 1: Confirmar materia ─────────────────────────────────────────────────
async function confirmSubject(event) {
    event.preventDefault();
    commitFocusedGradeInput();
    const subject = elements.subjectInput?.value.trim() || "";
    if (!subject) { showToast("Escribí la materia."); return; }

    const prevSubject = appState.subject;
    const normalizeSubject = s => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    // Subject change is detected purely by name — hasData() is intentionally excluded.
    // Including hasData() caused a race: switching to an empty subject B and back to A
    // would set switchingSubject=false (since B had no data), then stale Firestore
    // callbacks for B would fire loadStateFromSnapshot() against A's now-empty appState.
    const switchingSubject = prevSubject && normalizeSubject(prevSubject) !== normalizeSubject(subject);

    let dataReadyFromLocal = false;
    if (switchingSubject) {
        // Flush old subject: cancel debounce and do an explicit Firestore save (only if data exists).
        SyncModule.cancel();
        if (firebaseMode && institutionId && hasData() && typeof DB !== "undefined") {
            try { await DB.saveSubjectData(institutionId, prevSubject, createSnapshot()); } catch (_) {}
        }
        // Per-subject storage — old subject's data stays under its own key; don't wipe it.
        dbPendingData = null;
        // Pre-load the new subject's local data if it exists.
        const newSubjectSnap = readLocalSnapshot(subject);
        if (newSubjectSnap && snapshotHasData(newSubjectSnap)) {
            loadStateFromSnapshot(newSubjectSnap);
            savedSnapshot     = newSubjectSnap;
            selectedCourse    = appState.courses[0] || "";
            dataReadyFromLocal = true;
        } else {
            appState       = createInitialState(subject);
            selectedCourse = "";
            savedSnapshot  = null;
        }
        if (elements.dbDataBox) elements.dbDataBox.classList.add("hidden");
    } else {
        appState.subject = subject;
        if (hasData()) saveStateAndRender("Materia actualizada.");
    }

    if (dataReadyFromLocal) {
        hasReviewed = false;
        setActiveStep(3);
        updateNotice("ready", `${subject} — datos cargados.`, "Podés continuar con la carga de notas.");
        hydrateControls();
        renderSavedSession();
    } else {
        setActiveStep(2);
        updateNotice("ready", `Materia: ${subject}`, "Cargá los datos del sistema o importá un Excel.");
    }

    // Buscar y auto-cargar datos en Firestore (solo si no hay datos locales ya cargados)
    if (firebaseMode && institutionId) {
        // Enganchar listener en tiempo real para este documento.
        // Se llama ANTES del get() inicial; el primer disparo del listener
        // es ignorado (_listenerFirst) para no duplicar la carga ya hecha abajo.
        SyncModule.attach(subject);
        setSyncStatus("Buscando en el sistema...", "pending");

        DB.getSubjectMeta(institutionId, subject)
            .then(meta => {
                if (normalizeSubject(appState.subject) !== normalizeSubject(subject)) return;
                lockState = meta; updateLockUI();
            })
            .catch(() => {});

        if (hasData()) {
            setSyncStatus("Datos locales cargados", "online");
            // Consultar Firestore en background para detectar cambios desde otro dispositivo.
            // Si la nube tiene datos genuinamente más nuevos, auto-aplicar con merge
            // (en lugar de mostrar el botón manual "Cargar desde el sistema").
            // _applyRemoteData preserva las ediciones locales más recientes mediante _mergeRecords.
            loadSubjectFromFirestore(subject).then(dbData => {
                if (normalizeSubject(appState.subject) !== normalizeSubject(subject)) return;
                if (!dbData || !dbData.courses || !dbData.courses.length) return;
                const localTs = savedSnapshot ? parseDateTime(savedSnapshot.lastSavedAt) : 0;
                const cloudTs = dbData.updatedAt
                    ? new Date(dbData.updatedAt).getTime()
                    : parseDateTime(dbData.lastSavedAt);
                if (!localTs || cloudTs > localTs) {
                    setSyncStatus("Actualizando...", "pending");
                    SyncModule.applyRemoteData(dbData);
                    activeStep  = 3;
                    hasReviewed = false;
                    renderFlow();
                    updateDisabledState();
                    if (dbData.updatedAt) SyncModule.setLastOwnUpdatedAt(dbData.updatedAt);
                    setSyncStatus("Datos actualizados", "online");
                    updateNotice("ready", `${subject} — datos actualizados.`, "Podés continuar con la carga de notas.");
                    showToast(`Datos de "${subject}" actualizados automáticamente.`);
                } else {
                    setSyncStatus("Datos locales actualizados", "online");
                }
            }).catch(() => {});
        } else {
            loadSubjectFromFirestore(subject).then(dbData => {
                // Stale guard: discard if the user switched subjects while this was loading.
                if (normalizeSubject(appState.subject) !== normalizeSubject(subject)) return;
                if (!dbData || !dbData.courses || !dbData.courses.length) {
                    setSyncStatus("Sin datos previos", "pending");
                    updateNotice("ready", `Materia: ${subject}`, "No hay datos en el sistema. Pedí al administrador que inicialice esta materia o importá un Excel.");
                    return;
                }
                // Re-verificar: el usuario pudo haber cargado datos mientras esperábamos
                if (hasData()) {
                    showDbDataBox(dbData);
                    return;
                }
                loadStateFromSnapshot(dbData);
                applyStudentOverrides(appState, appState.studentOverrides);
                selectedCourse = appState.courses[0] || "";
                activeStep     = 3;
                hasReviewed    = false;
                hydrateControls();
                renderAll();
                renderSavedSession();
                renderFlow();
                updateDisabledState();
                // Persist to localStorage, anchor savedSnapshot, and stamp _lastOwnUpdatedAt
                // with the document's updatedAt. This has two effects:
                // 1. savedSnapshot baseline prevents localTs = 0 in future comparisons.
                // 2. _lastOwnUpdatedAt matching the loaded doc's updatedAt triggers the
                //    echo-check in the listener, so the immediate re-fire of this same
                //    document is silently discarded instead of showing a spurious
                //    "Notas actualizadas desde otro dispositivo" toast.
                try {
                    const snap = createSnapshot();
                    localStorage.setItem(storageKey(appState.subject), JSON.stringify(snap));
                    if (appState.subject) localStorage.setItem(lastSubjectKey(), appState.subject);
                    savedSnapshot = snap;
                    if (dbData.updatedAt) SyncModule.setLastOwnUpdatedAt(dbData.updatedAt);
                } catch(_) {}
                setSyncStatus("Datos del sistema cargados", "online");
                updateNotice("ready", `${subject} — datos cargados.`, "Podés comenzar a cargar notas.");
                showToast(`Datos de "${subject}" cargados automáticamente.`);
                if (elements.dbDataBox) elements.dbDataBox.classList.add("hidden");
            }).catch(() => { setSyncStatus("Sin conexión", "pending"); });
        }
    }
}

async function loadSubjectFromFirestore(subject) {
    if (!institutionId || !subject) return null;
    try { return await DB.loadSubjectData(institutionId, subject); }
    catch (_) { return null; }
}

function showDbDataBox(dbData) {
    const box = elements.dbDataBox;
    if (!box) return;
    const localTs = savedSnapshot ? parseDateTime(savedSnapshot.lastSavedAt) : 0;
    // Prefer updatedAt (ISO server timestamp, ms precision) over lastSavedAt (device string).
    // This correctly represents when Firestore was last written, regardless of which device did it.
    const cloudTs = dbData?.updatedAt
        ? new Date(dbData.updatedAt).getTime()
        : parseDateTime(dbData?.lastSavedAt);
    // Only silently trust local if it is clearly newer (> 30 s).
    // A small or zero difference means another device may have saved after us.
    // IMPORTANT: do NOT re-upload local to Firestore here — that would overwrite remote changes.
    // Regular saves happen in saveLocalState() whenever the user edits anything.
    const TRUST_LOCAL_DIFF_MS = 30000;
    if (localTs && cloudTs && localTs > cloudTs + TRUST_LOCAL_DIFF_MS) {
        setSyncStatus("Datos locales actualizados", "online");
        return;
    }
    dbPendingData = dbData;
    box.classList.remove("hidden");
    const stats = getSnapshotStats(dbData);
    if (elements.dbDataTitle) {
        elements.dbDataTitle.textContent = `${dbData.subject || appState.subject} — en el sistema`;
    }
    if (elements.dbDataText) {
        elements.dbDataText.textContent =
            `${stats.courses} cursos · ${stats.students} alumnos · guardado ${dbData.lastSavedAt || "-"}.`;
    }
}

function loadFromDbButton_click() {
    if (!dbPendingData) { showToast("Sin datos del sistema para cargar."); return; }
    // Cancelar write pendiente: los datos de Firebase son la fuente de verdad aquí,
    // no queremos que un save local viejo los sobreescriba después de la carga.
    SyncModule.cancel();
    createPreOpBackup('load_from_db');
    // Preservar overrides e historial local antes de reemplazar con datos de Firebase
    const prevOverrides   = cloneData(appState.studentOverrides   || { additions: {}, removals: {} });
    const prevPendingHist = cloneData(appState.pendingHistoryRows || []);
    loadStateFromSnapshot(dbPendingData);
    // Fusionar overrides locales con los de Firestore; ninguno debe pisar al otro
    const mergedOverrides = Utils.mergeOverrides(prevOverrides, appState.studentOverrides || { additions: {}, removals: {} });
    applyStudentOverrides(appState, mergedOverrides);
    // Fusionar historial local con el de Firebase, sin duplicar filas
    appState.historyRows        = mergeHistoryRows(prevPendingHist, appState.historyRows);
    appState.pendingHistoryRows = cloneData(prevPendingHist);
    selectedCourse = appState.courses[0] || "";
    activeStep     = 3;
    hasReviewed    = false;
    hydrateControls();
    renderAll();
    renderSavedSession();
    renderFlow();
    updateDisabledState();
    // Update savedSnapshot so future comparisons use this loaded data as the baseline
    try {
        const snap = createSnapshot();
        localStorage.setItem(storageKey(appState.subject), JSON.stringify(snap));
        if (appState.subject) localStorage.setItem(lastSubjectKey(), appState.subject);
        savedSnapshot = snap;
    } catch(_) {}
    dbPendingData = null;
    setSyncStatus("Datos del sistema cargados", "online");
    updateNotice("ready", "Datos cargados del sistema.", "Podés continuar con la carga de notas.");
    showToast("Datos cargados del sistema.");
    if (elements.dbDataBox) elements.dbDataBox.classList.add("hidden");
}

// ── Indicador de bloqueo ──────────────────────────────────────────────────────
function updateLockUI() {
    const badge = elements.lockBadge;
    if (!badge) return;
    if (lockState && lockState.locked) {
        badge.classList.remove("hidden");
        const who = lockState.lockedByName ? ` (${lockState.lockedByName})` : "";
        badge.title = `Bloqueada${who}`;
    } else {
        badge.classList.add("hidden");
    }
}

function checkEditAllowed() {
    if (!canUserEdit) {
        showToast("Tu rol no permite editar notas.");
        return false;
    }
    if (lockState && lockState.locked) {
        const isAdmin = firebaseMode && typeof Auth !== "undefined" && Auth.isAdmin();
        if (!isAdmin) {
            showToast("La materia está bloqueada. Solo el administrador puede modificar.");
            return false;
        }
    }
    return true;
}

// ── Paso 2: Datos ─────────────────────────────────────────────────────────────
function continueFromSaved() {
    if (!savedSnapshot || !snapshotHasData(savedSnapshot)) {
        showToast("No hay datos guardados para continuar.");
        return;
    }
    SyncModule.cancel();
    loadStateFromSnapshot(savedSnapshot);
    activeStep  = 3;
    hasReviewed = false;
    hydrateControls(); renderAll(); renderSavedSession(); renderFlow(); updateDisabledState();
    updateNotice("ready", "Datos recuperados del navegador.", "Podés continuar con la carga de notas.");
    showToast("Datos recuperados.");

    // Reconciliar contra Firestore en background: si hay alumnos dados de baja o alta
    // desde el panel de admin que aún no llegaron al snapshot local, se aplican solos.
    if (firebaseMode && institutionId && appState.subject) {
        setSyncStatus("Verificando cambios del sistema...", "pending");
        const subject = appState.subject;
        SyncModule.reconcileWithFirestore(subject).then(applied => {
            if (applied) {
                showToast("Cambios del sistema aplicados automáticamente.");
            } else {
                setSyncStatus("Datos locales cargados", "online");
            }
        });
    } else {
        setSyncStatus("Datos cargados", "online");
    }
}

async function startNewSession() {
    SyncModule.detach();
    SyncModule.cancel();
    const currentSubject = elements.subjectInput?.value.trim() || appState.subject || "";
    if ((savedSnapshot && snapshotHasData(savedSnapshot)) || hasData()) {
        if (!await confirmDialog("Empezar nuevo borra los datos guardados en este navegador. El archivo original no se modifica.", { confirmText: "Sí, empezar nuevo", cancelText: "Cancelar" })) return;
    }
    createPreOpBackup('start_new');
    clearLocalSnapshot(currentSubject);
    savedSnapshot = null;
    dbPendingData = null;
    appState      = createInitialState(currentSubject);
    selectedCourse = "";
    activeStep    = currentSubject ? 2 : 1;
    hasReviewed   = false;
    lockState     = { locked: false, lockedBy: null, lockedByName: null };
    if (elements.dbDataBox) elements.dbDataBox.classList.add("hidden");
    hydrateControls(); renderAll(); renderSavedSession(); renderFlow(); updateDisabledState();
    updateLockUI();
    setSyncStatus("Sin datos cargados", "pending");
    updateNotice(
        currentSubject ? "ready" : "warning",
        currentSubject ? `Materia: ${currentSubject}` : "Para comenzar, seleccioná la materia.",
        currentSubject ? "Cargá un Excel o usá los datos del sistema." : "El sistema te guiará paso a paso."
    );
}

function openWorkbook() {
    if (isFlowPage() && !appState.subject) { showToast("Primero seleccioná una materia."); setActiveStep(1); return; }
    elements.workbookInput?.click();
}

// ── Hidratación de controles ──────────────────────────────────────────────────
function hydrateControls() {
    normalizeState(appState);
    if (!selectedCourse || !appState.courses.includes(selectedCourse)) {
        selectedCourse = appState.courses[0] || "";
    }
    fillSelect(elements.courseSelect, appState.courses, "Sin cursos");
    fillSelect(elements.studentCourseSelect, appState.courses, "Sin cursos");
    fillSelect(elements.removeStudentCourseSelect, appState.courses, "Sin cursos");
    fillGradeColumnSelect(elements.gradeColumnSelect);

    [elements.courseSelect, elements.studentCourseSelect, elements.removeStudentCourseSelect].forEach(sel => {
        if (sel && selectedCourse && appState.courses.includes(selectedCourse)) sel.value = selectedCourse;
    });
    const initCols = getCourseColumns(selectedCourse);
    if (elements.gradeColumnSelect && !elements.gradeColumnSelect.value && initCols.length) {
        elements.gradeColumnSelect.value = initCols[0];
    }
    refreshStudents();
    refreshRemoveStudents();
}

function refreshStudents() {
    if (!elements.studentSelect) return;
    const students = appState.students[selectedCourse] || [];
    const prev     = elements.studentSelect.value;
    fillSelect(elements.studentSelect, students, "Sin alumnos");
    elements.studentSelect.value = students.includes(prev) ? prev : students[0] || "";
    updateCurrentNote();
}

function refreshRemoveStudents() {
    if (!elements.removeStudentSelect) return;
    const course   = elements.removeStudentCourseSelect?.value || selectedCourse;
    const students = appState.students[course] || [];
    const prev     = elements.removeStudentSelect.value;
    fillSelect(elements.removeStudentSelect, students, "Sin alumnos");
    elements.removeStudentSelect.value = students.includes(prev) ? prev : students[0] || "";
}

// ── Renderizado ───────────────────────────────────────────────────────────────
function renderAll() {
    renderTabs();
    renderTable();
    renderStats();
    renderReview();
    renderSourceSummary();
    renderValidationMessages(appState.validation);
    renderExportSummary();
    renderSystemStatus();
    updateCurrentNote();
}

function renderTabs() {
    if (!elements.courseTabs) return;
    const courses = appState.courses;
    // Build a map of existing tab buttons keyed by their course.
    // We reuse existing buttons instead of destroying them with innerHTML = "" so
    // that a click whose mousedown fired before a save-triggered DOM rebuild still
    // resolves to the same element and the click event fires correctly.
    const existingMap = new Map();
    elements.courseTabs.querySelectorAll(".course-tab[data-tabcourse]").forEach(btn => {
        existingMap.set(btn.dataset.tabcourse, btn);
    });
    // Remove buttons whose course no longer exists
    existingMap.forEach((btn, course) => {
        if (!courses.includes(course)) btn.remove();
    });
    // Add new buttons and update all button states
    courses.forEach(course => {
        let btn = existingMap.get(course);
        if (!btn) {
            btn = document.createElement("button");
            btn.type = "button";
            btn.dataset.tabcourse = course;
            btn.addEventListener("click", () => {
                selectedCourse = course;
                if (elements.courseSelect) elements.courseSelect.value = selectedCourse;
                if (elements.studentSearch) elements.studentSearch.value = "";
                refreshStudents();
                saveLocalState(false);
                renderAll();
            });
            elements.courseTabs.appendChild(btn);
        }
        btn.className = `course-tab${course === selectedCourse ? " active" : ""}`;
        btn.textContent = course;
        btn.disabled = isSaving;
    });
}

function renderTable() {
    if (!elements.tableHead || !elements.tableBody || !elements.tableTitle) return;
    elements.tableTitle.textContent = selectedCourse || "Sin curso seleccionado";

    const cols = getCourseColumns(selectedCourse);
    const canEdit = canUserEdit && !(lockState && lockState.locked && !(firebaseMode && typeof Auth !== "undefined" && Auth.isAdmin()));
    const gradeHeaders = cols.map(col => {
        const label = getColLabel(col, selectedCourse);
        const meta  = getColMeta(col, selectedCourse);
        const unconfigured = !(meta.label && meta.description);
        const dot = unconfigured ? `<span class="col-uncfg-dot" title="Sin configurar">●</span>` : "";
        const pencil = canEdit
            ? `<button class="grade-col-edit-btn" type="button" data-col="${escapeAttribute(col)}" title="Editar nombre y descripción">✏</button>`
            : "";
        return `<th class="grade-col-th" data-col="${escapeAttribute(col)}">
            <div class="grade-col-th-inner">${escapeHtml(label)}${dot}${pencil}</div>
        </th>`;
    }).join("");
    elements.tableHead.innerHTML = `<tr>
        <th>N</th>
        <th>Alumno</th>
        ${gradeHeaders}
        <th>Promedio</th>
        <th>Última act.</th>
        <th></th>
    </tr>`;

    elements.tableHead.querySelectorAll(".grade-col-edit-btn").forEach(btn => {
        btn.addEventListener("click", e => { e.stopPropagation(); openGradeColInfoModal(btn.dataset.col, selectedCourse); });
    });

    const colspan = cols.length + 5;
    const students = appState.students[selectedCourse] || [];
    if (!students.length) {
        elements.tableBody.innerHTML = `<tr><td colspan="${colspan}" class="empty-state">
            ${escapeHtml(hasData() ? "Este curso todavía no tiene alumnos." : "Cargá los datos para empezar.")}</td></tr>`;
        updateTableTopScrollWidth();
        return;
    }

    const disabled = activeStep !== 3 || isSaving || !canEdit ? " disabled" : "";
    const selectedStudent = elements.studentSelect?.value;

    updateTableTopScrollWidth();
    elements.tableBody.innerHTML = students.map((student, index) => {
        const record      = getRecord(selectedCourse, student);
        const average     = calculateAverage(Object.values(record.grades));
        const isSelected  = student === selectedStudent;
        const rowTone     = rowToneClass(average);
        const rowClasses  = [isSelected ? "selected" : "", rowTone].filter(Boolean).join(" ");
        const rowClassAttr = rowClasses ? ` class="${rowClasses}"` : "";

        const averageHtml = average === null
            ? '<span class="empty">—</span>'
            : `<span class="${gradeToneClass(average)}">${escapeHtml(formatNumber(average))}</span>`;

        const statusBadge = record.status
            ? `<span class="student-status-badge status-${escapeAttribute(record.status)}">${escapeHtml(record.status)}</span>`
            : "";
        const trayBadge = record.trayectoria
            ? `<span class="tray-badge tray-${escapeAttribute(record.trayectoria)}">${escapeHtml(record.trayectoria)}</span>`
            : "";
        const notesDot = record.notes
            ? `<span class="notes-dot" title="${escapeAttribute(record.notes)}">📝</span>`
            : "";

        return `<tr data-student="${escapeAttribute(student)}"${rowClassAttr}>
            <td>${record.number || index + 1}</td>
            <td>${escapeHtml(student)}${statusBadge}${trayBadge}${notesDot}</td>
            ${cols.map(col => editableGradeCell(selectedCourse, student, col, record.grades[col], disabled)).join("")}
            <td>${averageHtml}</td>
            <td>${record.updatedAt ? escapeHtml(record.updatedAt) : '<span class="empty">—</span>'}</td>
            <td></td>
        </tr>`;
    }).join("");
    filterTable();
}

function filterTable() {
    const search = (elements.studentSearch?.value || "").toLowerCase().trim();
    if (!elements.tableBody) return;
    elements.tableBody.querySelectorAll("tr[data-student]").forEach(row => {
        const match = !search || (row.dataset.student || "").toLowerCase().includes(search);
        row.style.display = match ? "" : "none";
    });
}

function editableGradeCell(course, student, column, value, disabled) {
    return `<td class="grade-cell">
        <input class="grade-cell-input ${gradeToneClass(value)}" type="text" inputmode="decimal"
            value="${escapeAttribute(hasGrade(value) ? formatNumber(value) : "")}"
            placeholder="—"
            data-course="${escapeAttribute(course)}"
            data-student="${escapeAttribute(student)}"
            data-column="${escapeAttribute(column)}"
            aria-label="${escapeAttribute(`${student} ${column}`)}"${disabled}>
    </td>`;
}

function handleTableClick(event) {
    const row = event.target.closest("tr[data-student]");
    if (!row) return;
    selectStudent(row.dataset.student);
    const input = event.target.closest(".grade-cell-input");
    if (input && elements.gradeColumnSelect) elements.gradeColumnSelect.value = input.dataset.column;
    updateCurrentNote();
}

function handleTableFocus(event) {
    const input = event.target.closest(".grade-cell-input");
    if (!input) return;
    input.dataset.originalValue = input.value;
    selectStudent(input.dataset.student);
    if (elements.gradeColumnSelect) elements.gradeColumnSelect.value = input.dataset.column;
    updateCurrentNote();
    input.select();
}

function handleTableKeydown(event) {
    const input = event.target.closest(".grade-cell-input");
    if (!input) return;
    if (event.key === "Enter") { event.preventDefault(); input.blur(); }
    if (event.key === "Escape") { event.preventDefault(); input.value = input.dataset.originalValue || ""; input.blur(); }
}

function handleInlineGradeChange(event) {
    const input = event.target.closest(".grade-cell-input");
    if (input) updateGradeFromInlineInput(input);
}

function commitFocusedGradeInput() {
    const focused = document.activeElement;
    if (!focused || !focused.classList.contains("grade-cell-input")) return;
    const course  = focused.dataset.course || selectedCourse;
    const student = focused.dataset.student;
    const column  = focused.dataset.column;
    if (!course || !student || !column) return;
    const rec = appState.records[course]?.[student];
    if (!rec) return;
    const rawValue = focused.value.trim();
    const oldGrade = rec.grades[column];
    let nextGrade  = "";
    if (rawValue) {
        nextGrade = parseGrade(rawValue);
        if (nextGrade === null) {
            focused.value = hasGrade(oldGrade) ? formatNumber(oldGrade) : "";
            return;
        }
    }
    if (sameGrade(oldGrade, nextGrade)) return;
    const now    = formatDateTime(new Date());
    const action = nextGrade === "" ? "Borrada" : hasGrade(oldGrade) ? "Editada" : "Insertada";
    rec.grades[column]  = nextGrade;
    rec.average         = calculateAverage(Object.values(rec.grades));
    rec.trayectoria     = Utils.computeTrajectory(rec.average);
    rec.updatedAt       = now;
    HistoryModule.log(action, course, student, column, oldGrade, nextGrade);
    focused.value = hasGrade(nextGrade) ? formatNumber(nextGrade) : "";
}

function updateGradeFromInlineInput(input) {
    if (!ensureDataReady() || !checkEditAllowed()) return;
    const course  = input.dataset.course || selectedCourse;
    const student = input.dataset.student;
    const column  = input.dataset.column;
    const record  = ensureRecord(course, student);
    const oldGrade = record.grades[column];
    const rawValue = input.value.trim();
    let nextGrade  = "";

    if (rawValue) {
        nextGrade = parseGrade(rawValue);
        if (nextGrade === null) {
            input.value = hasGrade(oldGrade) ? formatNumber(oldGrade) : "";
            showToast("La nota debe ser un número entre 0 y 10.");
            return;
        }
    }
    if (sameGrade(oldGrade, nextGrade)) {
        input.value = hasGrade(nextGrade) ? formatNumber(nextGrade) : "";
        return;
    }

    const now    = formatDateTime(new Date());
    const action = nextGrade === "" ? "Borrada" : hasGrade(oldGrade) ? "Editada" : "Insertada";
    record.grades[column]  = nextGrade;
    record.average         = calculateAverage(Object.values(record.grades));
    record.trayectoria     = Utils.computeTrajectory(record.average);
    record.updatedAt       = now;
    HistoryModule.log(action, course, student, column, oldGrade, nextGrade);
    selectedCourse = course;
    selectStudent(student);
    saveStateAndRender(`${student}: ${column} actualizada.`);
}

function selectStudent(student) {
    if (elements.studentSelect && student) elements.studentSelect.value = student;
    if (elements.tableBody) {
        elements.tableBody.querySelectorAll("tr").forEach(row => {
            row.classList.toggle("selected", row.dataset.student === student);
        });
    }
}

function renderStats() {
    if (!elements.loadedCount || !elements.courseAverage) return;
    const stats = getCourseStats(selectedCourse);
    elements.loadedCount.textContent = `${stats.loadedGrades} notas`;
    elements.courseAverage.textContent = `Promedio: ${stats.average === null ? "—" : formatNumber(stats.average)}`;
    elements.courseAverage.classList.remove("grade-pass", "grade-warn", "grade-fail");
    const tc = gradeToneClass(stats.average);
    if (tc) elements.courseAverage.classList.add(tc);
    if (elements.lastUpdatedAt) elements.lastUpdatedAt.textContent = `Última: ${stats.lastUpdated || "—"}`;
}

function renderReview() {
    const stats = getOverallStats();
    setText(elements.reviewSubject,  appState.subject || "—");
    setText(elements.reviewCourses,  stats.courses);
    setText(elements.reviewStudents, stats.students);
    setText(elements.reviewLoaded,   stats.loadedGrades);
    setText(elements.reviewMissing,  stats.missingGrades);
    setText(elements.reviewAverage,  stats.average === null ? "—" : formatNumber(stats.average));

    if (!elements.reviewTableBody) return;
    if (!hasData()) {
        elements.reviewTableBody.innerHTML = `<tr><td colspan="8" class="empty-state">Sin datos para revisar.</td></tr>`;
        return;
    }
    elements.reviewTableBody.innerHTML = appState.courses.map(course => {
        const cs = getCourseStats(course);
        const avgHtml = cs.average === null
            ? "—"
            : `<span class="${gradeToneClass(cs.average)}">${escapeHtml(formatNumber(cs.average))}</span>`;
        return `<tr>
            <td>${escapeHtml(course)}</td>
            <td>${cs.students}</td>
            <td><span class="grade-pass">${cs.passed}</span></td>
            <td><span class="grade-fail">${cs.failed}</span></td>
            <td>${cs.loadedGrades}</td>
            <td>${cs.missingGrades > 0 ? `<span class="grade-fail">${cs.missingGrades}</span>` : "0"}</td>
            <td>${avgHtml}</td>
            <td>${cs.lastUpdated ? escapeHtml(cs.lastUpdated) : "—"}</td>
        </tr>`;
    }).join("");
}

function renderSourceSummary() {
    if (!elements.sourceSummary) return;
    if (!hasData()) { elements.sourceSummary.textContent = "Sin archivo cargado."; return; }
    const stats = getOverallStats();
    elements.sourceSummary.textContent =
        `${appState.fileName || "Datos"} — ${stats.courses} cursos — ${stats.students} alumnos — guardado ${appState.lastSavedAt || "—"}.`;
}

function renderExportSummary() {
    if (!elements.exportSummary) return;
    const stats = getOverallStats();
    if (!hasData()) { elements.exportSummary.textContent = "Cargá los datos antes de exportar."; return; }
    if (stats.missingGrades > 0) {
        elements.exportSummary.textContent =
            `En progreso: faltan ${stats.missingGrades} nota(s). Podés exportar igual.`;
        return;
    }
    elements.exportSummary.textContent =
        `${appState.subject || "Materia"} — ${stats.courses} cursos — ${stats.loadedGrades} notas — listo para exportar.`;
}

function renderSystemStatus() {
    const stats       = getOverallStats();
    const subjectReady = Boolean(appState.subject);
    const fileReady    = hasData();
    const notesReady   = stats.missingGrades === 0 && fileReady;

    setText(elements.statusSubject, subjectReady ? `Materia: ✔ ${appState.subject}` : "Materia: pendiente");
    setText(elements.statusFile,    fileReady ? "Datos: ✔ cargados" : "Datos: pendiente");
    setText(elements.statusNotes,   notesReady ? "Notas: ✔ completas"
        : `Notas: ⏳ en progreso${fileReady ? ` (${stats.missingGrades} faltantes)` : ""}`);

    [[elements.statusSubject, subjectReady], [elements.statusFile, fileReady], [elements.statusNotes, notesReady]]
        .forEach(([el, ready]) => {
            if (!el) return;
            el.classList.toggle("complete", ready);
            el.classList.toggle("pending", !ready);
        });
}

function renderValidationMessages(validation = { errors: [], warnings: [] }) {
    if (!elements.validationList) return;
    const errors   = validation.errors || [];
    const warnings = validation.warnings || [];
    if (!errors.length && !warnings.length) {
        elements.validationList.innerHTML = hasData() ? '<div class="message ok">Estructura validada.</div>' : "";
        return;
    }
    elements.validationList.innerHTML =
        errors.map(m => `<div class="message error">${escapeHtml(m)}</div>`).join("") +
        warnings.map(m => `<div class="message warning">${escapeHtml(m)}</div>`).join("");
}

function renderSavedSession() {
    if (!elements.savedDataBox) return;
    if (!savedSnapshot || !snapshotHasData(savedSnapshot)) {
        elements.savedDataBox.classList.add("hidden");
        return;
    }
    const stats = getSnapshotStats(savedSnapshot);
    elements.savedDataBox.classList.remove("hidden");
    if (elements.savedDraftText) {
        elements.savedDraftText.textContent =
            `${savedSnapshot.subject || "Sin materia"} — ${stats.courses} cursos — ${stats.students} alumnos — guardado ${savedSnapshot.lastSavedAt || "—"}.`;
    }
}

function renderFlow() {
    if (!isFlowPage()) return;
    document.querySelectorAll("[data-step-panel]").forEach(panel => {
        panel.classList.toggle("active", Number(panel.dataset.stepPanel) === activeStep);
    });
    document.querySelectorAll("[data-go-step]").forEach(btn => {
        const step    = Number(btn.dataset.goStep);
        const allowed = canAccessStep(step);
        const marker  = btn.querySelector("span");
        btn.disabled  = !allowed || isSaving;
        btn.classList.toggle("active",    step === activeStep);
        btn.classList.toggle("complete",  isStepComplete(step));
        btn.classList.toggle("locked",    !allowed);
        btn.setAttribute("aria-current", step === activeStep ? "step" : "false");
        if (marker) marker.textContent = isStepComplete(step) ? "✔" : String(step);
    });
}

function setActiveStep(step) {
    if (!canAccessStep(step)) {
        if (step === 2 && !appState.subject) showToast("Primero seleccioná una materia.");
        else if (step === 3 && typeof SyncModule !== "undefined" && SyncModule.hasPendingStructural()) showToast("Actualizando...");
        else if (step >= 3 && !hasData())    showToast("Primero cargá los datos.");
        return;
    }
    if (step === 2 && !appState.subject && elements.subjectInput?.value.trim()) {
        appState.subject = elements.subjectInput.value.trim();
    }
    // Persist current state before switching steps so grades are in localStorage
    // even if the change event on an inline input somehow didn't fire.
    if (hasData()) { try { saveLocalState(false); } catch(_) {} }
    activeStep = step;
    if (step === 4) hasReviewed = true;
    renderAll(); renderFlow(); updateDisabledState();
}

function canAccessStep(step) {
    if (!isFlowPage()) return true;
    if (step === 1) return true;
    if (step === 2) return Boolean(appState.subject || elements.subjectInput?.value.trim());
    if (step === 3) {
        // Bloquear Paso 3 si hay un cambio del sistema pendiente de aplicar.
        // El polling en SyncModule lo aplica en cuanto el profesor deje de editar.
        if (typeof SyncModule !== "undefined" && SyncModule.hasPendingStructural()) return false;
        return hasData();
    }
    if (step === 4) return hasData();
    return false;
}

function isStepComplete(step) {
    const stats = getOverallStats();
    if (step === 1) return Boolean(appState.subject);
    if (step === 2) return hasData();
    if (step === 3) return hasData() && stats.missingGrades === 0;
    return false;
}

// ── Operaciones de notas ──────────────────────────────────────────────────────
function insertGrade() {
    const record = getSelectedRecord();
    const column = elements.gradeColumnSelect?.value;
    if (!ensureDataReady() || !checkEditAllowed() || !ensureGradeTarget(record, column)) return;
    if (hasGrade(record.grades[column])) { showToast("Ese alumno ya tiene nota. Usá Cambiar."); return; }
    saveSelectedGrade("Insertada");
}

function changeGrade() {
    const record = getSelectedRecord();
    const column = elements.gradeColumnSelect?.value;
    if (!ensureDataReady() || !checkEditAllowed() || !ensureGradeTarget(record, column)) return;
    saveSelectedGrade("Cambiada");
}

function deleteSelectedGrade() {
    const record = getSelectedRecord();
    const column = elements.gradeColumnSelect?.value;
    if (!ensureDataReady() || !checkEditAllowed() || !ensureGradeTarget(record, column)) return;
    const oldGrade = record.grades[column];
    if (!hasGrade(oldGrade)) { showToast("No hay nota para borrar en esa columna."); return; }
    const now     = formatDateTime(new Date());
    const course  = selectedCourse;
    const student = elements.studentSelect.value;
    record.grades[column] = "";
    record.average        = calculateAverage(Object.values(record.grades));
    record.updatedAt      = now;
    HistoryModule.log("Borrada", course, student, column, oldGrade, "");
    saveStateAndRender(`${student}: ${column} borrada.`);
}

function saveSelectedGrade(action) {
    if (isSaving) return;
    const grade = parseGrade(elements.gradeInput.value);
    if (grade === null) { showToast("La nota debe ser un número entre 0 y 10."); return; }
    const course  = selectedCourse;
    const student = elements.studentSelect.value;
    const column  = elements.gradeColumnSelect.value;
    const record  = ensureRecord(course, student);
    const oldGrade = record.grades[column];
    if (sameGrade(oldGrade, grade)) { elements.gradeInput.value = ""; showToast("La nota ya tenía ese valor."); return; }
    const now = formatDateTime(new Date());
    record.grades[column] = grade;
    record.average        = calculateAverage(Object.values(record.grades));
    record.updatedAt      = now;
    HistoryModule.log(action, course, student, column, hasGrade(oldGrade) ? oldGrade : "", grade);
    elements.gradeInput.value = "";
    saveStateAndRender(`${student}: ${column} guardada.`);
}

// ── Guardar estado ────────────────────────────────────────────────────────────
function saveStateAndRender(message) {
    // Capture which grade input has focus so we can restore it after the table rebuild.
    // This is necessary because Tab moves focus to input B BEFORE change fires on input A,
    // and renderAll() destroys input B when it rebuilds the table via innerHTML.
    const _focused = document.activeElement;
    const _restoreStudent = (_focused && _focused.classList.contains("grade-cell-input")) ? _focused.dataset.student : null;
    const _restoreColumn  = (_focused && _focused.classList.contains("grade-cell-input")) ? _focused.dataset.column  : null;

    isSaving = true;
    updateDisabledState();
    try {
        saveLocalState(true);
        updateNotice("ready", "Datos guardados.", "Podés cerrar o recargar la página sin perder cambios.");
        if (message) showToast(message);
    } catch (error) {
        console.error(error);
        setSyncStatus("Error al guardar", "error");
        showToast(getErrorMessage(error, "No se pudieron guardar los datos."));
    } finally {
        isSaving = false;
        hydrateControls(); renderAll(); renderSavedSession(); renderFlow(); updateDisabledState();
        // Restore focus to the equivalent input in the rebuilt table so Tab-key
        // navigation continues without the user losing their editing position.
        if (_restoreStudent && _restoreColumn && elements.tableBody) {
            const inputs = elements.tableBody.querySelectorAll(".grade-cell-input");
            for (const inp of inputs) {
                if (inp.dataset.student === _restoreStudent && inp.dataset.column === _restoreColumn) {
                    inp.focus();
                    break;
                }
            }
        }
    }
}

function saveLocalState(updateTimestamp = true) {
    commitFocusedGradeInput();
    if (!updateTimestamp && !appState.subject && !hasData()) return;
    if (updateTimestamp) appState.lastSavedAt = formatDateTime(new Date());
    else if (!appState.lastSavedAt) appState.lastSavedAt = formatDateTime(new Date());

    normalizeState(appState);
    const snapshot = createSnapshot();
    const snapshotJson = JSON.stringify(snapshot);
    let localStorageFailed = false;
    try {
        const key = storageKey(appState.subject);
        localStorage.setItem(key, snapshotJson);
        const written = localStorage.getItem(key);
        if (written === null || written !== snapshotJson) {
            throw new Error("localStorage write verification failed");
        }
        if (appState.subject) {
            try { localStorage.setItem(lastSubjectKey(), appState.subject); } catch(_) {}
        }
        setSyncStatus("Guardado local", "online");
        // Auto-backup silencioso cada 30 minutos
        try {
            const lastTs = parseInt(localStorage.getItem(BACKUP_TS_KEY) || "0", 10);
            if (hasData() && Date.now() - lastTs >= BACKUP_INTERVAL_MS) {
                localStorage.setItem(BACKUP_KEY, snapshotJson);
                localStorage.setItem(BACKUP_TS_KEY, String(Date.now()));
                if (typeof GansoLog !== "undefined") GansoLog.BACKUP_CREATED({ subject: appState.subject, courses: appState.courses.length });
            }
        } catch(_) {}
    } catch (_) {
        localStorageFailed = true;
        setSyncStatus("Error local — enviando a la nube", "error");
        if (typeof GansoLog !== "undefined") GansoLog.RECOVERY_TRIGGERED({ reason: "localStorage_quota_exceeded", subject: appState.subject });
    }
    // Always update savedSnapshot so conflict detection uses the correct timestamp,
    // even if localStorage failed (the in-memory snapshot is still authoritative).
    savedSnapshot = snapshot;

    // Guardar en Firestore con debounce — se intenta incluso si localStorage falló,
    // para evitar pérdida total de datos cuando el almacenamiento local está lleno.
    if (firebaseMode && institutionId && appState.subject && hasData()) {
        SyncModule.schedule(snapshot);
    }

    if (localStorageFailed) {
        throw new Error("El navegador no pudo guardar localmente. Los datos se están enviando a la nube.");
    }
}

// ── Snapshot / localStorage ───────────────────────────────────────────────────
function createSnapshot() {
    return {
        version: APP_VERSION, schemaVersion: SCHEMA_VERSION,
        subject: appState.subject, fileName: appState.fileName,
        source: appState.source, courses: [...appState.courses],
        students: cloneData(appState.students), records: cloneData(appState.records),
        historyRows: cloneData(appState.historyRows), validation: cloneData(appState.validation),
        gradeColumns: cloneData(appState.gradeColumns),
        gradeColumnsMeta: cloneData(appState.gradeColumnsMeta),
        studentOverrides: cloneData(appState.studentOverrides || { additions: {}, removals: {} }),
        pendingHistoryRows: cloneData(appState.pendingHistoryRows || []),
        selectedCourse, lastSavedAt: appState.lastSavedAt || formatDateTime(new Date())
    };
}

// ── Per-subject, per-institution localStorage helpers ─────────────────────────
function storageKey(subject) {
    if (!subject) return STORAGE_KEY;
    const norm = String(subject).toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim()
        .replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
    const inst = institutionId
        ? String(institutionId).replace(/[^a-zA-Z0-9]/g, "_")
        : "local";
    return `notas_docente_v2_${inst}_${norm || "sin_materia"}`;
}

function lastSubjectKey() {
    const inst = institutionId
        ? String(institutionId).replace(/[^a-zA-Z0-9]/g, "_")
        : "local";
    return `ganso_last_subject_v2_${inst}`;
}

function readLocalSnapshot(subject) {
    try {
        if (subject) {
            const raw = localStorage.getItem(storageKey(subject));
            if (!raw) return null;
            const snap = JSON.parse(raw);
            return snap && typeof snap === "object" ? snap : null;
        }
        // Startup: try last active subject first, then legacy single-key fallback
        const lastSubject = localStorage.getItem(lastSubjectKey());
        if (lastSubject) {
            const raw = localStorage.getItem(storageKey(lastSubject));
            if (raw) {
                const snap = JSON.parse(raw);
                if (snap && typeof snap === "object") return snap;
            }
        }
        // Migration: old single-key format (first run after upgrade)
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const snap = JSON.parse(raw);
        return snap && typeof snap === "object" ? snap : null;
    } catch (_) { return null; }
}

function clearLocalSnapshot(subject) {
    try { localStorage.removeItem(subject ? storageKey(subject) : STORAGE_KEY); } catch (_) {}
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
}

// Borra todas las claves de localStorage que pertenecen a la institución actual.
// Usado por clearAllData y changeInstitution para limpiar completamente la sesión local.
function clearAllLocalSnapshots() {
    try {
        const inst   = institutionId ? String(institutionId).replace(/[^a-zA-Z0-9]/g, "_") : "local";
        const prefix = `notas_docente_v2_${inst}_`;
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(prefix)) toRemove.push(k);
        }
        toRemove.forEach(k => { try { localStorage.removeItem(k); } catch(_) {} });
    } catch(_) {}
    try { localStorage.removeItem(STORAGE_KEY); } catch(_) {}
    try { localStorage.removeItem(lastSubjectKey()); } catch(_) {}
}

// ── Schema versioning ─────────────────────────────────────────────────────────
// Valida y migra un snapshot a la versión de schema actual.
// Retorna null si el snapshot es irrecuperable (corrupción grave).
// Los datos corruptos no se cargan para evitar contaminar appState.
function migrateSnapshot(snap) {
    if (!snap || typeof snap !== "object") {
        if (typeof GansoLog !== "undefined") GansoLog.SCHEMA_INVALID({ reason: "not_object", type: typeof snap });
        return null;
    }
    // Validaciones estructurales mínimas
    if (snap.records  !== undefined && typeof snap.records !== "object") {
        if (typeof GansoLog !== "undefined") GansoLog.SCHEMA_INVALID({ reason: "records_invalid", subject: snap.subject });
        return null;
    }
    if (snap.students !== undefined && typeof snap.students !== "object") {
        if (typeof GansoLog !== "undefined") GansoLog.SCHEMA_INVALID({ reason: "students_invalid", subject: snap.subject });
        return null;
    }
    if (snap.courses  !== undefined && snap.courses !== null && !Array.isArray(snap.courses)) {
        if (typeof GansoLog !== "undefined") GansoLog.SCHEMA_INVALID({ reason: "courses_invalid", subject: snap.subject });
        return null;
    }
    if (Array.isArray(snap.courses) && snap.courses.some(c => typeof c !== "string")) {
        snap.courses = snap.courses.map(c => (c === null || c === undefined ? "" : String(c))).filter(Boolean);
    }

    const fromVersion = snap.schemaVersion || snap.version || 1;

    if (fromVersion < SCHEMA_VERSION) {
        if (typeof GansoLog !== "undefined") {
            GansoLog.SCHEMA_MIGRATED({ from: fromVersion, to: SCHEMA_VERSION, subject: snap.subject || null });
        }
    }
    // Stamp with current schema version so the next save propagates it to Firestore/localStorage.
    snap.schemaVersion = SCHEMA_VERSION;
    return snap;
}

function loadStateFromSnapshot(snapshot) {
    const snap = migrateSnapshot(snapshot);
    if (!snap) return; // Invalid snapshot — do not corrupt appState

    appState          = createInitialState(snap.subject || "");
    appState.fileName = snap.fileName || "";
    appState.source   = snap.source || "local";
    appState.courses  = Array.isArray(snap.courses) ? [...snap.courses] : [];
    appState.students = cloneData(snap.students || {});
    appState.records  = cloneData(snap.records || {});
    appState.historyRows = Array.isArray(snap.historyRows) ? cloneData(snap.historyRows) : [];
    appState.validation  = snap.validation || { errors: [], warnings: [] };
    appState.lastSavedAt = snap.lastSavedAt || "";
    appState.gradeColumns = snap.gradeColumns || {};
    appState.gradeColumnsMeta = migrateGradeColumnsMeta(
        snap.gradeColumnsMeta, appState.courses
    );
    appState.studentOverrides    = cloneData(snap.studentOverrides    || { additions: {}, removals: {} });
    appState.pendingHistoryRows  = Array.isArray(snap.pendingHistoryRows) ? cloneData(snap.pendingHistoryRows) : [];
    normalizeState(appState);
    selectedCourse = appState.courses.includes(snap.selectedCourse)
        ? snap.selectedCourse : appState.courses[0] || "";
    if (elements.subjectInput) elements.subjectInput.value = appState.subject;
}

function snapshotHasData(snap) {
    return Boolean(snap && Array.isArray(snap.courses) &&
        snap.courses.some(c => (snap.students?.[c] || []).length > 0));
}

function normalizeState(state) {
    state.subject    = String(state.subject || "").trim();
    state.fileName   = String(state.fileName || "");
    state.source     = String(state.source || "");
    state.courses    = uniqueStrings(state.courses || []);
    state.students   = state.students && typeof state.students === "object" ? state.students : {};
    state.records    = state.records  && typeof state.records  === "object" ? state.records  : {};
    state.historyRows = Array.isArray(state.historyRows) ? state.historyRows : [];
    if (Array.isArray(state.gradeColumns)) {
        const globalCols = state.gradeColumns.length ? [...state.gradeColumns] : [...GRADE_COLUMNS];
        const migrated = {};
        FIXED_COURSES.forEach(c => { migrated[c] = [...globalCols]; });
        state.gradeColumns = migrated;
    } else if (!state.gradeColumns || typeof state.gradeColumns !== "object") {
        const migrated = {};
        FIXED_COURSES.forEach(c => { migrated[c] = [...GRADE_COLUMNS]; });
        state.gradeColumns = migrated;
    } else {
        FIXED_COURSES.forEach(c => {
            if (!Array.isArray(state.gradeColumns[c]) || !state.gradeColumns[c].length) {
                state.gradeColumns[c] = [...GRADE_COLUMNS];
            }
        });
    }
    state.gradeColumnsMeta = (state.gradeColumnsMeta && typeof state.gradeColumnsMeta === "object")
        ? state.gradeColumnsMeta : {};
    state.validation  = state.validation && typeof state.validation === "object"
        ? { errors: state.validation.errors || [], warnings: state.validation.warnings || [] }
        : { errors: [], warnings: [] };
    if (!state.studentOverrides || typeof state.studentOverrides !== "object")
        state.studentOverrides = { additions: {}, removals: {} };
    if (!state.studentOverrides.additions || typeof state.studentOverrides.additions !== "object")
        state.studentOverrides.additions = {};
    if (!state.studentOverrides.removals || typeof state.studentOverrides.removals !== "object")
        state.studentOverrides.removals = {};
    if (!Array.isArray(state.pendingHistoryRows)) state.pendingHistoryRows = [];

    // Ensure all fixed courses exist
    FIXED_COURSES.forEach(course => {
        if (!state.courses.includes(course)) state.courses.push(course);
    });
    // Keep fixed courses in canonical order, extra courses after
    state.courses = [
        ...FIXED_COURSES.filter(c => state.courses.includes(c)),
        ...state.courses.filter(c => !FIXED_COURSES.includes(c))
    ];

    state.courses.forEach((course) => {
        const gradeCols = (Array.isArray(state.gradeColumns[course]) && state.gradeColumns[course].length)
            ? state.gradeColumns[course] : [...GRADE_COLUMNS];
        if (!state.students[course]) state.students[course] = [];
        const students = uniqueStrings(state.students[course]);
        state.students[course] = students;
        state.records[course]  = state.records[course] && typeof state.records[course] === "object"
            ? state.records[course] : {};
        students.forEach((student, index) => {
            const cur    = state.records[course][student] || {};
            const grades = {};
            gradeCols.forEach(col => { grades[col] = normalizeGrade(cur.grades?.[col]); });
            const avg = calculateAverage(Object.values(grades));
            state.records[course][student] = {
                number:      cur.number || index + 1,
                grades,
                average:     avg,
                updatedAt:   cur.updatedAt || "",
                notes:       String(cur.notes  || ""),
                status:      String(cur.status || ""),
                trayectoria: Utils.computeTrajectory(avg),
            };
        });
    });
}

// Aplica adiciones y eliminaciones manuales sobre cualquier estado importado.
// Garantiza que los cambios de alumno persistan aunque se recargue un Excel o datos de Firebase.
function applyStudentOverrides(state, overrides) {
    state.studentOverrides = cloneData(overrides || { additions: {}, removals: {} });
    if (!overrides) return;
    const additions = overrides.additions || {};
    const removals  = overrides.removals  || {};
    (state.courses || []).forEach(course => {
        const toAdd    = additions[course] || [];
        const toRemove = new Set((removals[course] || []).map(s => s.toLowerCase()));
        if (!state.students[course]) state.students[course] = [];
        if (!state.records[course])  state.records[course]  = {};

        // 1. Eliminar alumnos que el usuario quitó manualmente
        if (toRemove.size > 0) {
            state.students[course] = state.students[course].filter(s => !toRemove.has(s.toLowerCase()));
            Object.keys(state.records[course]).forEach(s => {
                if (toRemove.has(s.toLowerCase())) delete state.records[course][s];
            });
        }
        // 2. Agregar alumnos que el usuario incorporó manualmente y no están en la fuente
        if (toAdd.length > 0) {
            const existingKeys = new Set(state.students[course].map(s => s.toLowerCase()));
            const cols = (Array.isArray(state.gradeColumns[course]) && state.gradeColumns[course].length)
                ? state.gradeColumns[course] : [...GRADE_COLUMNS];
            toAdd.forEach(student => {
                if (!existingKeys.has(student.toLowerCase())) {
                    state.students[course].push(student);
                    state.records[course][student] = {
                        number: state.students[course].length,
                        grades: Object.fromEntries(cols.map(c => [c, ""])),
                        average: "", updatedAt: ""
                    };
                    existingKeys.add(student.toLowerCase());
                }
            });
        }
    });
}

// Combina entradas locales (pending) con las del Excel/Firebase, sin duplicar filas.
// Las filas del Excel van primero (orden cronológico base); las locales que no estén se agregan al final.
function mergeHistoryRows(pending, importedRows) {
    const seen = new Set();
    const result = [];
    const addRow = row => {
        const key = (row || []).map(v => String(v ?? "")).join("||");
        if (!seen.has(key)) { seen.add(key); result.push(row); }
    };
    (importedRows || []).forEach(addRow);
    (pending || []).forEach(addRow);
    return result;
}

// ── Gestión de cursos y alumnos ───────────────────────────────────────────────
function generateRandomStudents(count) {
    const male   = ['Lautaro','Santiago','Mateo','Thiago','Valentín','Facundo','Agustín','Ezequiel','Ignacio','Nicolás','Federico','Rodrigo','Marcos','Lucas','Martín','Pablo','Sebastián','Andrés','Diego','Alejandro','Gabriel','Ramiro','Emiliano','Leandro','Maximiliano'];
    const female = ['Valentina','Sofía','Camila','Lucía','Martina','Florencia','Agustina','Guadalupe','Valeria','Antonella','Catalina','Julieta','Micaela','Rocío','Luisina','Milagros','Aldana','Brenda','Natalia','Celeste'];
    const last   = ['García','González','Rodríguez','López','Martínez','Hernández','Pérez','Sánchez','Ramírez','Flores','Torres','Morales','Romero','Álvarez','Díaz','Ruiz','Méndez','Muñoz','Alonso','Ramos','Vega','Medina','Castro','Ortega','Molina','Suárez','Domínguez','Vargas','Fuentes','Ríos'];
    const used = new Set();
    const list = [];
    let att = 0;
    while (list.length < count && att < 3000) {
        att++;
        const isF  = Math.random() < 0.5;
        const first = isF ? female[Math.floor(Math.random() * female.length)] : male[Math.floor(Math.random() * male.length)];
        const l1 = last[Math.floor(Math.random() * last.length)];
        const l2 = last[Math.floor(Math.random() * last.length)];
        const name = `${l1} ${l2}, ${first}`;
        if (!used.has(name)) { used.add(name); list.push(name); }
    }
    return list.sort();
}

function addCourse(event) {
    event.preventDefault();
    if (!ensureDataReady()) return;
    const name  = elements.newCourseName?.value.trim() || "";
    const count = parseInt(elements.newCourseStudentsCount?.value || "30", 10);
    if (!name) { showToast("Escribí el nombre del curso."); return; }
    if (!isValidSheetName(name))   { showToast("El nombre del curso no puede usar / \\ ? * [ ] : ni superar 31 caracteres."); return; }
    if (ExcelModule.isReservedSheetName(name)) { showToast("Ese nombre está reservado para el Excel."); return; }
    if (findCourseByName(name))    { showToast("Ese curso ya existe."); return; }

    const students = generateRandomStudents(count);
    appState.courses.push(name);
    appState.students[name] = students;
    appState.records[name]  = {};
    if (!appState.gradeColumns[name]) appState.gradeColumns[name] = [...GRADE_COLUMNS];
    students.forEach((student, index) => {
        appState.records[name][student] = createEmptyRecord(index + 1, appState.gradeColumns[name]);
    });
    selectedCourse = name;
    if (elements.newCourseName) elements.newCourseName.value = "";
    saveStateAndRender(`Curso ${name} creado con ${students.length} alumnos.`);
}

function addStudents(event) {
    event.preventDefault();
    const course   = elements.studentCourseSelect.value;
    const students = parseStudentsText(elements.extraStudents.value);
    if (!course)          { showToast("Elegí un curso."); return; }
    if (!students.length) { showToast("Escribí al menos un alumno."); return; }

    const existing    = appState.students[course] || [];
    const existingKeys = new Set(existing.map(s => s.toLocaleLowerCase()));
    const newStudents  = students.filter(s => !existingKeys.has(s.toLocaleLowerCase()));
    if (!newStudents.length) { showToast("No hay alumnos nuevos para agregar."); return; }

    if (!appState.records[course]) appState.records[course] = {};
    newStudents.forEach(student => {
        existing.push(student);
        appState.records[course][student] = createEmptyRecord(existing.length, getCourseColumns(course));
    });
    appState.students[course] = existing;

    // Registrar en overrides para que persistan al importar Excel o datos de Firebase
    if (!appState.studentOverrides) appState.studentOverrides = { additions: {}, removals: {} };
    if (!appState.studentOverrides.additions[course]) appState.studentOverrides.additions[course] = [];
    if (!appState.studentOverrides.removals[course])  appState.studentOverrides.removals[course]  = [];
    newStudents.forEach(student => {
        // Si estaba marcado para eliminar, cancelar esa marca
        appState.studentOverrides.removals[course] = appState.studentOverrides.removals[course]
            .filter(s => s.toLowerCase() !== student.toLowerCase());
        // Agregar a additions si no está ya
        const already = appState.studentOverrides.additions[course].some(s => s.toLowerCase() === student.toLowerCase());
        if (!already) appState.studentOverrides.additions[course].push(student);
    });

    // Registrar en historial: conteo incremental por alumno (antes = conteo antes de ese alumno específico)
    const countBase = existing.length - newStudents.length;
    newStudents.forEach((student, idx) => {
        HistoryModule.log("Alumno insertado", course, student, "Matrícula", countBase + idx, countBase + idx + 1);
    });

    selectedCourse = course;
    elements.extraStudents.value = "";
    saveStateAndRender(`${newStudents.length} alumno(s) agregado(s).`);
    showStudentActionNotice("ready",
        newStudents.length === 1 ? "Alumno insertado correctamente." : `${newStudents.length} alumnos insertados correctamente.`,
        `${newStudents.join(", ")} — agregado(s) al curso ${course}.`);

    if (firebaseMode && institutionId && typeof DB !== "undefined") {
        setSyncStatus("Guardando en la nube…", "pending");
        DB.addStudentsToAllSubjects(institutionId, course, newStudents)
            .then(count => {
                setSyncStatus("Guardado en la nube", "online");
                if (count > 0) showToast(`${newStudents.length} alumno(s) guardado(s) en todas las materias.`);
            })
            .catch(err => {
                console.warn("Firestore addStudents error:", err);
                setSyncStatus("Guardado local (sin nube)", "pending");
                showToast("Alumno guardado localmente. Sin conexión a la nube.");
            });
    }
}

async function removeStudent(event) {
    event.preventDefault();
    const course  = elements.removeStudentCourseSelect.value;
    const student = elements.removeStudentSelect.value;
    if (!course || !student) { showToast("Elegí un curso y un alumno."); return; }
    if (!await confirmDialog(`¿Quitar a ${student} de ${course}? También se borrarán sus notas.`, { confirmText: "Sí, quitar", cancelText: "Cancelar" })) return;

    const countBeforeRemove = (appState.students[course] || []).length;
    appState.students[course] = (appState.students[course] || []).filter(n => n !== student);
    delete appState.records[course]?.[student];
    appState.students[course].forEach((name, index) => {
        if (appState.records[course]?.[name]) appState.records[course][name].number = index + 1;
    });
    const countAfterRemove = appState.students[course].length;
    // Registrar con detalle: acción explícita + conteo antes/después via logHistoryEntry (cubre Firebase también)
    HistoryModule.log("Alumno eliminado", course, student, "Matrícula", countBeforeRemove, countAfterRemove);

    // Registrar en overrides para que la eliminación persista al importar Excel o datos de Firebase
    if (!appState.studentOverrides) appState.studentOverrides = { additions: {}, removals: {} };
    if (!appState.studentOverrides.additions[course]) appState.studentOverrides.additions[course] = [];
    if (!appState.studentOverrides.removals[course])  appState.studentOverrides.removals[course]  = [];
    // Si estaba marcado como adición manual, cancelar esa marca
    appState.studentOverrides.additions[course] = appState.studentOverrides.additions[course]
        .filter(s => s.toLowerCase() !== student.toLowerCase());
    // Agregar a removals si no está ya
    const alreadyRemoved = appState.studentOverrides.removals[course].some(s => s.toLowerCase() === student.toLowerCase());
    if (!alreadyRemoved) appState.studentOverrides.removals[course].push(student);

    selectedCourse = course;
    saveStateAndRender(`${student} fue quitado de ${course}.`);
    showStudentActionNotice("warning", "Alumno eliminado correctamente.", `${student} fue quitado del curso ${course}.`);

    if (firebaseMode && institutionId && typeof DB !== "undefined") {
        setSyncStatus("Guardando en la nube…", "pending");
        DB.removeStudentFromAllSubjects(institutionId, course, student)
            .then(() => setSyncStatus("Guardado en la nube", "online"))
            .catch(err => {
                console.warn("Firestore removeStudent error:", err);
                setSyncStatus("Guardado local (sin nube)", "pending");
            });
    }
}

// ── Gestión de columnas de notas ──────────────────────────────────────────────
let _addGradeColHandler  = null;
let _gradeColInfoHandler = null;

function addGradeColumn(label, description) {
    if (!label.trim()) { showToast("El nombre de la evaluación es obligatorio."); return false; }
    if (!(description || "").trim()) { showToast("La descripción es obligatoria."); return false; }
    const targetCourse = selectedCourse;
    if (!targetCourse) { showToast("Elegí un curso primero."); return false; }

    const cols = getCourseColumns(targetCourse);
    let i = cols.length + 1;
    let key;
    do { key = `Nota ${i}`; i++; } while (cols.includes(key));

    if (!Array.isArray(appState.gradeColumns[targetCourse])) {
        appState.gradeColumns[targetCourse] = [...GRADE_COLUMNS];
    }
    appState.gradeColumns[targetCourse].push(key);

    const meta = { label: label.trim(), description: (description || "").trim() };
    if (!appState.gradeColumnsMeta[targetCourse]) appState.gradeColumnsMeta[targetCourse] = {};
    appState.gradeColumnsMeta[targetCourse][key] = { ...meta };

    (appState.students[targetCourse] || []).forEach(student => {
        const rec = appState.records[targetCourse]?.[student];
        if (rec) { rec.grades[key] = ""; rec.average = calculateAverage(Object.values(rec.grades)); }
    });

    saveStateAndRender(`Columna "${label.trim()}" agregada a ${targetCourse}.`);
    return true;
}

function openAddGradeColModal() {
    if (!ensureDataReady()) return;
    if (!canUserEdit) { showToast("Tu rol no permite agregar columnas."); return; }
    const modal = document.getElementById("addGradeColModal");
    const form  = document.getElementById("addGradeColForm");
    const input = document.getElementById("newGradeColName");
    const desc  = document.getElementById("newGradeColDesc");
    if (!modal || !form) return;
    if (input) input.value = "";
    if (desc)  desc.value  = "";
    modal.classList.remove("hidden");
    if (input) setTimeout(() => input.focus(), 80);

    if (_addGradeColHandler) form.removeEventListener("submit", _addGradeColHandler);
    _addGradeColHandler = function(e) {
        e.preventDefault();
        const name    = (input?.value || "").trim();
        const descVal = (desc?.value || "").trim();
        if (!name)    { showToast("El nombre es obligatorio."); input?.focus(); return; }
        if (!descVal) { showToast("La descripción es obligatoria."); desc?.focus(); return; }
        if (addGradeColumn(name, descVal)) {
            modal.classList.add("hidden");
        }
    };
    form.addEventListener("submit", _addGradeColHandler);
}

function openGradeColInfoModal(col, course) {
    const resolvedCourse = course || selectedCourse;
    const modal   = document.getElementById("gradeColInfoModal");
    const eyebrow = document.getElementById("gradeColInfoModalEyebrow");
    const titleEl = document.getElementById("gradeColInfoModalTitle");
    const nameEl  = document.getElementById("editGradeColName");
    const descEl  = document.getElementById("editGradeColDesc");
    const form    = document.getElementById("gradeColInfoForm");
    if (!modal || !form) return;

    const meta  = getColMeta(col, resolvedCourse);
    const label = meta.label || col;
    if (eyebrow) eyebrow.textContent = `Evaluación — ${resolvedCourse}`;
    if (titleEl) titleEl.textContent = label;
    if (nameEl)  nameEl.value        = meta.label || col;
    if (descEl)  descEl.value        = meta.description || "";

    const editable  = canUserEdit;
    if (nameEl) nameEl.disabled = !editable;
    if (descEl) descEl.disabled = !editable;
    const submitBtn = form.querySelector("[type=submit]");
    if (submitBtn)  submitBtn.style.display = editable ? "" : "none";

    modal.classList.remove("hidden");
    if (nameEl && editable) setTimeout(() => nameEl.focus(), 80);

    if (_gradeColInfoHandler) form.removeEventListener("submit", _gradeColInfoHandler);
    if (editable) {
        _gradeColInfoHandler = function(e) {
            e.preventDefault();
            const newLabel = (nameEl?.value || "").trim();
            const newDesc  = (descEl?.value || "").trim();
            if (!newLabel) { showToast("El nombre es obligatorio."); nameEl?.focus(); return; }
            if (!newDesc)  { showToast("La descripción es obligatoria."); descEl?.focus(); return; }
            if (!appState.gradeColumnsMeta[resolvedCourse]) appState.gradeColumnsMeta[resolvedCourse] = {};
            appState.gradeColumnsMeta[resolvedCourse][col] = { label: newLabel, description: newDesc };
            modal.classList.add("hidden");
            saveStateAndRender(`"${newLabel}" (${resolvedCourse}) actualizada.`);
        };
        form.addEventListener("submit", _gradeColInfoHandler);
    }
}

function closeAllModals() {
    ["addGradeColModal", "gradeColInfoModal", "historyModal"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add("hidden");
    });
    closeHeaderTools();
}

// ── Estado y observaciones del alumno ────────────────────────────────────────
function saveStudentExtras() {
    const course  = elements.courseSelect?.value || selectedCourse;
    const student = elements.studentSelect?.value;
    if (!course || !student) { showToast("Elegí un curso y un alumno primero."); return; }
    if (!checkEditAllowed()) return;
    const record    = ensureRecord(course, student);
    const newNotes  = (elements.studentNotesInput?.value  || "").trim();
    const newStatus = elements.studentStatusSelect?.value || "";
    if (record.notes === newNotes && record.status === newStatus) { showToast("Sin cambios."); return; }
    record.notes  = newNotes;
    record.status = newStatus;
    saveStateAndRender(`Alumno ${student}: datos guardados.`);
}

// ── Dropdown de herramientas del header ───────────────────────────────────────
function toggleHeaderTools() {
    const panel  = elements.headerToolsPanel;
    const toggle = elements.headerToolsToggle;
    if (!panel || !toggle) return;
    const isOpen = !panel.classList.contains("hidden");
    if (isOpen) {
        panel.classList.add("hidden");
        toggle.setAttribute("aria-expanded", "false");
    } else {
        panel.classList.remove("hidden");
        toggle.setAttribute("aria-expanded", "true");
    }
}

function closeHeaderTools() {
    elements.headerToolsPanel?.classList.add("hidden");
    elements.headerToolsToggle?.setAttribute("aria-expanded", "false");
}

// ── Auto-backup ───────────────────────────────────────────────────────────────
async function restoreAutoBackup() {
    try {
        const raw = localStorage.getItem(BACKUP_KEY);
        if (!raw) { showToast("No hay auto-backup disponible en este dispositivo."); return; }
        let snap;
        try {
            snap = JSON.parse(raw);
        } catch(parseErr) {
            if (typeof GansoLog !== "undefined") GansoLog.CORRUPTION_DETECTED({ source: "auto_backup", reason: "json_parse_error", err: parseErr.message });
            showToast("El auto-backup está corrupto y no puede leerse.");
            return;
        }
        if (!snap || !Array.isArray(snap.courses)) { showToast("El auto-backup no es válido."); return; }
        const ts = snap.lastSavedAt || "(fecha desconocida)";
        if (!await confirmDialog(`¿Restaurar el auto-backup guardado el ${ts}?\nSe reemplazarán los datos actuales.`, { confirmText: "Sí, restaurar", cancelText: "Cancelar" })) return;
        SyncModule.cancel();
        loadStateFromSnapshot(snap);
        selectedCourse = appState.courses[0] || "";
        activeStep     = 3;
        hasReviewed    = false;
        saveLocalState();
        hydrateControls(); renderAll(); renderSavedSession(); renderFlow(); updateDisabledState();
        if (typeof GansoLog !== "undefined") GansoLog.BACKUP_RESTORED({ source: "auto_backup", subject: appState.subject, ts });
        showToast("Auto-backup restaurado correctamente.");
    } catch(err) {
        if (typeof GansoLog !== "undefined") GansoLog.RECOVERY_FAILED({ source: "auto_backup", err: err.message });
        showToast("No se pudo restaurar el auto-backup.");
    }
}

function createPreOpBackup(reason) {
    try {
        if (!hasData() && !snapshotHasData(savedSnapshot)) return;
        const snap = savedSnapshot || createSnapshot();
        const json = JSON.stringify(snap);
        localStorage.setItem(BACKUP_KEY, json);
        localStorage.setItem(BACKUP_TS_KEY, String(Date.now()));
        if (typeof GansoLog !== "undefined") GansoLog.BACKUP_CREATED({ reason, subject: appState.subject });
    } catch(_) {}
}

// ── Importar alumnos desde Excel (alumnos.html) ────────────────────────────────
function importStudentsFromExcel() {
    const file = elements.studentImportInput?.files?.[0];
    if (!file) return;
    if (typeof XLSX === "undefined") { showToast("Librería Excel no disponible."); return; }
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const workbook  = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
            const course    = elements.studentCourseSelect?.value || "";
            const sheetName = workbook.SheetNames.find(
                n => n.toLocaleLowerCase() === course.toLocaleLowerCase()
            ) || workbook.SheetNames[0];
            if (!sheetName) { showToast("El archivo no tiene hojas."); return; }
            const sheet   = workbook.Sheets[sheetName];
            const rows    = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
            if (!rows.length) { showToast("La hoja está vacía."); return; }

            const headers = (rows[0] || []).map(v => String(v || "").trim());
            const colIdx  = headers.findIndex(h => h.toLocaleLowerCase() === "alumno");
            const useCol  = colIdx >= 0 ? colIdx : 0;
            const startRow = colIdx >= 0 ? 1 : (headers[0] && isNaN(Number(String(headers[0]).replace(",","."))) ? 1 : 0);

            const names = rows.slice(startRow)
                .map(r => String(r[useCol] || "").trim())
                .filter(Boolean);

            if (!names.length) { showToast("No se encontraron nombres en la columna detectada."); return; }
            if (elements.extraStudents) elements.extraStudents.value = names.join("\n");
            showToast(`${names.length} nombre(s) cargado(s). Verificá la lista y hacé clic en "Agregar alumnos".`);
        } catch(err) {
            console.error("Error importando alumnos:", err);
            showToast("No se pudo leer el archivo. ¿Es un Excel válido?");
        } finally {
            if (elements.studentImportInput) elements.studentImportInput.value = "";
        }
    };
    reader.readAsArrayBuffer(file);
}

// ── Datos de prueba ───────────────────────────────────────────────────────────
async function fillTestGrades() {
    if (!hasData()) { showToast("Primero cargá los datos."); return; }
    if (!canUserEdit) { showToast("Tu rol no permite editar notas."); return; }
    const stats = getOverallStats();
    if (stats.missingGrades === 0) { showToast("No hay celdas vacías para completar."); return; }
    if (!await confirmDialog(`Completar ${stats.missingGrades} celda(s) vacía(s) con notas ficticias para pruebas visuales.`, { confirmText: "Sí, completar", cancelText: "Cancelar" })) return;

    let filled = 0;
    const now = formatDateTime(new Date());
    appState.courses.forEach(course => {
        (appState.students[course] || []).forEach(student => {
            const rec = ensureRecord(course, student);
            getCourseColumns(course).forEach(col => {
                if (!hasGrade(rec.grades[col])) {
                    const r = Math.random();
                    let g;
                    if (r < 0.12) g = +(1 + Math.random() * 2.9).toFixed(2);        // < 4 (desaprobado)
                    else if (r < 0.30) g = +(4 + Math.random() * 2.4).toFixed(2);   // 4–6.4 (en proceso)
                    else g = +(6.5 + Math.random() * 3.4).toFixed(2);               // ≥ 6.5 (aprobado)
                    if (Math.random() < 0.45) g = Math.round(g);
                    g = Math.max(0, Math.min(10, Number(g)));
                    rec.grades[col] = g;
                    filled++;
                }
            });
            rec.average   = calculateAverage(Object.values(rec.grades));
            rec.updatedAt = now;
        });
    });

    saveStateAndRender(`${filled} nota(s) de prueba generadas.`);
}

async function generateSampleData() {
    if (isFlowPage() && !appState.subject) { showToast("Primero seleccioná una materia."); setActiveStep(1); return; }
    if ((hasData() || snapshotHasData(savedSnapshot)) &&
        !await confirmDialog("Generar datos de muestra reemplaza los datos actuales.", { confirmText: "Sí, generar", cancelText: "Cancelar" })) return;

    const subject = appState.subject || elements.subjectInput?.value.trim() || "Sin materia";
    SyncModule.cancel();
    appState = createInitialState(subject);
    const now = formatDateTime(new Date());
    const perCourse = 20;

    FIXED_COURSES.forEach(course => {
        const students = generateRandomStudents(perCourse);
        const cols     = getCourseColumns(course);
        appState.students[course] = students;
        if (!appState.gradeColumnsMeta[course]) appState.gradeColumnsMeta[course] = {};
        cols.forEach((col, idx) => {
            appState.gradeColumnsMeta[course][col] = { label: col, description: `Evaluación ${idx + 1} de muestra` };
        });
        students.forEach((student, index) => {
            const grades = {};
            cols.forEach(col => {
                const r = Math.random();
                let g;
                if (r < 0.12) g = +(1 + Math.random() * 2.9).toFixed(2);
                else if (r < 0.30) g = +(4 + Math.random() * 2.4).toFixed(2);
                else g = +(6.5 + Math.random() * 3.4).toFixed(2);
                if (Math.random() < 0.45) g = Math.round(g);
                grades[col] = Math.max(0, Math.min(10, Number(g)));
            });
            appState.records[course][student] = {
                number: index + 1, grades,
                average: calculateAverage(Object.values(grades)), updatedAt: now
            };
        });
    });

    appState.fileName = "muestra_aleatoria.xlsx";
    appState.source   = "muestra";
    selectedCourse = FIXED_COURSES[0];
    activeStep     = 3;
    hasReviewed    = false;
    saveLocalState(false);
    hydrateControls(); renderAll(); renderSavedSession(); renderFlow(); updateDisabledState();
    setSyncStatus("Datos de muestra listos", "online");
    updateNotice("ready", "Datos de muestra generados.", "Notas ficticias — no corresponden a alumnos reales. Podés exportar desde el Paso 4.");
    showToast("Muestra generada: 6 cursos, 20 alumnos c/u.");
}

// ── Datos de demostración persistentes ────────────────────────────────────────
function seedDemoDataIfNeeded() {
    if (!isFlowPage()) return;
    try {
        if (localStorage.getItem(DEMO_STORAGE_KEY)) return;
        const demoState = createInitialState("Matemática");
        const now = formatDateTime(new Date());
        const evalNames = ["1er Parcial", "2do Parcial", "Trabajo Práctico", "Examen Oral", "Trabajo Integrador", "Evaluación Final"];

        FIXED_COURSES.forEach(course => {
            const students = generateRandomStudents(18);
            const cols = [...GRADE_COLUMNS];
            demoState.students[course] = students;
            demoState.gradeColumnsMeta[course] = {};
            cols.forEach((col, idx) => {
                demoState.gradeColumnsMeta[course][col] = {
                    label: evalNames[idx] || col,
                    description: `${evalNames[idx] || col} — datos de demostración`
                };
            });
            students.forEach((student, index) => {
                const grades = {};
                cols.forEach(col => {
                    const r = Math.random();
                    let g;
                    if (r < 0.10)      g = +(1 + Math.random() * 2.9).toFixed(1);
                    else if (r < 0.28) g = +(4 + Math.random() * 2.4).toFixed(1);
                    else               g = +(6.5 + Math.random() * 3.4).toFixed(1);
                    grades[col] = Math.max(0, Math.min(10, Number(g)));
                });
                demoState.records[course][student] = {
                    number: index + 1, grades,
                    average: calculateAverage(Object.values(grades)), updatedAt: now
                };
            });
        });

        demoState.fileName = "demo_matematica.xlsx";
        demoState.source   = "demo";
        demoState.lastSavedAt = now;

        const snapshot = {
            version: APP_VERSION, schemaVersion: SCHEMA_VERSION,
            subject: demoState.subject, fileName: demoState.fileName,
            source: demoState.source, courses: [...demoState.courses],
            students: demoState.students, records: demoState.records,
            historyRows: [], validation: { errors: [], warnings: [] },
            gradeColumns: demoState.gradeColumns, gradeColumnsMeta: demoState.gradeColumnsMeta,
            studentOverrides: { additions: {}, removals: {} },
            pendingHistoryRows: [],
            selectedCourse: FIXED_COURSES[0], lastSavedAt: now
        };
        localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(snapshot));
    } catch(e) {
        console.warn("Ganso-Paralelo: no se pudieron crear datos de demo.", e);
    }
}

// ── Exportación a Excel ───────────────────────────────────────────────────────
async function exportFinalExcel() {
    if (!hasData()) { showToast("Complete los pasos anteriores para exportar."); return; }

    const stats = getOverallStats();
    if (stats.missingGrades > 0) {
        const ok = await confirmDialog(
            `Hay ${stats.missingGrades} nota(s) sin cargar.\n\nLas celdas vacías aparecerán en blanco en el Excel.`,
            { confirmText: "Exportar igual", cancelText: "Cancelar" }
        );
        if (!ok) return;
    }

    const btn = elements.exportExcelButton;
    const prevText = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Exportando…"; }
    setSyncStatus("Generando Excel…", "pending");

    try {
        saveLocalState(true);
        const workbook = ExcelModule.buildWorkbook();
        const data = XLSX.write(workbook, { bookType: "xlsx", type: "array", compression: true });
        const blob = new Blob([data], { type: EXCEL_MIME });
        const fileName = ExcelModule.buildExportFileName("xlsx");
        _lastExportData = { data, fileName };
        ExcelModule.downloadBlob(blob, fileName);
        setSyncStatus("Excel generado correctamente", "online");
        showToast("Excel generado correctamente.");
        showExportSuccess(fileName);
    } catch (error) {
        console.error(error);
        setSyncStatus("Error al exportar", "error");
        showToast("Error al generar el archivo. Intentá de nuevo.");
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = prevText; }
    }
}

function autoExportExcel() {
    if (!window.XLSX) return;
    try {
        const workbook = ExcelModule.buildWorkbook();
        const data     = XLSX.write(workbook, { bookType: "xlsx", type: "array", compression: true });
        const blob     = new Blob([data], { type: EXCEL_MIME });
        ExcelModule.downloadBlob(blob, ExcelModule.buildExportFileName("xlsx"));
        showToast("Excel actualizado y descargado.");
    } catch (err) {
        console.error(err);
        showToast("Cambios guardados. No se pudo exportar el Excel.");
    }
}

function resetAfterExport() {
    SyncModule.detach();
    if (elements.exportSuccessOverlay) elements.exportSuccessOverlay.classList.add("hidden");
    _lastExportData = null;
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
    updateNotice("ready", "Materia cerrada.", "Cargá el archivo de la nueva planilla para continuar.");
}

// Flush garantizado antes del reset post-exportación.
// Captura el snapshot y el institutionId ANTES de que resetAfterExport los destruya,
// luego hace un write explícito y awaitable a Firestore, y recién después resetea.
async function flushAndResetAfterExport() {
    const snap   = savedSnapshot;   // capturado ANTES del reset (resetAfterExport lo nullea)
    const instId = institutionId;   // no se borra en reset, pero lo capturamos igual

    // Cancelar el debounce pendiente: vamos a escribir de forma directa y garantizada.
    SyncModule.cancel();

    if (snap && snap.subject && firebaseMode && instId && typeof DB !== "undefined") {
        try { await DB.saveSubjectData(instId, snap.subject, snap); } catch (_) {}
    }

    resetAfterExport();
}

function showExportSuccess(fileName) {
    if (elements.exportSuccessFile) elements.exportSuccessFile.textContent = fileName;
    if (elements.exportSuccessOverlay) elements.exportSuccessOverlay.classList.remove("hidden");

    const shareBtn = elements.exportShareBtn;
    if (shareBtn) {
        const isElectron = navigator.userAgent.includes("Electron");
        const canShare = isElectron ||
                         (typeof navigator.share === "function") ||
                         Boolean(typeof Auth !== "undefined" && Auth.getUser && Auth.getUser()?.email);
        shareBtn.style.display = canShare ? "" : "none";
        shareBtn.addEventListener("click", async () => {
            await EmailModule.share(_lastExportData);
            if (elements.exportSuccessOverlay) elements.exportSuccessOverlay.classList.add("hidden");
        }, { once: true });
    }

    const btn = elements.exportSuccessBtn;
    if (btn) btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Guardando...";
        await flushAndResetAfterExport();
    }, { once: true });
}


function resetToStep1() {
    SyncModule.detach();
    SyncModule.cancel();
    if (elements.exportSuccessOverlay) elements.exportSuccessOverlay.classList.add("hidden");
    _lastExportData = null;
    appState      = createInitialState();
    selectedCourse = "";
    activeStep    = 1;
    hasReviewed   = false;
    savedSnapshot = null;
    dbPendingData = null;
    lockState     = { locked: false, lockedBy: null, lockedByName: null };
    if (elements.subjectInput) elements.subjectInput.value = "";
    if (elements.dbDataBox) elements.dbDataBox.classList.add("hidden");
    hydrateControls();
    renderAll();
    renderFlow();
    updateDisabledState();
    updateLockUI();
    setSyncStatus("Conectado", "online");
    updateNotice("warning", "Para comenzar, seleccioná la materia.", "El sistema te guiará paso a paso hasta generar el archivo final.");
}

// ── Estado de controles ───────────────────────────────────────────────────────
function updateCurrentNote() {
    if (!elements.currentNote) return;
    const record = getSelectedRecord();
    const column = elements.gradeColumnSelect?.value;
    const value  = column ? record.grades[column] : undefined;
    const label  = column ? getColLabel(column, selectedCourse) : "Nota";
    elements.currentNote.textContent =
        `Nota actual en ${label}: ${hasGrade(value) ? formatNumber(value) : "sin cargar"}`;
    // Sincronizar panel de extras con el alumno seleccionado
    if (elements.studentNotesInput)   elements.studentNotesInput.value   = record.notes  || "";
    if (elements.studentStatusSelect) elements.studentStatusSelect.value = record.status || "";
}

function getSelectedRecord() { return getRecord(selectedCourse, elements.studentSelect?.value); }

function getRecord(course, student) {
    if (!course || !student) return createEmptyRecord();
    return appState.records[course]?.[student] || createEmptyRecord();
}

function ensureRecord(course, student) {
    if (!course || !student) return createEmptyRecord();
    appState.records[course] = appState.records[course] || {};
    if (!appState.records[course][student]) {
        const index = (appState.students[course] || []).indexOf(student);
        appState.records[course][student] = createEmptyRecord(index >= 0 ? index + 1 : "", getCourseColumns(course));
    }
    return appState.records[course][student];
}

function createEmptyRecord(number = "", cols) {
    const c = Array.isArray(cols) ? cols : GRADE_COLUMNS;
    return { number, grades: Object.fromEntries(c.map(col => [col, ""])), average: "", updatedAt: "", notes: "", status: "", trayectoria: "" };
}

function ensureDataReady() {
    if (hasData()) return true;
    showToast("Primero cargá los datos.");
    return false;
}

function ensureGradeTarget(record, column) {
    if (!selectedCourse || !elements.studentSelect?.value || !column) {
        showToast("Elegí un curso, un alumno y una columna.");
        return false;
    }
    return Boolean(record);
}

function fillSelect(select, values, emptyText) {
    if (!select) return;
    select.innerHTML = "";
    if (!values.length) {
        const opt = document.createElement("option");
        opt.value = ""; opt.textContent = emptyText;
        select.appendChild(opt);
        return;
    }
    values.forEach(v => {
        const opt = document.createElement("option");
        opt.value = v; opt.textContent = v;
        select.appendChild(opt);
    });
}

function fillGradeColumnSelect(select) {
    if (!select) return;
    const prev = select.value;
    select.innerHTML = "";
    const cols = getCourseColumns(selectedCourse);
    if (!cols.length) {
        const opt = document.createElement("option");
        opt.value = ""; opt.textContent = "Sin columnas";
        select.appendChild(opt);
        return;
    }
    cols.forEach(col => {
        const opt = document.createElement("option");
        opt.value = col;
        opt.textContent = getColLabel(col, selectedCourse);
        select.appendChild(opt);
    });
    if (cols.includes(prev)) select.value = prev;
}

function updateDisabledState() {
    const dataReady    = hasData();
    const editingStep  = !isFlowPage() || activeStep === 3;
    const locked       = lockState && lockState.locked && !(firebaseMode && typeof Auth !== "undefined" && Auth.isAdmin());
    const canEditGrades = editingStep && dataReady && !isSaving && canUserEdit && !locked;

    [elements.courseSelect, elements.studentSelect, elements.gradeColumnSelect,
     elements.gradeInput, elements.insertButton, elements.changeButton, elements.deleteGradeButton,
     elements.addColCtaBtn,
     elements.studentStatusSelect, elements.studentNotesInput, elements.saveStudentExtrasBtn
    ].forEach(el => { if (el) el.disabled = !canEditGrades; });

    if (elements.openHistoryBtn) {
        const canShowHistory = appState.historyRows.length > 0 ||
            (firebaseMode && !!institutionId && !!appState.subject);
        elements.openHistoryBtn.disabled = !canShowHistory;
    }

    if (elements.goReviewButton) elements.goReviewButton.disabled = !editingStep || !dataReady || isSaving;

    const canManageStudents = !isSaving &&
        (!firebaseMode || ['admin','superadmin','preceptoria'].includes(currentUserRole));
    [elements.newCourseName, elements.newCourseStudentsCount, elements.studentCourseSelect,
     elements.extraStudents, elements.addCourseButton, elements.addStudentsButton,
     elements.removeStudentCourseSelect, elements.removeStudentSelect, elements.removeStudentButton
    ].forEach(el => { if (el) el.disabled = !canManageStudents; });

    if (elements.openWorkbookButton)   elements.openWorkbookButton.disabled   = isSaving || (isFlowPage() && !appState.subject);
    if (elements.generateSampleBtn)    elements.generateSampleBtn.disabled    = isSaving || (isFlowPage() && !appState.subject);
    if (elements.continueSavedButton)  elements.continueSavedButton.disabled  = isSaving || !snapshotHasData(savedSnapshot);
    if (elements.startNewButton)       elements.startNewButton.disabled       = isSaving;
    if (elements.confirmSubjectButton) elements.confirmSubjectButton.disabled = isSaving;
    [elements.backupButton, elements.backupButtonSecondary, elements.clearAllButton].forEach(el => {
        if (el) el.disabled = isSaving || (!dataReady && !snapshotHasData(savedSnapshot));
    });
    if (elements.exportExcelButton) elements.exportExcelButton.disabled = isSaving || !dataReady;
}

// ── Estadísticas ──────────────────────────────────────────────────────────────
function getCourseStats(course) {
    const students = appState.students[course] || [];
    const records  = students.map(s => getRecord(course, s));
    const cols     = getCourseColumns(course);
    const allGrades  = records.flatMap(r => cols.map(col => r.grades[col]));
    const loadedGrades = allGrades.filter(hasGrade).length;
    const totalGrades  = students.length * cols.length;
    const passed = records.filter(r => {
        const avg = calculateAverage(Object.values(r.grades));
        return avg !== null && avg >= PASS_THRESHOLD;
    }).length;
    const failed = records.filter(r => {
        const avg = calculateAverage(Object.values(r.grades));
        return avg !== null && avg < PASS_THRESHOLD;
    }).length;
    return {
        course, students: students.length, loadedGrades,
        missingGrades: Math.max(totalGrades - loadedGrades, 0),
        passed, failed,
        average:     calculateAverage(allGrades),
        lastUpdated: getLastUpdate(records.map(r => r.updatedAt))
    };
}

function getOverallStats() {
    const courseStats = appState.courses.map(getCourseStats);
    const allGrades   = appState.courses.flatMap(course =>
        (appState.students[course] || []).flatMap(s => Object.values(getRecord(course, s).grades))
    );
    return {
        courses:      appState.courses.length,
        students:     courseStats.reduce((t, cs) => t + cs.students, 0),
        loadedGrades: courseStats.reduce((t, cs) => t + cs.loadedGrades, 0),
        missingGrades:courseStats.reduce((t, cs) => t + cs.missingGrades, 0),
        passed:       courseStats.reduce((t, cs) => t + cs.passed, 0),
        failed:       courseStats.reduce((t, cs) => t + cs.failed, 0),
        average:      calculateAverage(allGrades),
        lastUpdated:  getLastUpdate(courseStats.map(cs => cs.lastUpdated))
    };
}

function areNotesComplete() {
    const stats = getOverallStats();
    return hasData() && stats.students > 0 && stats.missingGrades === 0;
}

function getSnapshotStats(snapshot) {
    const courses  = Array.isArray(snapshot.courses) ? snapshot.courses : [];
    const students = courses.reduce((t, c) => t + ((snapshot.students?.[c] || []).length), 0);
    return { courses: courses.length, students };
}

function getLastUpdate(values) {
    const clean = values.filter(Boolean);
    if (!clean.length) return "";
    return clean.map(v => ({ v, t: parseDateTime(v) })).sort((a, b) => b.t - a.t)[0].v;
}

function hasData() {
    return appState.courses.some(c => (appState.students[c] || []).length > 0);
}

// ── Notas: parsing y cálculo ──────────────────────────────────────────────────
function parseGrade(value) {
    const normalized = String(value || "").trim().replace(",", ".");
    if (!normalized) return null;
    const number = Number(normalized);
    if (!Number.isFinite(number) || number < 0 || number > 10) return null;
    const rounded = Number(number.toFixed(2));
    return Number.isInteger(rounded) ? Math.trunc(rounded) : rounded;
}

function normalizeGrade(value) {
    if (value === null || value === undefined || value === "") return "";
    if (typeof value === "number" && Number.isFinite(value)) {
        const rounded = Number(value.toFixed(2));
        return Number.isInteger(rounded) ? Math.trunc(rounded) : rounded;
    }
    const parsed = parseGrade(String(value));
    return parsed === null ? "" : parsed;
}

function calculateAverage(values) {
    const grades = values.filter(hasGrade).map(v => Number(String(v).replace(",", "."))).filter(v => Number.isFinite(v));
    if (!grades.length) return null;
    const avg = Number((grades.reduce((t, v) => t + v, 0) / grades.length).toFixed(2));
    return Number.isInteger(avg) ? Math.trunc(avg) : avg;
}

function hasGrade(value) { return value !== "" && value !== null && value !== undefined; }

function gradeToneClass(value) {
    if (!hasGrade(value)) return "";
    const grade = Number(String(value).replace(",", "."));
    if (!Number.isFinite(grade)) return "";
    if (grade < 4) return "grade-fail";
    if (grade < PASS_THRESHOLD) return "grade-warn";
    return "grade-pass";
}

function rowToneClass(average) {
    if (average === null) return "";
    if (average < 4) return "row-fail";
    if (average < PASS_THRESHOLD) return "row-warn";
    return "row-pass";
}

function sameGrade(left, right) {
    if (!hasGrade(left) && !hasGrade(right)) return true;
    if (!hasGrade(left) || !hasGrade(right)) return false;
    return Number(String(left).replace(",", ".")) === Number(String(right).replace(",", "."));
}

// ── Utilidades ────────────────────────────────────────────────────────────────
function parseStudentsText(raw) {
    return uniqueStrings(raw.replace(/;/g, "\n").split(/\r?\n/).map(l => l.trim()).filter(Boolean));
}

function uniqueStrings(values) {
    const seen = new Set();
    return (Array.isArray(values) ? values : [])
        .map(v => String(v || "").trim()).filter(Boolean)
        .filter(v => { const k = v.toLocaleLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

function isValidSheetName(name)   { return name.length > 0 && name.length <= 31 && !/[:\\/?*[\]]/.test(name); }
function findCourseByName(name)   { const k = name.toLocaleLowerCase(); return appState.courses.find(c => c.toLocaleLowerCase() === k); }

function formatNumber(value) {
    if (value === null || value === undefined || value === "") return "";
    const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
    if (!Number.isFinite(n)) return String(value ?? "");
    return n.toFixed(1).replace(".", ",");
}

function formatDateTime(date) {
    const d = String(date.getDate()).padStart(2, "0");
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const y = date.getFullYear();
    const H = String(date.getHours()).padStart(2, "0");
    const M = String(date.getMinutes()).padStart(2, "0");
    const S = String(date.getSeconds()).padStart(2, "0");
    return `${d}/${m}/${y} ${H}:${M}:${S}`;
}

function parseDateTime(value) {
    const s = String(value || "");
    // With seconds (new format): dd/mm/yyyy HH:MM:SS
    let match = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
    if (match) {
        const [, dd, mm, yyyy, HH, MM, SS] = match;
        return new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(HH), Number(MM), Number(SS)).getTime();
    }
    // Without seconds (legacy format): dd/mm/yyyy HH:MM
    match = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
    if (!match) return 0;
    const [, dd, mm, yyyy, HH, MM] = match;
    return new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(HH), Number(MM)).getTime();
}


// ── Selección de institución ──────────────────────────────────────────────────
function getSessionInstitution() {
    try {
        const raw = sessionStorage.getItem(INST_SESSION_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        return (obj && obj.id) ? obj : null;
    } catch(_) { return null; }
}

function setSessionInstitution(id, name) {
    try { sessionStorage.setItem(INST_SESSION_KEY, JSON.stringify({ id, name })); } catch(_) {}
}

function clearSessionInstitution() {
    try { sessionStorage.removeItem(INST_SESSION_KEY); } catch(_) {}
}

async function changeInstitution() {
    if (hasData() && isFlowPage() &&
        !await confirmDialog("Cambiar de institución va a limpiar los datos cargados actualmente.", { confirmText: "Sí, cambiar", cancelText: "Cancelar" })) return;
    clearSessionInstitution();
    showInstitutionPickerModal(({ id, name }) => {
        setSessionInstitution(id, name);
        clearAllLocalSnapshots();
        if (isFlowPage()) {
            institutionId   = id;
            institutionName = name;
            updateInstitutionDisplay();
            resetToStep1();
            showToast(`Trabajando con: ${name}`);
        } else {
            window.location.reload();
        }
    });
}

async function showInstitutionPickerModal(onSelect) {
    const overlay = document.createElement("div");
    overlay.className = "inst-picker-modal";
    const canClose = Boolean(hasData() || snapshotHasData(savedSnapshot));
    overlay.innerHTML = `
        <div class="inst-picker-modal-card" role="dialog" aria-modal="true" aria-labelledby="instPickerModalHeading">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:4px;">
                <p class="eyebrow dark" style="margin:0;">Ganso-Paralelo</p>
                ${canClose ? `<button type="button" class="inst-picker-close-btn" aria-label="Cerrar">✕</button>` : ""}
            </div>
            <h2 class="inst-picker-modal-title" id="instPickerModalHeading">Seleccioná la institución</h2>
            <p class="inst-picker-modal-sub">Elegí con qué colegio querés trabajar en esta sesión.</p>
            <div id="instPickerModalList"><div class="inst-picker-loading"><span class="spinner"></span> Cargando...</div></div>
        </div>`;
    document.body.appendChild(overlay);
    trapFocus(overlay.querySelector(".inst-picker-modal-card"));

    let _escHandler = null;
    const closeModal = () => {
        overlay.remove();
        if (_escHandler) { document.removeEventListener("keydown", _escHandler); _escHandler = null; }
    };

    if (canClose) {
        overlay.querySelector(".inst-picker-close-btn")?.addEventListener("click", closeModal);
        overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });
        _escHandler = e => { if (e.key === "Escape") closeModal(); };
        document.addEventListener("keydown", _escHandler);
    }

    const listEl = document.getElementById("instPickerModalList");

    function renderRetry(msg) {
        listEl.innerHTML = `<div style="text-align:center;padding:24px 0;">
            <p style="color:var(--danger);margin-bottom:16px;">${escapeHtml(msg)}</p>
            <button type="button" class="btn secondary" id="instPickerRetryBtn">Reintentar</button>
        </div>`;
        document.getElementById("instPickerRetryBtn")?.addEventListener("click", load);
    }

    async function load() {
        listEl.innerHTML = `<div class="inst-picker-loading"><span class="spinner"></span> Cargando...</div>`;
        try {
            let insts = [];
            if (typeof DB !== "undefined") {
                const profile = typeof Auth !== "undefined" ? Auth.getProfile() : null;
                // 'admin' es admin de institución (escopeado), no acceso global — solo
                // 'superadmin' ve el listado completo de instituciones.
                if (profile && profile.role === 'superadmin') {
                    insts = await DB.getInstitutions();
                } else if (profile) {
                    const ids = profile.institutionIds || (profile.institutionId ? [profile.institutionId] : []);
                    insts = ids.length ? await DB.getInstitutionsForUser(ids) : [];
                }
            }
            if (!insts.length) {
                listEl.innerHTML = '<p style="text-align:center;color:var(--muted);padding:24px 0;">No hay instituciones registradas.<br>Contactá al administrador del sistema.</p>';
                return;
            }
            listEl.innerHTML = `<div class="inst-cards-grid">${insts.map(i => `
                <div class="inst-card" data-id="${escapeAttribute(i.id)}" data-name="${escapeAttribute(i.name)}">
                    <div class="inst-card-name">${escapeHtml(i.name)}</div>
                    <code class="inst-card-id">${escapeHtml(i.id)}</code>
                    <p class="inst-click-hint">Clic para seleccionar →</p>
                </div>`).join("")}</div>`;
            listEl.querySelectorAll(".inst-card").forEach(card => {
                card.addEventListener("click", () => {
                    closeModal();
                    onSelect({ id: card.dataset.id, name: card.dataset.name });
                });
            });
        } catch(err) {
            renderRetry(`Error al cargar instituciones: ${err.message}`);
        }
    }

    load();
}

// ── Cursos fijos: mapeo desde hojas Excel ────────────────────────────────────
function mapToFixedCourse(sheetName) {
    const n = String(sheetName || "")
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .trim().toLowerCase()
        .replace(/\s*[°º]\s*/g, "")
        .replace(/\s*[ab]$/i, "")
        .replace(/\s+/g, "");
    if (/^(1|1ero|1er|1ro|primero)$/.test(n))     return "1ero";
    if (/^(2|2do|2ndo|2d|segundo)$/.test(n))       return "2do";
    if (/^(3|3ero|3er|3ro|tercero)$/.test(n)) return "3ero";
    if (/^(4|4to|4t|cuarto)$/.test(n))             return "4to";
    if (/^(5|5to|5t|quinto)$/.test(n))             return "5to";
    if (/^(6|6to|6t|sexto)$/.test(n))              return "6to";
    return null;
}

// ── Migración de gradeColumnsMeta plano → per-curso ───────────────────────────
function migrateGradeColumnsMeta(meta, courses) {
    if (!meta || typeof meta !== "object") return {};
    const keys = Object.keys(meta);
    if (!keys.length) return {};
    // Old flat format: top-level keys are column names ("Nota 1", "Nota 2", ...)
    const isOldFormat = /^Nota \d+$/.test(keys[0]) ||
        (meta[keys[0]] && typeof meta[keys[0]] === "object" && "label" in meta[keys[0]] &&
         !FIXED_COURSES.some(c => keys[0] === c));
    if (isOldFormat) {
        const migrated = {};
        (courses || FIXED_COURSES).forEach(course => {
            migrated[course] = {};
            Object.entries(meta).forEach(([col, colMeta]) => {
                if (colMeta && typeof colMeta === "object") {
                    migrated[course][col] = cloneData(colMeta);
                }
            });
        });
        return migrated;
    }
    return cloneData(meta);
}

function cloneData(value)                { return JSON.parse(JSON.stringify(value)); }
function pushLimited(list, msg, limit = 10) {
    if (list.length < limit) list.push(msg);
    else if (list.length === limit) list.push("Hay más avisos similares.");
}
function setText(el, value) { if (el) el.textContent = value; }
function on(el, evt, handler) { if (el) el.addEventListener(evt, handler); }

function setSyncStatus(text, type) {
    if (!elements.syncStatus) return;
    elements.syncStatus.textContent = text;
    elements.syncStatus.classList.remove("online", "error", "pending");
    if (type) elements.syncStatus.classList.add(type);
}

// Banner persistente (no se autooculta) para cuando se agotan los reintentos
// de guardado en Firestore. Los datos siguen a salvo en localStorage/IndexedDB;
// esto solo hace visible que todavía no llegaron a la nube.
function showCloudSaveFailedBanner() {
    window._gansoUnsavedToCloud = true;
    let banner = document.getElementById("cloudSaveFailedBanner");
    if (!banner) {
        banner = document.createElement("div");
        banner.id = "cloudSaveFailedBanner";
        banner.setAttribute("role", "alert");
        banner.style.position = "fixed";
        banner.style.left = "0";
        banner.style.right = "0";
        banner.style.bottom = "0";
        banner.style.zIndex = "99999";
        banner.style.background = "#b91c1c";
        banner.style.color = "#ffffff";
        banner.style.padding = "12px 16px";
        banner.style.display = "flex";
        banner.style.alignItems = "center";
        banner.style.justifyContent = "space-between";
        banner.style.gap = "12px";
        banner.style.flexWrap = "wrap";
        banner.style.fontSize = "14px";
        banner.style.fontWeight = "600";
        banner.style.boxShadow = "0 -2px 10px rgba(0,0,0,0.25)";
        banner.innerHTML =
            '<span style="flex:1 1 260px;">Las notas se guardaron en ESTE dispositivo pero todavía NO se subieron a la nube. Revisá tu conexión — se reintentará solo al reconectar.</span>' +
            '<button type="button" id="cloudSaveFailedBannerBtn" style="flex:0 0 auto;background:#ffffff;color:#b91c1c;border:none;border-radius:6px;padding:8px 14px;font-weight:800;cursor:pointer;">Entendido</button>';
        document.body.appendChild(banner);
        // "Entendido" solo oculta el banner — no borra datos ni limpia
        // window._gansoUnsavedToCloud, así que beforeunload sigue advirtiendo
        // hasta que el guardado en la nube realmente tenga éxito.
        banner.querySelector("#cloudSaveFailedBannerBtn").addEventListener("click", () => {
            banner.style.display = "none";
        });
    }
    banner.style.display = "flex";
}

function clearCloudSaveFailedBanner() {
    window._gansoUnsavedToCloud = false;
    const banner = document.getElementById("cloudSaveFailedBanner");
    if (banner) banner.style.display = "none";
}

function updateNotice(type, title, detail) {
    if (!elements.fileNotice) return;
    elements.fileNotice.classList.remove("ready", "warning", "error");
    if (type) elements.fileNotice.classList.add(type);
    elements.fileNotice.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`;
}

function showToast(message) {
    if (!elements.toast) return;
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("visible");
    toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 3000);
}

function showStudentActionNotice(type, strongText, bodyText) {
    const el = elements.studentActionNotice;
    if (!el) return;
    el.className = `notice ${type}`;
    el.innerHTML = `<strong>${escapeHtml(strongText)}</strong><span>${escapeHtml(bodyText)}</span>`;
    el.style.display = '';
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => { el.style.display = 'none'; }, 8000);
}

function getErrorMessage(error, fallback) {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === "string" && error.trim()) return error;
    return fallback;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function trapFocus(dialogEl) {
    dialogEl.addEventListener("keydown", function(e) {
        if (e.key !== "Tab" || dialogEl.classList.contains("hidden")) return;
        const selectors = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
        const focusable = Array.from(dialogEl.querySelectorAll(selectors))
            .filter(el => getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden");
        if (!focusable.length) return;
        const first = focusable[0];
        const last  = focusable[focusable.length - 1];
        if (e.shiftKey) {
            if (document.activeElement === first) { last.focus(); e.preventDefault(); }
        } else {
            if (document.activeElement === last) { first.focus(); e.preventDefault(); }
        }
    });
}

function confirmDialog(message, { confirmText = "Confirmar", cancelText = "Cancelar" } = {}) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "confirm-overlay";
        overlay.innerHTML = `
            <div class="confirm-card" role="dialog" aria-modal="true">
                <p>${escapeHtml(message)}</p>
                <div class="confirm-actions">
                    <button class="secondary-button confirm-cancel">${escapeHtml(cancelText)}</button>
                    <button class="danger-button confirm-ok">${escapeHtml(confirmText)}</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const cleanup = (result) => { overlay.remove(); resolve(result); };
        overlay.querySelector(".confirm-ok").addEventListener("click", () => cleanup(true));
        overlay.querySelector(".confirm-cancel").addEventListener("click", () => cleanup(false));
        overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") cleanup(false); });
        overlay.querySelector(".confirm-ok").focus();
    });
}

function escapeAttribute(value) { return escapeHtml(value); }

// ── Scroll superior sincronizado ──────────────────────────────────────────────
function setupTableTopScroll() {
    const topScroll = document.getElementById("tableTopScroll");
    const tableWrap = document.querySelector(".table-panel .table-wrap");
    if (!topScroll || !tableWrap) return;
    let syncingTop  = false;
    let syncingWrap = false;
    topScroll.addEventListener("scroll", () => {
        if (syncingTop) return;
        syncingWrap = true;
        tableWrap.scrollLeft = topScroll.scrollLeft;
        syncingWrap = false;
    });
    tableWrap.addEventListener("scroll", () => {
        if (syncingWrap) return;
        syncingTop = true;
        topScroll.scrollLeft = tableWrap.scrollLeft;
        syncingTop = false;
    });
}

function updateTableTopScrollWidth() {
    const inner = document.getElementById("tableTopScrollInner");
    const table = document.querySelector(".table-panel .table-wrap table");
    if (!inner || !table) return;
    inner.style.width = table.scrollWidth + "px";
}
