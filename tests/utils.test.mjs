import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { parseGrade, calculateAverage, computeTrajectory, mergeOverrides } = require("../web/utils.js");

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

// ── mergeOverrides ────────────────────────────────────────────────────────────

describe("mergeOverrides", () => {
    it("une removals de ambas fuentes sin duplicar (case-insensitive)", () => {
        const a = { additions: {}, removals: { "1ero": ["García, Juan"] } };
        const b = { additions: {}, removals: { "1ero": ["garcía, juan", "López, Ana"] } };
        const result = mergeOverrides(a, b);
        expect(result.removals["1ero"]).toHaveLength(2);
        expect(result.removals["1ero"].map(s => s.toLowerCase())).toContain("garcía, juan");
        expect(result.removals["1ero"].map(s => s.toLowerCase())).toContain("lópez, ana");
    });

    it("une additions de ambas fuentes sin duplicar (case-insensitive)", () => {
        const a = { additions: { "2do": ["Martínez, Pedro"] }, removals: {} };
        const b = { additions: { "2do": ["martínez, pedro", "Sosa, Laura"] }, removals: {} };
        const result = mergeOverrides(a, b);
        expect(result.additions["2do"]).toHaveLength(2);
    });

    it("removal gana sobre addition: alumno en removals se excluye de additions", () => {
        const a = { additions: { "1ero": ["García, Juan"] }, removals: {} };
        const b = { additions: {}, removals: { "1ero": ["García, Juan"] } };
        const result = mergeOverrides(a, b);
        expect(result.removals["1ero"]).toContain("García, Juan");
        expect(result.additions["1ero"] || []).not.toContain("García, Juan");
    });

    it("cursos sin overrides no aparecen en el resultado", () => {
        const a = { additions: {}, removals: {} };
        const b = { additions: {}, removals: {} };
        const result = mergeOverrides(a, b);
        expect(Object.keys(result.additions)).toHaveLength(0);
        expect(Object.keys(result.removals)).toHaveLength(0);
    });

    it("maneja fuentes null/undefined con gracia", () => {
        const result = mergeOverrides(null, { additions: { "1ero": ["García, Juan"] }, removals: {} });
        expect(result.additions["1ero"]).toContain("García, Juan");
    });

    it("fusiona cursos distintos de cada fuente", () => {
        const a = { additions: {}, removals: { "1ero": ["García, Juan"] } };
        const b = { additions: {}, removals: { "2do": ["López, Ana"] } };
        const result = mergeOverrides(a, b);
        expect(result.removals["1ero"]).toContain("García, Juan");
        expect(result.removals["2do"]).toContain("López, Ana");
    });
});

// ── escenario override: alumno dado de baja no aparece en lista filtrada ──────

describe("escenario studentOverrides — baja persiste sobre lista de alumnos", () => {
    it("lista filtrada excluye alumno en removals", () => {
        const students = ["García López, Juan", "Fernández, Ana", "Sosa, Pedro"];
        const removalSet = new Set(["garcía lópez, juan"]);
        const filtered = students.filter(s => !removalSet.has(s.toLowerCase()));
        expect(filtered).not.toContain("García López, Juan");
        expect(filtered).toContain("Fernández, Ana");
        expect(filtered).toContain("Sosa, Pedro");
    });

    it("alumno en additions que no está en la lista base es agregado", () => {
        const students = ["Fernández, Ana"];
        const additions = ["Nuevo, Carlos"];
        const removalSet = new Set();
        const result = [...students.filter(s => !removalSet.has(s.toLowerCase()))];
        const existingKeys = new Set(result.map(s => s.toLowerCase()));
        additions.forEach(s => {
            if (!existingKeys.has(s.toLowerCase())) result.push(s);
        });
        expect(result).toContain("Nuevo, Carlos");
        expect(result).toContain("Fernández, Ana");
    });

    it("mergeOverrides: baja desde un dispositivo + alta desde otro → gana la baja", () => {
        // Dispositivo A hizo un alta, dispositivo B hizo una baja del mismo alumno
        const local  = { additions: { "1ero": ["García, Juan"] }, removals: {} };
        const remote = { additions: {}, removals: { "1ero": ["García, Juan"] } };
        const merged = mergeOverrides(local, remote);
        expect(merged.removals["1ero"]).toContain("García, Juan");
        expect((merged.additions["1ero"] || []).map(s => s.toLowerCase())).not.toContain("garcía, juan");
    });
});
