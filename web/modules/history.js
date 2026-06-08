/* web/modules/history.js — registro y visualización del historial de cambios */
(function () {
    "use strict";

    let _historyDisplayRows = null;
    let _historyModalOpen   = false;

    function log(action, course, student, column, oldGrade, newGrade) {
        const now = formatDateTime(new Date());
        const row = [now, action, course, student, column, hasGrade(oldGrade) ? oldGrade : "", hasGrade(newGrade) ? newGrade : ""];
        appState.historyRows.push(row);
        if (!Array.isArray(appState.pendingHistoryRows)) appState.pendingHistoryRows = [];
        appState.pendingHistoryRows.push(row);
        if (firebaseMode && institutionId && appState.subject && typeof DB !== "undefined") {
            DB.logHistory(institutionId, appState.subject, {
                action, course, student, column,
                oldValue: hasGrade(oldGrade) ? oldGrade : null,
                newValue: hasGrade(newGrade) ? newGrade : null,
                userId:   (typeof Auth !== "undefined" && Auth.getUser()) ? Auth.getUser().uid : "",
                userName: currentUserName,
                timestamp: now
            }).catch(() => {});
        }
    }

    function openModal() {
        const modal = document.getElementById("historyModal");
        if (!modal) return;
        const hasLocal  = appState.historyRows.length > 0;
        const canFetch  = firebaseMode && !!institutionId && !!appState.subject && typeof DB !== "undefined";
        if (!hasLocal && !canFetch) { showToast("Aún no hay historial para mostrar."); return; }
        _historyDisplayRows = null;
        _historyModalOpen   = true;
        modal.classList.remove("hidden");
        if (elements.historySearch) elements.historySearch.value = "";
        if (!canFetch) { renderModal(""); return; }
        if (hasLocal) renderModal("");
        else if (elements.historyModalBody) {
            elements.historyModalBody.innerHTML =
                `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:20px;">Cargando historial...</td></tr>`;
        }
        DB.getHistory(institutionId, appState.subject).then(docs => {
            if (!_historyModalOpen) return;
            const fsRows = docs.map(doc => [
                doc.timestamp || "",
                doc.action    || "",
                doc.course    || "",
                doc.student   || "",
                doc.column    || "",
                doc.oldValue  !== null && doc.oldValue  !== undefined ? doc.oldValue  : "",
                doc.newValue  !== null && doc.newValue  !== undefined ? doc.newValue  : "",
            ]);
            const localRows = [...appState.historyRows];
            const localNorm = new Set(localRows.map(r => (r || []).join("|")));
            const merged    = [...localRows, ...fsRows.filter(r => !localNorm.has((r || []).join("|")))];
            merged.sort((a, b) => {
                const ta = parseDateTime(a[0]);
                const tb = parseDateTime(b[0]);
                return ta - tb;
            });
            _historyDisplayRows = merged.reverse();
            renderModal(elements.historySearch?.value || "");
        }).catch(() => { if (_historyModalOpen) renderModal(elements.historySearch?.value || ""); });
    }

    function closeModal() {
        const modal = document.getElementById("historyModal");
        if (modal) modal.classList.add("hidden");
        _historyDisplayRows = null;
        _historyModalOpen   = false;
    }

    function filterModal() {
        renderModal(elements.historySearch?.value || "");
    }

    function renderModal(filter) {
        if (!elements.historyModalBody) return;
        const q    = filter.toLowerCase().trim();
        const rows = _historyDisplayRows ?? [...appState.historyRows].reverse();
        const filtered = q
            ? rows.filter(r => (r || []).some(v => String(v ?? "").toLowerCase().includes(q)))
            : rows;

        if (!filtered.length) {
            elements.historyModalBody.innerHTML =
                `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:20px;">Sin resultados para esa búsqueda.</td></tr>`;
            return;
        }

        const LIMIT = 300;
        const shown = filtered.slice(0, LIMIT);
        const extra = filtered.length > LIMIT
            ? `<tr><td colspan="7" style="text-align:center;color:var(--muted);font-size:12px;padding:10px;">Mostrando ${LIMIT} de ${filtered.length} registros. Usá el buscador para filtrar.</td></tr>`
            : "";

        elements.historyModalBody.innerHTML = shown.map(row => {
            const [fecha, accion, curso, alumno, columna, ant, nuevo] = (row || []).map(v => String(v ?? ""));
            const isStudentOp = accion.includes("Alumno");
            const badgeClass  = isStudentOp ? "action-student" : "action-grade";
            const antDisplay  = ant.trim()   !== "" ? escapeHtml(isStudentOp ? `${ant} alumnos` : ant)   : `<span style="color:var(--muted)">—</span>`;
            const newDisplay  = nuevo.trim() !== "" ? escapeHtml(isStudentOp ? `${nuevo} alumnos` : nuevo) : `<span style="color:var(--muted)">—</span>`;
            return `<tr>
                <td style="white-space:nowrap;color:var(--muted);font-size:12px">${escapeHtml(fecha)}</td>
                <td><span class="history-action-badge ${badgeClass}">${escapeHtml(accion)}</span></td>
                <td>${escapeHtml(curso)}</td>
                <td>${escapeHtml(alumno)}</td>
                <td style="color:var(--muted)">${escapeHtml(columna)}</td>
                <td style="color:var(--muted)">${antDisplay}</td>
                <td>${newDisplay}</td>
            </tr>`;
        }).join("") + extra;
    }

    window.HistoryModule = { log, openModal, closeModal, filterModal, renderModal };
})();
