    'use strict';

    // ── Constantes académicas (modificar para cambiar criterios) ────────────────
    // Estos rangos convierten el promedio numérico interno a trayectoria visible
    const TEA_MIN_DEFAULT = 7.0;  // >= TEA_MIN → TEA (Trayectoria Educativa Avanzada)
    const TEP_MIN_DEFAULT = 4.0;  // >= TEP_MIN y < TEA_MIN → TEP (en Proceso)
    // promedio < TEP_MIN → TED (Trayectoria Educativa Discontinua)

    const FIXED_COURSES  = ["1ero","2do","3ero","4to","5to","6to"];
    const GRADE_COLS_DEF = ["Nota 1","Nota 2","Nota 3","Nota 4","Nota 5","Nota 6"];
    const SESS_KEY       = 'app_institution';

    let institutionId    = '';
    let institutionName  = '';
    let allSubjectData   = [];
    let logoBase64       = null;
    let toastTimer       = 0;
    let _refreshInFlight = false;

    // ── Utilidades ─────────────────────────────────────────────────────────────
    function $(id) { return document.getElementById(id); }

    function showToast(msg, dur = 3500) {
        const t = $('toast');
        clearTimeout(toastTimer);
        t.textContent = msg;
        t.classList.add('visible');
        toastTimer = setTimeout(() => t.classList.remove('visible'), dur);
    }

    function escHtml(v) {
        return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function getTeaMin() { return parseFloat($('teaMin')?.value ?? TEA_MIN_DEFAULT) || TEA_MIN_DEFAULT; }
    function getTepMin() { return parseFloat($('tepMin')?.value ?? TEP_MIN_DEFAULT) || TEP_MIN_DEFAULT; }

    function trajectoryDescription(t) {
        return { TEA: 'Trayectoria Educativa Avanzada', TEP: 'Trayectoria Educativa en Proceso', TED: 'Trayectoria Educativa Discontinua' }[t] || '';
    }

    function computeAvg(grades, cols) {
        return Utils.calculateAverage(cols.map(c => grades?.[c]));
    }

    function getSessionInst() {
        try { const r = sessionStorage.getItem(SESS_KEY); return r ? JSON.parse(r) : null; } catch(_) { return null; }
    }

    function getConfig() {
        return {
            periodo:      ($('periodoInput')?.value || '').trim(),
            schoolYear:   ($('schoolYear')?.value   || String(new Date().getFullYear())).trim(),
            directorName: ($('directorName')?.value || '').trim(),
            directorTitle:($('directorTitle')?.value|| '').trim(),
            instNote:     ($('institutionalNote')?.value || '').trim(),
        };
    }

    // ── Carga del logo (fetch, compatible con web/Electron/APK) ────────────────
    async function preloadLogo() {
        try {
            const resp = await fetch('logos/web-app-manifest-192x192.png');
            if (!resp.ok) return;
            const blob = await resp.blob();
            logoBase64 = await new Promise((res, rej) => {
                const reader = new FileReader();
                reader.onload  = () => res(reader.result);
                reader.onerror = () => res(null);
                reader.readAsDataURL(blob);
            });
        } catch (_) { logoBase64 = null; }
    }

    // ── Inicio ─────────────────────────────────────────────────────────────────
    Auth.requireAuth(['admin', 'superadmin', 'preceptoria', 'profesor']);

    Auth.onReady(async (profile) => {
        if (!profile) return;

        const pill   = $('userPill');
        const nameEl = $('headerUserName');
        const roleEl = $('headerRoleTag');
        if (pill)   pill.style.display = '';
        if (nameEl) nameEl.textContent = Auth.getName();
        if (roleEl) { roleEl.textContent = Auth.getRoleLabel(); roleEl.className = `role-tag ${profile.role}`; }
        if (profile.role === 'admin' || profile.role === 'superadmin') { const l = $('adminLink'); if(l) l.style.display = ''; }

        const saved = getSessionInst();
        if (!saved) { window.location.href = 'index.html'; return; }
        institutionId   = saved.id;
        institutionName = saved.name || Auth.getInstitutionName() || saved.id;

        // Pre-fill school year with current year
        if ($('schoolYear') && !$('schoolYear').value) {
            $('schoolYear').value = new Date().getFullYear();
        }

        await Promise.all([loadData(), preloadLogo()]);

        // Suscribirse a cambios en tiempo real de la colección de materias.
        // Cuando el admin agrega/quita alumnos, esta página se actualiza sola
        // (2s de debounce para agrupar escrituras en batch).
        if (typeof DB !== 'undefined' && DB.subscribeToInstitutionSubjects) {
            let _firstSnap = true;
            let _refreshTimer = null;
            DB.subscribeToInstitutionSubjects(institutionId, () => {
                if (_firstSnap) { _firstSnap = false; return; } // ignorar snapshot inicial
                clearTimeout(_refreshTimer);
                _refreshTimer = setTimeout(() => {
                    if (document.visibilityState === 'visible') refreshData();
                }, 2000);
            });
        }
    });

    $('logoutButton').addEventListener('click', () => {
        window._gansoLogout = true;
        // Prevenir ghost state: limpiar datos locales de la sesión antes de cerrar.
        // Necesario cuando el usuario trabajó en index.html y cerró sesión desde aquí.
        try {
            const inst = institutionId ? String(institutionId).replace(/[^a-zA-Z0-9]/g, '_') : 'local';
            const prefix = `notas_docente_v2_${inst}_`;
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(prefix)) keys.push(k); }
            keys.forEach(k => localStorage.removeItem(k));
            localStorage.removeItem(`ganso_last_subject_v2_${inst}`);
            localStorage.removeItem('notas_docente_estado_v2');
        } catch(_) {}
        Auth.signOut();
    });

    // ── Carga de datos ─────────────────────────────────────────────────────────
    async function loadData() {
        if (_refreshInFlight) return;
        _refreshInFlight = true;
        try {
            allSubjectData = await DB.getAllSubjectDataForInstitution(institutionId);
            allSubjectData.sort((a, b) => (a.subject || '').localeCompare(b.subject || '', 'es'));
            mergeLocalStorageData(allSubjectData);

            if (!allSubjectData.length) {
                $('controlsLoading').innerHTML = '<p style="color:var(--muted);font-size:13px;">No hay materias inicializadas.</p>';
                return;
            }

            $('controlsLoading').style.display = 'none';
            $('boletinForm').style.display = '';
            $('boletinOptions').style.display = '';
            populateCourseSelect();
        } catch(err) {
            $('controlsLoading').innerHTML = `<p style="color:var(--danger);">Error: ${escHtml(err.message)}</p>`;
        } finally {
            _refreshInFlight = false;
        }
    }

    // ── Selectores de curso / alumno ───────────────────────────────────────────
    function populateCourseSelect() {
        const sel = $('courseSelect');
        sel.innerHTML = FIXED_COURSES.map(c => `<option value="${c}">${c}</option>`).join('');
        sel.addEventListener('change', () => populateStudentSelect(sel.value));
        populateStudentSelect(sel.value);
    }

    function getStudentsForCourse(course) {
        // Estrategia: buscar el doc con notas numéricas reales más reciente.
        // Los docs de initializeSubject() tienen grades: "" (vacíos); el Excel importa números.
        // Ordenar por updatedAt desc para que el import más reciente gane.
        const sorted = [...allSubjectData].sort((a, b) =>
            (b.updatedAt || '').localeCompare(a.updatedAt || '')
        );

        // Overrides unificados de todos los docs para este curso
        const overrides = getUnifiedCourseOverrides(course);

        for (const doc of sorted) {
            const recs = doc.records?.[course];
            if (!recs || typeof recs !== 'object') continue;
            const hasRealGrade = Object.values(recs).some(rec =>
                Object.values(rec?.grades || {}).some(v =>
                    v !== '' && v !== null && v !== undefined && !isNaN(parseFloat(v))
                )
            );
            if (!hasRealGrade) continue;
            const enrolled = doc.students?.[course];
            const names = Array.isArray(enrolled) && enrolled.length > 0
                ? enrolled
                : Object.keys(recs);
            const valid = names.filter(s => typeof s === 'string' && s.trim());
            if (valid.length > 0) return applyOverridesToList(valid, overrides);
        }

        // Fallback inicio de año (ninguna materia tiene notas aún):
        // usar el doc con la lista de alumnos más reciente
        for (const doc of sorted) {
            const arr = doc.students?.[course];
            if (Array.isArray(arr) && arr.length > 0) return applyOverridesToList([...arr], overrides);
        }

        return [];
    }

    function populateStudentSelect(course) {
        const students = getStudentsForCourse(course);
        const sel = $('studentSelect');
        sel.innerHTML = '<option value="__all__">— Todos los alumnos del curso —</option>' +
            students.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('');
        $('batchWrap').classList.remove('hidden');
    }

    // ── Refresco de datos (sin resetear selectores) ────────────────────────────
    async function refreshData() {
        if (!institutionId || _refreshInFlight) return;
        _refreshInFlight = true;
        try {
            const fresh = await DB.getAllSubjectDataForInstitution(institutionId);
            fresh.sort((a, b) => (a.subject || '').localeCompare(b.subject || '', 'es'));
            mergeLocalStorageData(fresh);
            allSubjectData = fresh;
        } catch (_) {} finally {
            _refreshInFlight = false;
        }
    }

    // ── Clave localStorage por materia (espejo de storageKey() en script.js) ────
    function subjectStorageKey(subject) {
        const instNorm = String(institutionId || 'local').replace(/[^a-zA-Z0-9]/g, '_');
        const subNorm  = String(subject).toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
            .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
        return `notas_docente_v2_${instNorm}_${subNorm || 'sin_materia'}`;
    }

    // ── Merge localStorage → allSubjectData ───────────────────────────────────
    // Lee la clave por-materia de cada doc y sobreescribe en memoria los datos
    // de Firestore con los locales más recientes, eliminando la race condition
    // entre la escritura sincrónica a localStorage y la asíncrona a Firestore.
    // Si el dato local es más viejo que el remoto (ej: después de restaurar un
    // backup), el remoto gana y no se sobreescribe.
    function _parseLocalTs(s) {
        const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
        if (!m) return 0;
        return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime();
    }
    function mergeLocalStorageData(subjectDataArray) {
        subjectDataArray.forEach((doc, idx) => {
            if (!doc.subject) return;
            try {
                const raw = localStorage.getItem(subjectStorageKey(doc.subject));
                if (!raw) return;
                const local = JSON.parse(raw);
                if (!local || typeof local.records !== 'object' || !local.records) return;
                // Skip if local is genuinely older than the confirmed remote (backup regression guard).
                const localTs  = _parseLocalTs(local.lastSavedAt);
                const remoteTs = doc.updatedAt   ? new Date(doc.updatedAt).getTime()
                               : doc.lastSavedAt ? _parseLocalTs(doc.lastSavedAt) : 0;
                if (localTs > 0 && remoteTs > 0 && localTs < remoteTs) return;
                subjectDataArray[idx] = {
                    ...subjectDataArray[idx],
                    records:          local.records,
                    students:         local.students         || subjectDataArray[idx].students,
                    gradeColumns:     local.gradeColumns     || subjectDataArray[idx].gradeColumns,
                    updatedAt:        local.updatedAt        || subjectDataArray[idx].updatedAt,
                    studentOverrides: local.studentOverrides || subjectDataArray[idx].studentOverrides,
                };
            } catch (_) {}
        });
    }

    // Retorna los removals y additions unificados de todos los docs para un curso dado.
    function getUnifiedCourseOverrides(course) {
        const removalSet  = new Set();
        const additionSeen = new Set();
        const additionList = [];
        allSubjectData.forEach(doc => {
            (doc.studentOverrides?.removals?.[course] || []).forEach(s => removalSet.add(s.toLowerCase()));
            (doc.studentOverrides?.additions?.[course] || []).forEach(s => {
                const key = s.toLowerCase();
                if (!additionSeen.has(key)) { additionSeen.add(key); additionList.push(s); }
            });
        });
        return {
            removalSet,
            additions: additionList.filter(s => !removalSet.has(s.toLowerCase())),
        };
    }

    // Aplica overrides a una lista de alumnos ya filtrada.
    function applyOverridesToList(students, overrides) {
        const result = students.filter(s => !overrides.removalSet.has(s.toLowerCase()));
        const existingKeys = new Set(result.map(s => s.toLowerCase()));
        overrides.additions.forEach(s => {
            if (!existingKeys.has(s.toLowerCase())) { result.push(s); existingKeys.add(s.toLowerCase()); }
        });
        return result.sort();
    }

    // Refrescar automáticamente cuando la pestaña vuelve a estar activa
    // (ej: el usuario cambió notas en otra pestaña y volvió a boletines)
    // Debounced to avoid multiple rapid fetches on minimize/restore in Electron.
    let _visChangeTimer = null;
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            clearTimeout(_visChangeTimer);
            _visChangeTimer = setTimeout(() => refreshData(), 500);
        }
    });
    // Refrescar cuando se llega por el botón "Atrás" del navegador
    window.addEventListener('pageshow', (e) => {
        if (e.persisted) refreshData();
    });
    // Actualizar allSubjectData en memoria cuando otra pestaña guarda notas.
    // Así la próxima vista previa o PDF usa datos frescos sin necesitar navegación.
    window.addEventListener('storage', (e) => {
        if (e.key && e.key.startsWith('notas_docente_v2_') && allSubjectData.length) {
            mergeLocalStorageData(allSubjectData);
        }
    });

    // ── Vista previa ───────────────────────────────────────────────────────────
    $('boletinForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        await refreshData();
        const course  = $('courseSelect').value;
        const student = $('studentSelect').value;
        if (student === '__all__') renderPreviewAll(course);
        else                       renderPreviewOne(course, student);
    });

    function renderPreviewOne(course, studentName) {
        const data = buildBoletinData(course, studentName);
        if (!data.subjects.length) { showToast('Sin notas para este alumno.'); return; }
        showPreview(boletinPageHTML(course, studentName, data));
    }

    function renderPreviewAll(course) {
        const students = getStudentsForCourse(course);
        if (!students.length) { showToast('No hay alumnos en ese curso.'); return; }

        const pages = students.map((name, i) => {
            const data = buildBoletinData(course, name);
            if (!data.subjects.length) return '';
            return boletinPageHTML(course, name, data);
        }).filter(Boolean);
        const html = pages.join(`<div class="bn-page-sep">${pages.length > 1 ? '' : ''}</div>`);

        showPreview(html || '<p style="padding:24px;color:var(--muted);">Sin alumnos con notas en este curso.</p>');
    }

    function scaleBoletinPages() {
        // CSS handles responsive layout — no JS scaling needed
    }

    function showPreview(html) {
        $('previewPlaceholder').classList.add('hidden');
        const wrap = $('previewContainer');
        wrap.classList.remove('hidden');
        wrap.innerHTML = html;
    }

    // ── Descarga PDF ───────────────────────────────────────────────────────────
    $('downloadBtn').addEventListener('click', async () => {
        await refreshData();
        const course  = $('courseSelect').value;
        const student = $('studentSelect').value;
        if (student === '__all__') await downloadAllPDF(course);
        else                       downloadOnePDF(course, student);
    });

    $('downloadAllBtn').addEventListener('click', async () => {
        await refreshData();
        await downloadAllPDF($('courseSelect').value);
    });

    function downloadOnePDF(course, studentName) {
        const data = buildBoletinData(course, studentName);
        if (!data.subjects.length) { showToast('Sin datos para este alumno.'); return; }
        const doc = buildPDF(course, studentName, data);
        const safe = studentName.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
        doc.save(`boletin_${course}_${safe}.pdf`);
        showToast('PDF descargado.');
    }

    async function downloadAllPDF(course) {
        const students = getStudentsForCourse(course).filter(name => buildBoletinData(course, name).subjects.length > 0);

        if (!students.length) { showToast('Sin alumnos con notas en este curso.'); return; }

        const btn          = $('downloadAllBtn');
        const progressWrap = $('batchProgressWrap');
        const progressBar  = $('batchProgressBar');
        const progressText = $('batchProgressText');
        btn.disabled       = true;
        progressWrap.classList.remove('hidden');

        let succeeded = false;
        try {
            let masterDoc = null;
            for (let i = 0; i < students.length; i++) {
                const name = students[i];
                progressText.textContent = `Generando ${i + 1}/${students.length}: ${name}`;
                progressBar.style.width  = `${Math.round(((i + 1) / students.length) * 100)}%`;
                const data = buildBoletinData(course, name);
                if (!masterDoc) masterDoc = buildPDF(course, name, data);
                else            buildPDFPage(masterDoc, course, name, data, true);
                await new Promise(r => setTimeout(r, 0));
            }
            progressText.textContent = 'Descargando...';
            const date = new Date().toLocaleDateString('es-AR').replace(/\//g,'-');
            masterDoc.save(`boletines_${course}_${date}.pdf`);
            succeeded = true;
        } catch (err) {
            console.error('downloadAllPDF error:', err);
            showToast('Error al generar los PDFs. Intentá de nuevo.');
        } finally {
            setTimeout(() => {
                progressWrap.classList.add('hidden');
                progressBar.style.width = '0%';
                btn.disabled = false;
                if (succeeded) showToast(`${students.length} boletines descargados.`);
            }, 500);
        }
    }

    // ── Construcción de datos por alumno ───────────────────────────────────────
    function buildBoletinData(course, studentName) {
        const cfg      = getConfig();
        const subjects = [];
        let studentNumber = null;

        allSubjectData.forEach(doc => {
            const record = doc.records?.[course]?.[studentName];
            if (!record) return;
            if (studentNumber === null && record.number) studentNumber = record.number;

            const cols = doc.gradeColumns?.[course] || GRADE_COLS_DEF;
            const avg  = computeAvg(record.grades, cols);
            const tray = Utils.computeTrajectory(avg, { teaMin: getTeaMin(), tepMin: getTepMin() }) || null;

            subjects.push({
                name:  doc.subject,
                avg,
                tray,
                notes:  record.notes  || '',
                status: record.status || '',
            });
        });

        // Trayectoria general: promedio de los promedios por materia, redondeado igual que el editor
        const validAvgs  = subjects.map(s => s.avg).filter(a => a !== null);
        const overallAvg = validAvgs.length ? Utils.calculateAverage(validAvgs) : null;
        const overallTray = Utils.computeTrajectory(overallAvg, { teaMin: getTeaMin(), tepMin: getTepMin() }) || null;

        return { subjects, overallTray, studentNumber, ...cfg };
    }

    // ── HTML del boletín (preview en pantalla) ─────────────────────────────────
    function boletinPageHTML(course, studentName, data) {
        const { subjects, overallTray, studentNumber, periodo, schoolYear, directorName, directorTitle, instNote } = data;
        const dateStr = new Date().toLocaleDateString('es-AR', {day:'2-digit',month:'long',year:'numeric'});
        const titulo  = [periodo, course.toUpperCase(), 'E.S.', schoolYear].filter(Boolean).join(' — ');

        function trayBadge(t, big = false) {
            if (!t) return '<span style="color:#9ca3af;">—</span>';
            const colors = {
                TEA: 'background:#dcfce7;color:#166534;border:1.5px solid #bbf7d0;',
                TEP: 'background:#fef9c3;color:#854d0e;border:1.5px solid #fde68a;',
                TED: 'background:#fee2e2;color:#991b1b;border:1.5px solid #fecaca;',
            };
            const size = big ? 'font-size:16px;padding:5px 18px;' : 'font-size:13px;padding:3px 12px;';
            return `<span style="${colors[t]||''}${size}border-radius:4px;font-weight:900;display:inline-block;letter-spacing:0.04em;">${t}</span>`;
        }

        const subjectRows = subjects.map(s =>
            `<tr>
                <td class="bn-td-mat">${escHtml(s.name)}</td>
                <td class="bn-td-tray">${trayBadge(s.tray)}</td>
            </tr>`
        ).join('');

        const obsRows = subjects.filter(s => s.notes).map(s =>
            `<p style="margin:0 0 5px;font-size:11px;"><strong>${escHtml(s.name)}:</strong> ${escHtml(s.notes)}</p>`
        ).join('');

        const statusText = subjects.filter(s => s.status).map(s => {
            const l = {libre:'Libre',recursante:'Recursante',promovido:'Promovido'}[s.status] || s.status;
            return `${s.name}: ${l}`;
        }).join(' · ');

        return `
        <div class="bn-page-wrapper"><div class="bn-page">

            <!-- Header institucional -->
            <div class="bn-header">
                ${logoBase64
                    ? `<img class="bn-logo" src="${logoBase64}" alt="Logo">`
                    : `<img class="bn-logo" src="logos/web-app-manifest-192x192.png" alt="Logo" onerror="this.style.display='none'">`
                }
                <div class="bn-header-text">
                    <div class="bn-school-name">${escHtml(institutionName.toUpperCase())}</div>
                    <div class="bn-school-sub">BOLETÍN DE CALIFICACIONES</div>
                </div>
            </div>

            <div class="bn-thick-line"></div>

            <!-- Título del período -->
            <div class="bn-period-title">VALORACIÓN — ${escHtml(titulo)}</div>

            <!-- Datos del alumno -->
            <table class="bn-student-table">
                <tr>
                    <td class="bn-st-label">N° ALUM.</td>
                    <td class="bn-st-num">${studentNumber !== null ? escHtml(String(studentNumber)) : '—'}</td>
                    <td class="bn-st-label">ALUMNO</td>
                    <td class="bn-st-name">${escHtml(studentName)}</td>
                    <td class="bn-st-label">CURSO</td>
                    <td class="bn-st-course">${escHtml(course)}</td>
                </tr>
            </table>

            <!-- Tabla de materias -->
            <table class="bn-grades-table">
                <thead>
                    <tr>
                        <th class="bn-th-mat">ÁREA / MATERIA</th>
                        <th class="bn-th-tray">${escHtml(periodo || '1° PERÍODO')}</th>
                    </tr>
                </thead>
                <tbody>
                    ${subjectRows || '<tr><td colspan="2" style="padding:14px;color:#9ca3af;text-align:center;font-size:12px;">Sin materias registradas</td></tr>'}
                </tbody>
                <tfoot>
                    <tr class="bn-total-row">
                        <td class="bn-td-total-label">TRAYECTORIA GENERAL</td>
                        <td class="bn-td-tray">${trayBadge(overallTray, true)}</td>
                    </tr>
                </tfoot>
            </table>

            ${statusText ? `<p style="margin:10px 14px;font-size:11px;color:#6b7280;">Estado: ${escHtml(statusText)}</p>` : ''}

            ${obsRows ? `
            <div class="bn-obs-block">
                <div class="bn-obs-label">OBSERVACIONES</div>
                ${obsRows}
            </div>` : ''}

            ${instNote ? `<div class="bn-inst-note">${escHtml(instNote)}</div>` : ''}

            <!-- Firmas -->
            <div class="bn-signatures">
                <div class="bn-sig-col">
                    <div class="bn-sig-dots"></div>
                    <div class="bn-sig-caption">FIRMA PADRE/MADRE/TUTOR O ENCARGADO</div>
                </div>
                <div class="bn-sig-col">
                    <div class="bn-sig-dots"></div>
                    <div class="bn-sig-caption">ACLARACIÓN</div>
                </div>
            </div>

            <div class="bn-director-row">
                <div class="bn-director-line">
                    <div class="bn-sig-dots" style="max-width:240px;"></div>
                    <div class="bn-sig-caption">Firma del Director/a</div>
                    ${directorName ? `<div class="bn-director-name">${escHtml(directorName)}</div>` : ''}
                    ${directorTitle ? `<div class="bn-director-title">${escHtml(directorTitle)}</div>` : ''}
                </div>
                <div class="bn-sello-box">SELLO</div>
            </div>

            <!-- Leyenda -->
            <div class="bn-legend">
                <div class="bn-legend-items">
                    <div class="bn-leg-item"><span class="bn-leg-code">TEA</span><span class="bn-leg-desc">Trayectoria Educativa Avanzada</span></div>
                    <div class="bn-leg-item"><span class="bn-leg-code">TEP</span><span class="bn-leg-desc">Trayectoria Educativa en Proceso</span></div>
                    <div class="bn-leg-item"><span class="bn-leg-code">TED</span><span class="bn-leg-desc">Trayectoria Educativa Discontinua</span></div>
                </div>
                <div class="bn-emission">Fecha de emisión: ${escHtml(dateStr)}</div>
            </div>

        </div></div>`;
    }

    // ── Generación PDF ─────────────────────────────────────────────────────────
    function buildPDF(course, studentName, data) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        buildPDFPage(doc, course, studentName, data, false);
        return doc;
    }

    function buildPDFPage(doc, course, studentName, data, addPage) {
        const { subjects, overallTray, studentNumber, periodo, schoolYear, directorName, directorTitle, instNote } = data;
        const PW = 210, PH = 297, ML = 16, MR = 16, W = PW - ML - MR;
        const dateStr = new Date().toLocaleDateString('es-AR', {day:'2-digit',month:'2-digit',year:'numeric'});
        const titulo  = [periodo, course.toUpperCase(), 'E.S.', schoolYear].filter(Boolean).join(' — ');

        if (addPage) doc.addPage();

        // Helper: draw a filled rect
        const fillRect = (x,y,w,h,r,g,b) => {
            doc.setFillColor(r,g,b);
            doc.rect(x,y,w,h,'F');
        };

        // Helper: text
        const txt = (str, x, y, opts) => doc.text(String(str || ''), x, y, opts);

        // ── Header ────────────────────────────────────────────────
        // Logo (20×20mm, centrado verticalmente en la banda de encabezado)
        let textX = ML;
        if (logoBase64) {
            try { doc.addImage(logoBase64, 'PNG', ML, 7, 20, 20); textX = ML + 25; } catch(_) {}
        }

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(14);
        doc.setTextColor(15, 23, 42);
        txt(institutionName.toUpperCase(), textX, 15);

        doc.setFontSize(8.5);
        doc.setTextColor(71, 84, 103);
        doc.setFont('helvetica', 'normal');
        txt('BOLETÍN DE CALIFICACIONES', textX, 22);

        // Thick divider line
        doc.setFillColor(15, 23, 42);
        doc.rect(ML, 28, W, 1, 'F');
        doc.setFillColor(245, 158, 11);
        doc.rect(ML, 29, W, 0.7, 'F');

        let y = 34;

        // ── Título del período ────────────────────────────────────
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(15, 23, 42);
        txt(`VALORACIÓN — ${titulo}`, ML, y);
        y += 7;

        // ── Datos del alumno ──────────────────────────────────────
        doc.setFillColor(248, 250, 252);
        doc.rect(ML, y, W, 10, 'F');
        doc.setDrawColor(203, 213, 225);
        doc.setLineWidth(0.4);
        doc.rect(ML, y, W, 10, 'S');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        doc.setTextColor(100, 116, 139);
        txt('N° ALUM.', ML + 3, y + 4.5);
        txt('ALUMNO', ML + 26, y + 4.5);
        txt('CURSO', PW - MR - 28, y + 4.5);

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(15, 23, 42);
        txt(studentNumber !== null ? String(studentNumber) : '—', ML + 3, y + 8.5);
        txt(studentName, ML + 26, y + 8.5);
        txt(course, PW - MR - 28, y + 8.5);

        y += 14;

        // ── Tabla de materias ─────────────────────────────────────
        const COL_MAT  = W - 34;
        const COL_TRAY = 34;

        // Encabezado de columnas
        doc.setFillColor(15, 23, 42);
        doc.rect(ML, y, W, 7, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        doc.setTextColor(255, 255, 255);
        txt('ÁREA / MATERIA', ML + 3, y + 5);
        txt(periodo || '1° PERÍODO', ML + COL_MAT + COL_TRAY / 2, y + 5, { align: 'center' });
        y += 7;

        // Filas de materias
        subjects.forEach((s, i) => {
            const rowH = 8;
            if (i % 2 === 0) {
                doc.setFillColor(248, 250, 252);
                doc.rect(ML, y, W, rowH, 'F');
            }
            doc.setDrawColor(229, 231, 235);
            doc.setLineWidth(0.25);
            doc.line(ML, y + rowH, ML + W, y + rowH);

            doc.setFont('helvetica', 'bold');
            doc.setFontSize(8.5);
            doc.setTextColor(15, 23, 42);
            txt(s.name, ML + 3, y + 5.5);

            // Trayectoria
            if (s.tray) {
                const trayColors = {
                    TEA: { bg: [220,252,231], fg: [22,101,52]  },
                    TEP: { bg: [254,249,195], fg: [133,77,14]  },
                    TED: { bg: [254,226,226], fg: [153,27,27]  },
                };
                const tc = trayColors[s.tray];
                if (tc) {
                    const bx = ML + COL_MAT + 4, by = y + 1.5, bw = COL_TRAY - 8, bh = 5;
                    doc.setFillColor(...tc.bg);
                    doc.roundedRect(bx, by, bw, bh, 1, 1, 'F');
                    doc.setDrawColor(...tc.fg);
                    doc.setLineWidth(0.3);
                    doc.roundedRect(bx, by, bw, bh, 1, 1, 'S');
                    doc.setTextColor(...tc.fg);
                    doc.setFont('helvetica', 'bold');
                    doc.setFontSize(8);
                    txt(s.tray, ML + COL_MAT + COL_TRAY / 2, y + 5.8, { align: 'center' });
                }
            } else {
                doc.setFont('helvetica', 'normal');
                doc.setFontSize(8);
                doc.setTextColor(156, 163, 175);
                txt('—', ML + COL_MAT + COL_TRAY / 2, y + 5.5, { align: 'center' });
            }

            y += rowH;
        });

        // Fila de trayectoria general
        doc.setFillColor(15, 23, 42);
        doc.rect(ML, y, W, 9, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(253, 230, 138);
        txt('TRAYECTORIA GENERAL', ML + 3, y + 6);

        if (overallTray) {
            const trayColors = { TEA: [134,239,172], TEP: [253,230,138], TED: [252,165,165] };
            doc.setTextColor(...(trayColors[overallTray] || [255,255,255]));
            doc.setFontSize(9);
            txt(overallTray, ML + COL_MAT + COL_TRAY / 2, y + 6.2, { align: 'center' });
        }

        // Border around full table
        doc.setDrawColor(15, 23, 42);
        doc.setLineWidth(0.5);
        doc.rect(ML, y - (subjects.length * 8) - 7, W, (subjects.length * 8) + 7 + 9, 'S');
        // Vertical separator
        doc.line(ML + COL_MAT, y - (subjects.length * 8) - 7, ML + COL_MAT, y + 9);

        y += 13;

        // ── Observaciones ─────────────────────────────────────────
        const withNotes = subjects.filter(s => s.notes);
        if (withNotes.length) {
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(7.5);
            doc.setTextColor(100, 116, 139);
            txt('OBSERVACIONES', ML, y);
            y += 5;
            withNotes.forEach(s => {
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(8);
                doc.setTextColor(15, 23, 42);
                txt(`${s.name}:`, ML, y);
                doc.setFont('helvetica', 'normal');
                doc.setTextColor(71, 84, 103);
                const lines = doc.splitTextToSize(s.notes, W - 32);
                txt(lines, ML + 28, y);
                y += 4.5 * lines.length + 1.5;
            });
            y += 3;
        }

        if (instNote) {
            doc.setFont('helvetica', 'italic');
            doc.setFontSize(8);
            doc.setTextColor(120, 53, 15);
            const lines = doc.splitTextToSize(instNote, W);
            txt(lines, ML, y);
            y += 4.5 * lines.length + 5;
        }

        // ── Firmas ────────────────────────────────────────────────
        const sigY = Math.max(y + 8, PH - 52);

        // Línea dotted para firma
        doc.setDrawColor(156, 163, 175);
        doc.setLineWidth(0.4);
        const halfW = (W - 8) / 2;

        // Firma padre/tutor
        doc.setLineDashPattern([1, 2], 0);
        doc.line(ML, sigY, ML + halfW, sigY);
        doc.setLineDashPattern([], 0);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.setTextColor(100, 116, 139);
        txt('FIRMA PADRE/MADRE/TUTOR O ENCARGADO', ML, sigY + 4);

        // Aclaración
        doc.setLineDashPattern([1, 2], 0);
        doc.line(ML + halfW + 8, sigY, ML + W, sigY);
        doc.setLineDashPattern([], 0);
        txt('ACLARACIÓN', ML + halfW + 8, sigY + 4);

        const dirY = sigY + 14;
        // Firma director
        doc.setLineDashPattern([1, 2], 0);
        doc.line(ML, dirY, ML + halfW, dirY);
        doc.setLineDashPattern([], 0);
        txt('Firma del Director/a', ML, dirY + 4);
        if (directorName) {
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(8);
            doc.setTextColor(15, 23, 42);
            txt(directorName, ML, dirY + 9);
        }
        if (directorTitle) {
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(7);
            doc.setTextColor(100, 116, 139);
            txt(directorTitle.toUpperCase(), ML, dirY + 13.5);
        }

        // Cuadro "SELLO"
        const selX = ML + halfW + 8, selY = dirY - 2, selW = halfW, selH = 18;
        doc.setDrawColor(180, 192, 207);
        doc.setLineWidth(0.5);
        doc.setLineDashPattern([2, 2], 0);
        doc.rect(selX, selY, selW, selH, 'S');
        doc.setLineDashPattern([], 0);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(156, 163, 175);
        txt('SELLO', selX + selW / 2, selY + selH / 2 + 2, { align: 'center' });

        // ── Leyenda ───────────────────────────────────────────────
        const legY = PH - 14;
        doc.setFillColor(248, 250, 252);
        doc.setDrawColor(203, 213, 225);
        doc.setLineWidth(0.4);
        doc.rect(ML, legY, W, 10, 'FD');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7);
        const legItems = [
            ['TEA', 'Trayectoria Educativa Avanzada'],
            ['TEP', 'Trayectoria Educativa en Proceso'],
            ['TED', 'Trayectoria Educativa Discontinua'],
        ];
        const legColW = W / 3;
        legItems.forEach(([code, desc], i) => {
            const lx = ML + legColW * i + 3;
            doc.setTextColor(15, 23, 42);
            doc.setFont('helvetica', 'bold');
            txt(code, lx, legY + 5);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(71, 84, 103);
            txt(desc, lx + 9, legY + 5);
        });

        // Fecha de emisión (abajo derecha)
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6.5);
        doc.setTextColor(156, 163, 175);
        txt(dateStr, PW - MR, legY + 9, { align: 'right' });
    }
