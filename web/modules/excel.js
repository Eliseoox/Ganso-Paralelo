/* web/modules/excel.js — lectura, escritura y descarga de archivos Excel y JSON */
(function () {
    "use strict";

    // ── Helpers de nombre de hoja ─────────────────────────────────────────────

    function isSystemSheet(name) {
        return [SUMMARY_SHEET, HISTORY_SHEET].some(n => n.toLocaleLowerCase() === String(name).toLocaleLowerCase());
    }

    function isReservedSheetName(name) { return isSystemSheet(name); }

    function quoteSheetName(name) { return `'${String(name).replace(/'/g, "''")}'`; }

    function uniqueSheetName(rawName, usedNames) {
        const base = String(rawName || "Curso").replace(/[:\\/?*[\]]/g, "-").trim().slice(0, 31) || "Curso";
        let name   = base;
        let idx    = 2;
        while (usedNames.has(name.toLocaleLowerCase()) || usedNames.has(name)) {
            const suffix = ` ${idx}`;
            name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
            idx++;
        }
        usedNames.add(name);
        usedNames.add(name.toLocaleLowerCase());
        return name;
    }

    // ── Helpers de nombre de archivo y descarga ───────────────────────────────

    function buildExportFileName(extension, prefix) {
        const inst    = sanitizeFilePart(institutionName || institutionId || "");
        const subject = sanitizeFilePart(appState.subject || "materia");
        const year    = String(new Date().getFullYear());
        const parts   = [inst, subject, year].filter(Boolean);
        const name    = parts.join("_");
        return prefix ? `${prefix}_${name}.${extension}` : `${name}.${extension}`;
    }

    function sanitizeFilePart(value) {
        return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
            .replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 42) || "";
    }

    function downloadBlob(blob, fileName) {
        const url  = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url; link.download = fileName;
        document.body.appendChild(link);
        link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // ── Helpers de lectura de celdas ──────────────────────────────────────────

    function getCellValue(ws, row, col) {
        if (col === undefined || col === null) return "";
        const cell = ws[XLSX.utils.encode_cell({ r: row, c: col })];
        return cell ? cell.v : "";
    }

    function getCellText(ws, row, col) {
        if (col === undefined || col === null) return "";
        const cell = ws[XLSX.utils.encode_cell({ r: row, c: col })];
        if (!cell) return "";
        return String(cell.w ?? cell.v ?? "");
    }

    // ── Normalización de encabezados ──────────────────────────────────────────

    function normalizeHeader(value) {
        return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
            .trim().toLocaleLowerCase().replace(/\s+/g, " ");
    }

    function canonicalHeader(value) {
        const key = normalizeHeader(value);
        if (!key) return "";
        const aliases = {
            n: "N", nro: "N", numero: "N", no: "N",
            alumno: "Alumno", alumna: "Alumno", estudiante: "Alumno", nombre: "Alumno", "nombre y apellido": "Alumno",
            promedio: "Promedio",
            "ultima actualizacion": "Ultima actualizacion", actualizacion: "Ultima actualizacion",
            nota: "Nota 1"
        };
        if (aliases[key]) return aliases[key];
        const gradeMatch = key.match(/^nota\s*(\d+)$/);
        if (gradeMatch) return `Nota ${gradeMatch[1]}`;
        return "";
    }

    // ── Parseo de hojas ───────────────────────────────────────────────────────

    function findHeaderRow(worksheet) {
        if (!worksheet || !worksheet["!ref"]) return null;
        const range    = XLSX.utils.decode_range(worksheet["!ref"]);
        const firstRow = Math.max(range.s.r, 0);
        const lastRow  = Math.min(range.e.r, firstRow + 7);
        let best = null;
        for (let row = firstRow; row <= lastRow; row++) {
            const columns = {};
            for (let col = range.s.c; col <= range.e.c; col++) {
                const canonical = canonicalHeader(getCellText(worksheet, row, col));
                if (canonical && columns[canonical] === undefined) columns[canonical] = col;
            }
            const gradeCount = Object.keys(columns).filter(k => /^Nota \d+$/.test(k)).length;
            const score = (columns.Alumno !== undefined ? 5 : 0) + gradeCount;
            if (!best || score > best.score) best = { row, columns, score };
        }
        return best && best.score > 0 ? best : null;
    }

    function findHistoryHeaderRow(worksheet) {
        if (!worksheet || !worksheet["!ref"]) return null;
        const range   = XLSX.utils.decode_range(worksheet["!ref"]);
        const columns = {};
        for (let col = range.s.c; col <= range.e.c; col++) {
            const text   = normalizeHeader(getCellText(worksheet, range.s.r, col));
            const header = HISTORY_HEADERS.find(h => normalizeHeader(h) === text);
            if (header) columns[header] = col;
        }
        return Object.keys(columns).length ? { row: range.s.r, columns } : null;
    }

    function readCourseRows(worksheet, sheetInfo, warnings) {
        if (!worksheet || !worksheet["!ref"]) return [];
        const range = XLSX.utils.decode_range(worksheet["!ref"]);
        const rows  = [];
        const knownNonGrade = new Set(["Alumno", "N", "Promedio", "Ultima actualizacion"]);
        let sheetGradeCols  = Object.keys(sheetInfo.columns)
            .filter(k => /^Nota \d+$/.test(k))
            .sort((a, b) => parseInt(a.replace("Nota ", "")) - parseInt(b.replace("Nota ", "")));

        if (!sheetGradeCols.length) {
            let noteIdx = 1;
            for (let ci = range.s.c; ci <= range.e.c; ci++) {
                const hdr = normalizeHeader(getCellText(worksheet, sheetInfo.headerRow, ci));
                if (!hdr) continue;
                const canonical = canonicalHeader(getCellText(worksheet, sheetInfo.headerRow, ci));
                if (canonical && knownNonGrade.has(canonical)) continue;
                if (canonical && /^Nota \d+$/.test(canonical)) continue;
                if (/nota/.test(hdr) || /^\d+$/.test(hdr)) {
                    const key = `Nota ${noteIdx++}`;
                    sheetGradeCols.push(key);
                    sheetInfo.columns[key] = ci;
                }
            }
        }

        const effectiveCols = sheetGradeCols.length ? sheetGradeCols : [...GRADE_COLUMNS];

        for (let ri = sheetInfo.headerRow + 1; ri <= range.e.r; ri++) {
            const student = getCellText(worksheet, ri, sheetInfo.columns.Alumno).trim();
            if (!student) continue;
            const grades = {};
            effectiveCols.forEach(col => {
                const ci  = sheetInfo.columns[col];
                if (ci === undefined || ci === null) { grades[col] = ""; return; }
                const raw = getCellValue(worksheet, ri, ci);
                const g   = normalizeGrade(raw);
                if (raw !== "" && raw !== null && raw !== undefined && g === "") {
                    pushLimited(warnings, `${sheetInfo.name}: nota inválida en fila ${ri + 1}, ${col}; se dejó vacía.`);
                }
                grades[col] = g;
            });
            rows.push({
                number:    sheetInfo.columns.N === undefined ? rows.length + 1 : getCellValue(worksheet, ri, sheetInfo.columns.N),
                student, grades, gradeCols: effectiveCols,
                updatedAt: sheetInfo.columns["Ultima actualizacion"] === undefined
                    ? "" : getCellText(worksheet, ri, sheetInfo.columns["Ultima actualizacion"])
            });
        }
        return rows;
    }

    function readHistoryRows(worksheet) {
        if (!worksheet || !worksheet["!ref"]) return [];
        const headerInfo = findHistoryHeaderRow(worksheet);
        if (!headerInfo) return [];
        const range = XLSX.utils.decode_range(worksheet["!ref"]);
        const rows  = [];
        for (let ri = headerInfo.row + 1; ri <= range.e.r; ri++) {
            const row = HISTORY_HEADERS.map(h => {
                const col = headerInfo.columns[h];
                return col === undefined ? "" : getCellValue(worksheet, ri, col) ?? "";
            });
            if (row.some(v => String(v).trim() !== "")) rows.push(row);
        }
        return rows;
    }

    // ── Validación ────────────────────────────────────────────────────────────

    function validateWorkbook(workbook) {
        const result = { errors: [], warnings: [], sheets: [] };
        const courseSheets = (workbook.SheetNames || []).filter(n => !isSystemSheet(n));
        if (!courseSheets.length) {
            result.errors.push("No se encontraron hojas de curso. Cada curso debe estar en una hoja propia.");
            return result;
        }
        courseSheets.forEach(sheetName => {
            const worksheet  = workbook.Sheets[sheetName];
            const headerInfo = findHeaderRow(worksheet);
            if (!headerInfo) { result.errors.push(`${sheetName}: no se encontró fila de encabezados.`); return; }
            if (headerInfo.columns.Alumno === undefined) {
                result.errors.push(`${sheetName}: no se encontró la columna "Alumno".`);
                return;
            }
            const gradeCols = Object.keys(headerInfo.columns).filter(k => /^Nota \d+$/.test(k));
            if (!gradeCols.length) result.warnings.push(`${sheetName}: no se encontraron columnas de notas; se usarán las columnas por defecto.`);
            const missingOptional = OPTIONAL_IMPORT_HEADERS.filter(h => headerInfo.columns[h] === undefined);
            if (missingOptional.length) result.warnings.push(`${sheetName}: se completarán al exportar: ${missingOptional.join(", ")}.`);
            result.sheets.push({ name: sheetName, headerRow: headerInfo.row, columns: headerInfo.columns });
        });
        return result;
    }

    function readWorkbookState(workbook, fileName, subject, validation) {
        const nextState = createInitialState(subject);
        const warnings  = [...validation.warnings];
        nextState.fileName = fileName || "notas_cursos.xlsx";
        nextState.source   = "excel";

        validation.sheets
            .filter(si => !validation.errors.some(e => e.startsWith(`${si.name}:`)))
            .forEach(sheetInfo => {
                const fixedCourse = mapToFixedCourse(sheetInfo.name);
                if (!fixedCourse) {
                    pushLimited(warnings, `Hoja "${sheetInfo.name}": no corresponde a ningún curso fijo; se omite.`);
                    return;
                }
                if ((nextState.students[fixedCourse] || []).length > 0) {
                    pushLimited(warnings, `Hoja "${sheetInfo.name}": ya se cargó el curso "${fixedCourse}"; se omite.`);
                    return;
                }
                const rows     = readCourseRows(workbook.Sheets[sheetInfo.name], sheetInfo, warnings);
                const students = [];
                const records  = {};
                const courseGradeColsSet = new Set();
                const seen     = new Set();
                rows.forEach(row => {
                    const key = row.student.toLocaleLowerCase();
                    if (seen.has(key)) { pushLimited(warnings, `${sheetInfo.name}: alumno duplicado omitido: ${row.student}.`); return; }
                    seen.add(key);
                    students.push(row.student);
                    if (row.gradeCols) row.gradeCols.forEach(c => courseGradeColsSet.add(c));
                    records[row.student] = {
                        number:    row.number || students.length,
                        grades:    row.grades,
                        average:   calculateAverage(Object.values(row.grades)),
                        updatedAt: row.updatedAt || ""
                    };
                });
                if (!students.length) pushLimited(warnings, `${sheetInfo.name}: no se encontraron alumnos.`);
                nextState.students[fixedCourse] = students;
                nextState.records[fixedCourse]  = records;
                const courseGradeCols = courseGradeColsSet.size
                    ? [...courseGradeColsSet].sort((a, b) => parseInt(a.replace("Nota ", "")) - parseInt(b.replace("Nota ", "")))
                    : [...GRADE_COLUMNS];
                nextState.gradeColumns[fixedCourse] = courseGradeCols;
            });

        nextState.historyRows = readHistoryRows(workbook.Sheets[HISTORY_SHEET]);
        nextState.validation  = { errors: [], warnings };
        normalizeState(nextState);
        return nextState;
    }

    // ── Importar Excel ────────────────────────────────────────────────────────

    async function importFromInput(event) {
        const [file] = event.target.files;
        event.target.value = "";
        if (!file) return;

        if ((hasData() || snapshotHasData(savedSnapshot)) &&
            !await confirmDialog("Cargar este Excel reemplaza los datos locales actuales.", { confirmText: "Sí, cargar", cancelText: "Cancelar" })) return;

        try {
            setSyncStatus("Validando Excel...", "pending");
            const buffer   = await file.arrayBuffer();
            const workbook = XLSX.read(buffer, { type: "array", cellDates: false });
            const validation = validateWorkbook(workbook);
            renderValidationMessages(validation);

            if (validation.errors.length) {
                setSyncStatus("Excel con errores", "error");
                updateNotice("error", "El Excel no tiene la estructura esperada.", validation.errors[0]);
                return;
            }

            const subject = appState.subject || elements.subjectInput?.value.trim() || "Sin materia";
            SyncModule.cancel();
            createPreOpBackup("excel_import");
            const prevOverrides = cloneData(appState.studentOverrides   || { additions: {}, removals: {} });
            const prevPending   = cloneData(appState.pendingHistoryRows || []);
            appState      = readWorkbookState(workbook, file.name, subject, validation);
            applyStudentOverrides(appState, prevOverrides);
            appState.historyRows        = mergeHistoryRows(prevPending, appState.historyRows);
            appState.pendingHistoryRows = cloneData(prevPending);
            selectedCourse = appState.courses[0] || "";
            activeStep    = 3;
            hasReviewed   = false;
            saveLocalState(false);
            hydrateControls(); renderAll(); renderSavedSession(); renderFlow(); updateDisabledState();
            setSyncStatus("Guardado local", "online");
            updateNotice("ready", `Archivo cargado: ${file.name}`, "Podés continuar con la carga de notas.");
            showToast("Excel cargado y validado.");
        } catch (error) {
            console.error(error);
            setSyncStatus("Error al abrir", "error");
            updateNotice("error", "No se pudo leer el Excel.", getErrorMessage(error, "Revisá el archivo e intentá de nuevo."));
            showToast("No se pudo leer el Excel.");
        }
    }

    // ── Construir workbook desde el estado ────────────────────────────────────

    function buildWorkbook() {
        normalizeState(appState);
        const workbook = XLSX.utils.book_new();
        workbook.Props = {
            Title:       `Notas — ${appState.subject || "Materia"}`,
            Subject:     appState.subject || "",
            Author:      institutionName || "Ganso-Paralelo",
            CreatedDate: new Date()
        };
        const usedSheetNames = new Set([
            SUMMARY_SHEET, HISTORY_SHEET,
            SUMMARY_SHEET.toLocaleLowerCase(), HISTORY_SHEET.toLocaleLowerCase()
        ]);
        const sheetNameByCourse = {};
        appState.courses.forEach(course => {
            sheetNameByCourse[course] = uniqueSheetName(course, usedSheetNames);
        });
        XLSX.utils.book_append_sheet(workbook, buildSummaryWorksheet(sheetNameByCourse), SUMMARY_SHEET);
        appState.courses.forEach(course => {
            XLSX.utils.book_append_sheet(workbook, buildCourseWorksheet(course), sheetNameByCourse[course]);
        });
        XLSX.utils.book_append_sheet(workbook, buildHistoryWorksheet(), HISTORY_SHEET);
        workbook.Workbook       = workbook.Workbook || {};
        workbook.Workbook.CalcPr = { fullCalcOnLoad: true };
        return workbook;
    }

    function buildCourseWorksheet(course) {
        const cols     = getCourseColumns(course);
        const headers  = ["N", "Alumno", ...cols.map(col => getColLabel(col, course)), "Promedio", "Ultima actualizacion"];
        const rows     = [headers];
        const students = appState.students[course] || [];

        students.forEach((student, index) => {
            const record = getRecord(course, student);
            const grades = cols.map(col => record.grades[col] === "" ? "" : record.grades[col]);
            rows.push([index + 1, student, ...grades, "", record.updatedAt || ""]);
        });

        const worksheet   = XLSX.utils.aoa_to_sheet(rows);
        const promColIdx  = 2 + cols.length;
        const firstGrCol  = XLSX.utils.encode_col(2);
        const lastGrCol   = XLSX.utils.encode_col(1 + cols.length);
        const lastAllCol  = XLSX.utils.encode_col(2 + cols.length + 1);

        students.forEach((student, index) => {
            const excelRow = index + 2;
            const record   = getRecord(course, student);
            const average  = calculateAverage(cols.map(col => record.grades[col]));
            const address  = XLSX.utils.encode_cell({ r: excelRow - 1, c: promColIdx });
            worksheet[address] = {
                t: average === null ? "s" : "n",
                f: `IFERROR(AVERAGE(${firstGrCol}${excelRow}:${lastGrCol}${excelRow}),"")`,
                v: average === null ? "" : average,
                z: "0.0"
            };
        });

        worksheet["!cols"]       = [{ wch: 6 }, { wch: 32 }, ...cols.map(() => ({ wch: 10 })), { wch: 12 }, { wch: 22 }];
        worksheet["!freeze"]     = { xSplit: 2, ySplit: 1, topLeftCell: "C2", activePane: "bottomRight", state: "frozen" };
        worksheet["!autofilter"] = { ref: `A1:${lastAllCol}${Math.max(rows.length, 1)}` };
        worksheet["!margins"]    = { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 };
        return worksheet;
    }

    function buildSummaryWorksheet(sheetNameByCourse) {
        const inst = institutionName || institutionId || "";
        const rows = [
            ["Institución", inst || "—"],
            ["Materia",     appState.subject || ""],
            ["Generado",    formatDateTime(new Date())],
            [],
            ["Curso", "Alumnos", "Aprobados", "Desaprobados", "Notas cargadas", "Promedio", "Última actualización"]
        ];

        appState.courses.forEach(course => {
            const cs = getCourseStats(course);
            rows.push([course, cs.students, cs.passed, cs.failed, "", "", cs.lastUpdated || ""]);
        });

        const worksheet = XLSX.utils.aoa_to_sheet(rows);
        worksheet["!cols"] = [{ wch: 18 }, { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 22 }];
        appState.courses.forEach((course, index) => {
            const cc         = getCourseColumns(course);
            const fGrCol     = XLSX.utils.encode_col(2);
            const lGrCol     = XLSX.utils.encode_col(1 + cc.length);
            const excelRow   = index + 6;
            const lastStuRow = (appState.students[course] || []).length + 1;
            const sheetRef   = quoteSheetName(sheetNameByCourse[course]);
            const allGrades  = Object.values(appState.records[course] || {}).flatMap(r => cc.map(c => r.grades[c]));
            const loaded     = allGrades.filter(hasGrade).length;
            const average    = calculateAverage(allGrades);
            const stuCount   = (appState.students[course] || []).length;
            if (stuCount > 0) {
                worksheet[XLSX.utils.encode_cell({ r: excelRow - 1, c: 4 })] = {
                    t: "n", f: `COUNT(${sheetRef}!${fGrCol}2:${lGrCol}${lastStuRow})`, v: loaded
                };
                worksheet[XLSX.utils.encode_cell({ r: excelRow - 1, c: 5 })] = {
                    t: average === null ? "s" : "n",
                    f: `IFERROR(AVERAGE(${sheetRef}!${fGrCol}2:${lGrCol}${lastStuRow}),"")`,
                    v: average === null ? "" : average, z: "0.0"
                };
            } else {
                worksheet[XLSX.utils.encode_cell({ r: excelRow - 1, c: 4 })] = { t: "n", v: 0 };
                worksheet[XLSX.utils.encode_cell({ r: excelRow - 1, c: 5 })] = { t: "s", v: "" };
            }
        });
        return worksheet;
    }

    function buildHistoryWorksheet() {
        const worksheet = XLSX.utils.aoa_to_sheet([HISTORY_HEADERS, ...appState.historyRows]);
        worksheet["!cols"] = [{ wch: 18 }, { wch: 16 }, { wch: 16 }, { wch: 32 }, { wch: 12 }, { wch: 16 }, { wch: 14 }];
        worksheet["!autofilter"] = { ref: `A1:G${Math.max(appState.historyRows.length + 1, 1)}` };
        return worksheet;
    }

    window.ExcelModule = {
        buildWorkbook,
        importFromInput,
        isReservedSheetName,
        downloadBlob,
        buildExportFileName,
    };
})();
