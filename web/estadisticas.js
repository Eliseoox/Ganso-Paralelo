    'use strict';

    const FIXED_COURSES  = ["1ero","2do","3ero","4to","5to","6to"];
    const GRADE_COLS_DEF = ["Nota 1","Nota 2","Nota 3","Nota 4","Nota 5","Nota 6"];
    const PASS           = 6.5;
    const SESS_KEY       = 'app_institution';

    let institutionId    = '';
    let allSubjectData   = [];
    let _refreshInFlight = false;
    let charts           = {};
    let toastTimer     = 0;

    // ── Paleta de colores institucional ──────────────────────────
    const CHART_COLORS = [
        'rgba(245,158,11,0.82)',   // amber  (brand)
        'rgba(59,130,246,0.82)',   // blue
        'rgba(16,185,129,0.82)',   // green
        'rgba(139,92,246,0.82)',   // purple
        'rgba(249,115,22,0.82)',   // orange
        'rgba(236,72,153,0.82)',   // pink
        'rgba(6,182,212,0.82)',    // cyan
        'rgba(168,85,247,0.82)',   // violet
        'rgba(234,179,8,0.82)',    // yellow
        'rgba(239,68,68,0.82)',    // red
    ];

    const BORDER_COLORS = CHART_COLORS.map(c => c.replace('0.82', '1'));

    const COURSE_COLORS = {
        '1ero': 'rgba(245,158,11,0.80)',
        '2do':  'rgba(59,130,246,0.80)',
        '3ero': 'rgba(16,185,129,0.80)',
        '4to':  'rgba(139,92,246,0.80)',
        '5to':  'rgba(249,115,22,0.80)',
        '6to':  'rgba(236,72,153,0.80)',
    };

    const CHART_DEFAULTS = {
        font: { family: "'Montserrat', Arial, sans-serif", size: 11, weight: '700' },
        color: '#475467',
    };

    // ── Utilidades ────────────────────────────────────────────────
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

    function computeAvg(grades, cols) {
        const vals = cols.map(c => parseFloat(grades?.[c])).filter(v => !isNaN(v) && v >= 0);
        if (!vals.length) return null;
        return vals.reduce((a, b) => a + b, 0) / vals.length;
    }

    function getSessionInst() {
        try { const r = sessionStorage.getItem(SESS_KEY); return r ? JSON.parse(r) : null; } catch(_) { return null; }
    }

    function fmtN(n, decimals = 2) {
        return n !== null && !isNaN(n) ? n.toFixed(decimals) : '—';
    }

    // ── Inicio ────────────────────────────────────────────────────
    Auth.requireAuth(['admin', 'preceptoria', 'profesor']);

    Auth.onReady(async (profile) => {
        if (!profile) return;

        const nameEl = $('headerUserName');
        const roleEl = $('headerRoleTag');
        const pill   = $('userPill');
        if (pill)   pill.style.display = '';
        if (nameEl) nameEl.textContent = Auth.getName();
        if (roleEl) { roleEl.textContent = Auth.getRoleLabel(); roleEl.className = `role-tag ${profile.role}`; }
        if (profile.role === 'admin') { const l = $('adminLink'); if(l) l.style.display = ''; }

        const saved = getSessionInst();
        if (!saved) { window.location.href = 'index.html'; return; }
        institutionId = saved.id;

        // Chart.js global defaults
        Chart.defaults.font.family = CHART_DEFAULTS.font.family;
        Chart.defaults.font.size   = CHART_DEFAULTS.font.size;
        Chart.defaults.color       = CHART_DEFAULTS.color;

        await loadData();
    });

    $('logoutButton').addEventListener('click', () => { window._gansoLogout = true; Auth.signOut(); });
    $('applyFiltersBtn').addEventListener('click', () => refreshStats());

    // ── Carga de datos ────────────────────────────────────────────
    async function loadData() {
        if (_refreshInFlight) return;
        _refreshInFlight = true;
        try {
            allSubjectData = await DB.getAllSubjectDataForInstitution(institutionId);
            allSubjectData.sort((a, b) => (a.subject || '').localeCompare(b.subject || '', 'es'));
            mergeLocalStorageData(allSubjectData);

            if (!allSubjectData.length) {
                $('statsLoading').classList.add('hidden');
                $('statsError').textContent = 'No hay materias inicializadas en este sistema.';
                $('statsError').classList.remove('hidden');
                return;
            }

            // Populate subject filter
            const subjectSel = $('filterSubject');
            allSubjectData.forEach(doc => {
                const opt = document.createElement('option');
                opt.value = doc.subject;
                opt.textContent = doc.subject;
                subjectSel.appendChild(opt);
            });

            $('statsLoading').classList.add('hidden');
            $('statsContent').classList.remove('hidden');

            refreshStats();
        } catch(err) {
            $('statsLoading').classList.add('hidden');
            $('statsError').textContent = `Error al cargar: ${err.message}`;
            $('statsError').classList.remove('hidden');
        } finally {
            _refreshInFlight = false;
        }
    }

    // ── Refresco de datos sin resetear selectores ─────────────────
    async function refreshData() {
        if (!institutionId || _refreshInFlight) return;
        _refreshInFlight = true;
        try {
            const fresh = await DB.getAllSubjectDataForInstitution(institutionId);
            fresh.sort((a, b) => (a.subject || '').localeCompare(b.subject || '', 'es'));
            mergeLocalStorageData(fresh);
            allSubjectData = fresh;
            refreshStats();
        } catch (_) {}
        finally { _refreshInFlight = false; }
    }

    // ── Clave localStorage por materia (espejo de storageKey() en script.js) ────
    function subjectStorageKey(subject) {
        const instNorm = String(institutionId || 'local').replace(/[^a-zA-Z0-9]/g, '_');
        const subNorm  = String(subject).toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
            .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
        return `notas_docente_v2_${instNorm}_${subNorm || 'sin_materia'}`;
    }

    // ── Merge localStorage → allSubjectData ──────────────────────
    // Mismo puente que boletines.html: usa el snapshot local más reciente
    // para sobreescribir el doc de Firestore en memoria, eliminando la race
    // condition entre la escritura síncrona a localStorage y la asíncrona.
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
                    records:      local.records,
                    students:     local.students      || subjectDataArray[idx].students,
                    gradeColumns: local.gradeColumns  || subjectDataArray[idx].gradeColumns,
                    updatedAt:    local.updatedAt     || subjectDataArray[idx].updatedAt,
                };
            } catch (_) {}
        });
    }

    // ── Cómputo de estadísticas ───────────────────────────────────
    function computeStats(filterCourse, filterSubject) {
        const subjectStats = {};     // { subject: {total,passed,failed,avgSum} }
        const courseStats  = {};     // { course:  {total,passed,failed,avgSum,studentsSet} }
        const studentMap   = {};     // { `${course}:${name}`: {course,name,avgSum,count,subjects[]} }
        let gTotal = 0, gPassed = 0, gAvgSum = 0;

        allSubjectData.forEach(doc => {
            const subjectName = doc.subject;
            if (filterSubject !== 'all' && filterSubject !== subjectName) return;

            if (!subjectStats[subjectName]) {
                subjectStats[subjectName] = { total: 0, passed: 0, failed: 0, avgSum: 0 };
            }

            FIXED_COURSES.forEach(course => {
                if (filterCourse !== 'all' && filterCourse !== course) return;

                const students = doc.students?.[course] || [];
                const records  = doc.records?.[course]  || {};
                const cols     = doc.gradeColumns?.[course] || GRADE_COLS_DEF;

                if (!courseStats[course]) {
                    courseStats[course] = { total: 0, passed: 0, failed: 0, avgSum: 0, studentsSet: new Set() };
                }

                students.forEach(studentName => {
                    const record = records[studentName];
                    if (!record) return;
                    const avg = computeAvg(record.grades, cols);
                    if (avg === null) return;

                    // Subject stats
                    subjectStats[subjectName].total++;
                    subjectStats[subjectName].avgSum += avg;
                    if (avg >= PASS) subjectStats[subjectName].passed++;
                    else             subjectStats[subjectName].failed++;

                    // Course stats
                    courseStats[course].total++;
                    courseStats[course].avgSum += avg;
                    courseStats[course].studentsSet.add(studentName);
                    if (avg >= PASS) courseStats[course].passed++;
                    else             courseStats[course].failed++;

                    // Student map
                    const key = `${course}:${studentName}`;
                    if (!studentMap[key]) {
                        studentMap[key] = { course, name: studentName, avgSum: 0, count: 0, subjects: [] };
                    }
                    studentMap[key].avgSum += avg;
                    studentMap[key].count++;
                    studentMap[key].subjects.push(subjectName);

                    // Global
                    gTotal++;
                    gAvgSum += avg;
                    if (avg >= PASS) gPassed++;
                });
            });
        });

        // Finalize averages
        Object.values(subjectStats).forEach(s => { s.avg = s.total ? s.avgSum / s.total : null; });
        Object.values(courseStats).forEach(s => {
            s.avg = s.total ? s.avgSum / s.total : null;
            s.uniqueStudents = s.studentsSet.size;
        });

        const students = Object.values(studentMap)
            .map(s => ({ ...s, avg: s.count ? s.avgSum / s.count : null }))
            .filter(s => s.avg !== null)
            .sort((a, b) => b.avg - a.avg);

        const uniqueStudentCount = new Set(
            Object.values(studentMap).map(s => `${s.course}:${s.name}`)
        ).size;

        return {
            subjectStats, courseStats, students,
            global: {
                total:    gTotal,
                passed:   gPassed,
                failed:   gTotal - gPassed,
                avg:      gTotal ? gAvgSum / gTotal : null,
                passRate: gTotal ? (gPassed / gTotal * 100) : null,
                uniqueStudents: uniqueStudentCount,
            },
        };
    }

    // ── Refresco completo ─────────────────────────────────────────
    function refreshStats() {
        const filterCourse  = $('filterCourse').value;
        const filterSubject = $('filterSubject').value;
        const stats = computeStats(filterCourse, filterSubject);

        renderKPIs(stats);
        renderChartCourse(stats);
        renderChartPassFail(stats);
        renderChartSubject(stats);
        renderChartFailRate(stats);
        renderTopStudents(stats);
        renderCourseDetail(stats);
        renderSubjectDetail(stats);
    }

    // ── KPI Cards ─────────────────────────────────────────────────
    function renderKPIs(stats) {
        const { global } = stats;

        $('kpiAvg').textContent      = global.avg !== null ? fmtN(global.avg) : '—';
        $('kpiAvgSub').textContent   = `${global.total} registros evaluados`;

        $('kpiStudents').textContent   = global.uniqueStudents || '—';
        $('kpiStudentsSub').textContent = `en el sistema actual`;

        const passRate = global.passRate;
        $('kpiPass').textContent    = passRate !== null ? `${Math.round(passRate)}%` : '—';
        $('kpiPassSub').textContent  = `${global.passed} registros aprobados`;

        const failRate = passRate !== null ? 100 - passRate : null;
        $('kpiFail').textContent    = failRate !== null ? `${Math.round(failRate)}%` : '—';
        $('kpiFailSub').textContent  = `${global.failed} registros desaprobados`;
    }

    // ── Gráfico: promedio por curso ───────────────────────────────
    function renderChartCourse(stats) {
        const labels = FIXED_COURSES.filter(c => stats.courseStats[c]?.total > 0);
        const avgs   = labels.map(c => stats.courseStats[c]?.avg?.toFixed(2) || 0);
        const colors = labels.map(c => COURSE_COLORS[c] || CHART_COLORS[0]);

        const ctx = $('chartCourse').getContext('2d');
        if (charts.course) charts.course.destroy();

        charts.course = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Promedio',
                    data: avgs,
                    backgroundColor: colors,
                    borderColor: colors.map(c => c.replace('0.80','1')),
                    borderWidth: 1.5,
                    borderRadius: 6,
                    borderSkipped: false,
                }]
            },
            options: chartBarOptions('Promedio', 10, true),
        });
    }

    // ── Gráfico: aprobados vs desaprobados ────────────────────────
    function renderChartPassFail(stats) {
        const { global } = stats;
        const ctx = $('chartPassFail').getContext('2d');
        if (charts.passFail) charts.passFail.destroy();

        if (!global.total) {
            charts.passFail = null;
            return;
        }

        charts.passFail = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Aprobados', 'Desaprobados'],
                datasets: [{
                    data: [global.passed, global.failed],
                    backgroundColor: ['rgba(21,128,61,0.85)', 'rgba(180,35,24,0.85)'],
                    borderColor:     ['#15803d', '#b42318'],
                    borderWidth: 2,
                    hoverOffset: 8,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '62%',
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            boxWidth: 14,
                            padding: 16,
                            font: { weight: '700', size: 12 }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => {
                                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                                const pct   = total ? ((ctx.raw / total) * 100).toFixed(1) : 0;
                                return ` ${ctx.raw} (${pct}%)`;
                            }
                        }
                    }
                }
            }
        });
    }

    // ── Gráfico: promedio por materia ─────────────────────────────
    function renderChartSubject(stats) {
        const entries = Object.entries(stats.subjectStats)
            .filter(([, s]) => s.avg !== null)
            .sort((a, b) => b[1].avg - a[1].avg);

        const labels = entries.map(([name]) => name);
        const avgs   = entries.map(([, s]) => s.avg.toFixed(2));
        const colors = labels.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]);

        const ctx = $('chartSubject').getContext('2d');
        if (charts.subject) charts.subject.destroy();

        charts.subject = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Promedio',
                    data: avgs,
                    backgroundColor: colors,
                    borderColor: colors.map(c => c.replace('0.82','1')),
                    borderWidth: 1.5,
                    borderRadius: 6,
                    borderSkipped: false,
                }]
            },
            options: {
                ...chartBarOptions('Promedio', 10, false),
                indexAxis: labels.length > 5 ? 'y' : 'x',
            },
        });
    }

    // ── Gráfico: materias con más desaprobados ────────────────────
    function renderChartFailRate(stats) {
        const entries = Object.entries(stats.subjectStats)
            .filter(([, s]) => s.total > 0)
            .map(([name, s]) => ({ name, failRate: (s.failed / s.total) * 100 }))
            .sort((a, b) => b.failRate - a.failRate)
            .slice(0, 10);

        const labels = entries.map(e => e.name);
        const rates  = entries.map(e => e.failRate.toFixed(1));

        const ctx = $('chartFailRate').getContext('2d');
        if (charts.failRate) charts.failRate.destroy();

        charts.failRate = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: '% Desaprobados',
                    data: rates,
                    backgroundColor: rates.map(r => {
                        const v = parseFloat(r);
                        if (v >= 40) return 'rgba(180,35,24,0.82)';
                        if (v >= 20) return 'rgba(249,115,22,0.82)';
                        return 'rgba(245,158,11,0.82)';
                    }),
                    borderWidth: 1.5,
                    borderRadius: 6,
                    borderSkipped: false,
                }]
            },
            options: {
                ...chartBarOptions('%', 100, false),
                indexAxis: labels.length > 5 ? 'y' : 'x',
            },
        });
    }

    // ── Opciones de gráfico de barras ─────────────────────────────
    function chartBarOptions(yLabel, maxY, showThreshold) {
        return {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => ` ${ctx.formattedValue}`
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: maxY,
                    grid: { color: 'rgba(0,0,0,0.06)' },
                    ticks: { font: { size: 10, weight: '700' } },
                },
                x: {
                    grid: { display: false },
                    ticks: { font: { size: 10, weight: '700' }, maxRotation: 30 },
                }
            },
            animation: { duration: 400, easing: 'easeOutQuart' },
        };
    }

    // ── Tabla: mejores promedios ──────────────────────────────────
    function renderTopStudents(stats) {
        const top   = stats.students.slice(0, 15);
        const tbody = $('topStudentsBody');

        if (!top.length) {
            tbody.innerHTML = `<tr><td colspan="5" class="stats-empty">Sin datos suficientes</td></tr>`;
            return;
        }

        tbody.innerHTML = top.map((s, i) => {
            const rank = i + 1;
            const rankCls = rank <= 3 ? `rank-${rank}` : '';
            const cls     = s.avg >= PASS ? 'grade-pass' : s.avg >= 4 ? 'grade-warn' : 'grade-fail';
            return `<tr>
                <td><span class="rank-badge ${rankCls}">${rank}</span></td>
                <td style="font-weight:700;max-width:160px;overflow:hidden;text-overflow:ellipsis;">${escHtml(s.name)}</td>
                <td>${escHtml(s.course)}</td>
                <td class="${cls}" style="font-weight:800;">${fmtN(s.avg)}</td>
                <td style="color:var(--muted);">${s.count}</td>
            </tr>`;
        }).join('');
    }

    // ── Tabla: detalle por curso ──────────────────────────────────
    function renderCourseDetail(stats) {
        const tbody = $('courseDetailBody');
        const rows  = FIXED_COURSES.filter(c => stats.courseStats[c]?.total > 0);

        if (!rows.length) {
            tbody.innerHTML = `<tr><td colspan="4" class="stats-empty">Sin datos</td></tr>`;
            return;
        }

        tbody.innerHTML = rows.map(course => {
            const s = stats.courseStats[course];
            const pct    = s.total ? Math.round((s.passed / s.total) * 100) : 0;
            const avgCls = s.avg !== null ? (s.avg >= PASS ? 'pct-pass' : s.avg >= 4 ? '' : 'pct-fail') : '';
            return `<tr>
                <td style="font-weight:800;">${escHtml(course)}</td>
                <td>${s.uniqueStudents}</td>
                <td class="${avgCls}" style="font-weight:800;">${fmtN(s.avg)}</td>
                <td>
                    <span class="pct-pass">${pct}%</span>
                    <div class="stats-pass-bar" style="max-width:80px;">
                        <div class="stats-pass-bar-green" style="width:${pct}%"></div>
                        <div class="stats-pass-bar-red"   style="width:${100 - pct}%"></div>
                    </div>
                </td>
            </tr>`;
        }).join('');
    }

    // ── Tabla: detalle por materia ────────────────────────────────
    function renderSubjectDetail(stats) {
        const tbody   = $('subjectDetailBody');
        const entries = Object.entries(stats.subjectStats)
            .filter(([, s]) => s.total > 0)
            .sort((a, b) => b[1].avg - a[1].avg);

        if (!entries.length) {
            tbody.innerHTML = `<tr><td colspan="6" class="stats-empty">Sin datos</td></tr>`;
            return;
        }

        tbody.innerHTML = entries.map(([name, s]) => {
            const pct    = s.total ? Math.round((s.passed / s.total) * 100) : 0;
            const avgCls = s.avg !== null ? (s.avg >= PASS ? 'pct-pass' : s.avg >= 4 ? '' : 'pct-fail') : '';
            return `<tr>
                <td style="font-weight:700;">${escHtml(name)}</td>
                <td style="color:var(--muted);">${s.total}</td>
                <td class="${avgCls}" style="font-weight:800;">${fmtN(s.avg)}</td>
                <td class="pct-pass" style="font-weight:700;">${s.passed}</td>
                <td class="pct-fail" style="font-weight:700;">${s.failed}</td>
                <td>
                    <span class="pct-pass">${pct}%</span>
                    <div class="stats-pass-bar" style="max-width:80px;">
                        <div class="stats-pass-bar-green" style="width:${pct}%"></div>
                        <div class="stats-pass-bar-red"   style="width:${100 - pct}%"></div>
                    </div>
                </td>
            </tr>`;
        }).join('');
    }

    // ── Auto-refresco al volver a la pestaña ──────────────────────
    // Cuando el usuario edita notas en index.html y vuelve a estadísticas,
    // los datos se actualizan automáticamente sin necesitar recarga manual.
    // Debounced to avoid multiple rapid fetches on minimize/restore in Electron.
    let _visChangeTimer = null;
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && institutionId) {
            clearTimeout(_visChangeTimer);
            _visChangeTimer = setTimeout(() => refreshData(), 500);
        }
    });
    window.addEventListener('pageshow', (e) => {
        if (e.persisted && institutionId) refreshData();
    });
    window.addEventListener('storage', (e) => {
        if (e.key && e.key.startsWith('notas_docente_v2_') && allSubjectData.length) {
            mergeLocalStorageData(allSubjectData);
            refreshStats();
        }
    });
