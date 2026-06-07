import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { parseGrade, calculateAverage, computeTrajectory } = require("../web/utils.js");

// ── parseGrade ────────────────────────────────────────────────────────────────

describe("parseGrade", () => {
    it("retorna número entero para grado entero", () => {
        expect(parseGrade("7")).toBe(7);
    });

    it("retorna número decimal para grado con coma", () => {
        expect(parseGrade("7,5")).toBe(7.5);
    });

    it("retorna número decimal para grado con punto", () => {
        expect(parseGrade("9.75")).toBe(9.75);
    });

    it("retorna null para string vacío", () => {
        expect(parseGrade("")).toBeNull();
    });

    it("retorna null para texto no numérico", () => {
        expect(parseGrade("abc")).toBeNull();
    });

    it("retorna null para valor fuera del rango 0-10", () => {
        expect(parseGrade("11")).toBeNull();
        expect(parseGrade("-1")).toBeNull();
    });

    it("retorna null para null", () => {
        expect(parseGrade(null)).toBeNull();
    });

    it("retorna null para undefined", () => {
        expect(parseGrade(undefined)).toBeNull();
    });

    it("redondea a dos decimales", () => {
        expect(parseGrade("7.123")).toBe(7.12);
    });

    it("retorna entero cuando el decimal es .00", () => {
        expect(parseGrade("8.00")).toBe(8);
    });
});

// ── calculateAverage ──────────────────────────────────────────────────────────

describe("calculateAverage", () => {
    it("calcula promedio de valores numéricos", () => {
        expect(calculateAverage([6, 8, 10])).toBe(8);
    });

    it("ignora strings vacíos, null y undefined", () => {
        expect(calculateAverage([6, "", null, undefined, 8])).toBe(7);
    });

    it("retorna null cuando no hay valores válidos", () => {
        expect(calculateAverage([])).toBeNull();
        expect(calculateAverage([null, ""])).toBeNull();
    });

    it("acepta strings numéricos con coma", () => {
        expect(calculateAverage(["7,5", "8,5"])).toBe(8);
    });

    it("redondea a dos decimales", () => {
        expect(calculateAverage([1, 2, 3])).toBe(2);
        expect(calculateAverage([7, 8, 9])).toBe(8);
        // (5 + 6 + 7) / 3 = 6
        expect(calculateAverage([5, 6, 7])).toBe(6);
    });
});

// ── computeTrajectory ─────────────────────────────────────────────────────────

describe("computeTrajectory", () => {
    it("devuelve TEA para promedio >= 7.0 (umbral por defecto)", () => {
        expect(computeTrajectory(7)).toBe("TEA");
        expect(computeTrajectory(10)).toBe("TEA");
        expect(computeTrajectory(7.0)).toBe("TEA");
    });

    it("devuelve TEP para promedio >= 4.0 y < 7.0 (umbrales por defecto)", () => {
        expect(computeTrajectory(4)).toBe("TEP");
        expect(computeTrajectory(6.99)).toBe("TEP");
    });

    it("devuelve TED para promedio < 4.0 (umbral por defecto)", () => {
        expect(computeTrajectory(3.99)).toBe("TED");
        expect(computeTrajectory(0)).toBe("TED");
    });

    it("usa umbrales personalizados", () => {
        expect(computeTrajectory(8, { teaMin: 9, tepMin: 6 })).toBe("TEP");
        expect(computeTrajectory(9, { teaMin: 9, tepMin: 6 })).toBe("TEA");
        expect(computeTrajectory(5, { teaMin: 9, tepMin: 6 })).toBe("TED");
    });

    it("devuelve string vacío para null", () => {
        expect(computeTrajectory(null)).toBe("");
    });

    it("devuelve string vacío para undefined", () => {
        expect(computeTrajectory(undefined)).toBe("");
    });

    it("devuelve string vacío para string vacío", () => {
        expect(computeTrajectory("")).toBe("");
    });

    it("devuelve string vacío para NaN", () => {
        expect(computeTrajectory(NaN)).toBe("");
    });
});
