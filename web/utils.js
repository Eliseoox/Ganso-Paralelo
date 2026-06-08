/* web/utils.js — utilidades compartidas entre páginas y módulo de tests */
(function () {
    "use strict";

    function hasGrade(value) {
        return value !== "" && value !== null && value !== undefined;
    }

    function parseGrade(value) {
        const normalized = String(value || "").trim().replace(",", ".");
        if (!normalized) return null;
        const number = Number(normalized);
        if (!Number.isFinite(number) || number < 0 || number > 10) return null;
        const rounded = Number(number.toFixed(2));
        return Number.isInteger(rounded) ? Math.trunc(rounded) : rounded;
    }

    function calculateAverage(values) {
        const grades = values
            .filter(hasGrade)
            .map(v => Number(String(v).replace(",", ".")))
            .filter(v => Number.isFinite(v));
        if (!grades.length) return null;
        const avg = Number((grades.reduce((t, v) => t + v, 0) / grades.length).toFixed(2));
        return Number.isInteger(avg) ? Math.trunc(avg) : avg;
    }

    function computeTrajectory(avg, { teaMin = 7.0, tepMin = 4.0 } = {}) {
        if (avg === null || avg === undefined || avg === "" || !Number.isFinite(Number(avg))) return "";
        const n = Number(avg);
        if (n >= teaMin) return "TEA";
        if (n >= tepMin) return "TEP";
        return "TED";
    }

    // Fusiona dos objetos de studentOverrides sin duplicar (case-insensitive).
    // Regla: si un alumno aparece en removals de cualquiera de los dos, gana la baja.
    function mergeOverrides(a, b) {
        const aAdd = (a && a.additions) ? a.additions : {};
        const bAdd = (b && b.additions) ? b.additions : {};
        const aRem = (a && a.removals)  ? a.removals  : {};
        const bRem = (b && b.removals)  ? b.removals  : {};

        const courses = new Set([
            ...Object.keys(aAdd), ...Object.keys(aRem),
            ...Object.keys(bAdd), ...Object.keys(bRem),
        ]);

        const result = { additions: {}, removals: {} };
        courses.forEach(course => {
            const remSeen = new Set();
            const remList = [];
            [...(aRem[course] || []), ...(bRem[course] || [])].forEach(s => {
                const key = s.toLowerCase();
                if (!remSeen.has(key)) { remSeen.add(key); remList.push(s); }
            });

            const addSeen = new Set();
            const addList = [];
            [...(aAdd[course] || []), ...(bAdd[course] || [])].forEach(s => {
                const key = s.toLowerCase();
                if (!addSeen.has(key) && !remSeen.has(key)) {
                    addSeen.add(key); addList.push(s);
                }
            });

            if (remList.length) result.removals[course] = remList;
            if (addList.length) result.additions[course] = addList;
        });
        return result;
    }

    const utils = { parseGrade, calculateAverage, computeTrajectory, mergeOverrides };

    // Node.js / Vitest (CJS interop)
    if (typeof module !== "undefined" && module.exports) {
        module.exports = utils;
    } else if (typeof window !== "undefined") {
        window.Utils = utils;
    }
})();
