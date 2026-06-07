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

    const utils = { parseGrade, calculateAverage, computeTrajectory };

    // Node.js / Vitest (CJS interop)
    if (typeof module !== "undefined" && module.exports) {
        module.exports = utils;
    } else if (typeof window !== "undefined") {
        window.Utils = utils;
    }
})();
