# Módulo Excel — Documentación técnica

## Resumen

El sistema importa y exporta archivos `.xlsx` usando la librería [SheetJS (xlsx)](https://sheetjs.com/).
Los datos se procesan completamente en el navegador — ningún archivo se sube a un servidor.

---

## Formato de importación

### Estructura esperada del archivo

| Hoja | Descripción |
|------|-------------|
| Una hoja por curso | Datos de alumnos y notas del curso |
| `Resumen` (opcional) | Se ignora al importar; se regenera al exportar |
| `Historial` (opcional) | Se importa si está presente |

### Columnas de cada hoja de curso

| Columna | Obligatorio | Descripción |
|---------|-------------|-------------|
| `Alumno` | **Sí** | Nombre completo del alumno |
| `N` | No | Número de orden (se recalcula al exportar) |
| `Nota 1` … `Nota N` | No | Notas numéricas (0–10, acepta decimales con `.` o `,`) |
| `Promedio` | No | Se ignora al importar; se recalcula al exportar |
| `Ultima actualizacion` | No | Se preserva si está presente |

### Nombres de hoja aceptados por curso

El sistema mapea nombres de hoja a los 6 cursos fijos:

| Curso | Nombres aceptados |
|-------|-------------------|
| `1ero` | 1, 1ero, 1er, 1ro, primero, 1°A, 1°B, etc. |
| `2do` | 2, 2do, 2ndo, segundo, 2°A, etc. |
| `3ero` | 3, 3ero, 3er, 3ro, tercero |
| `4to` | 4, 4to, cuarto |
| `5to` | 5, 5to, quinto |
| `6to` | 6, 6to, sexto |

Los sufijos `A`/`B` y el símbolo `°` se ignoran al comparar.
Las hojas que no corresponden a ningún curso fijo se omiten con un aviso.

### Validación

Al cargar un Excel, el sistema valida:

1. **Errores bloqueantes** — impiden la carga:
   - No se encontraron hojas de curso
   - Una hoja no tiene fila de encabezados reconocible
   - Una hoja no tiene columna `Alumno`

2. **Advertencias** — la carga continúa:
   - Una hoja no tiene columnas `Nota N` (se usan las columnas por defecto: Nota 1–6)
   - Una hoja no tiene las columnas opcionales (`N`, `Promedio`, `Ultima actualizacion`)
   - Alumnos duplicados dentro de una hoja (se omite el duplicado)
   - Notas con valores no numéricos (se dejan vacías)
   - Hojas que no corresponden a ningún curso fijo

### Detección de encabezados

- El sistema busca la fila de encabezados en las primeras 8 filas de cada hoja
- Los encabezados se normalizan (sin tildes, en minúsculas) antes de comparar
- Se reconocen alias: `alumna`, `estudiante`, `nombre` → `Alumno`; `nro`, `numero` → `N`
- Para las notas se acepta cualquier variante de `nota N` (con o sin espacio): `nota1`, `Nota 1`, `NOTA 2`

---

## Formato de exportación

### Hojas generadas

| Hoja | Contenido |
|------|-----------|
| `Resumen` | Estadísticas por curso: alumnos, aprobados, desaprobados, promedio general |
| `1ero` … `6to` | Alumnos con todas sus notas y promedio calculado con fórmula Excel |
| `Historial` | Registro de cada cambio de nota (acción, fecha, curso, alumno, columna, nota anterior/nueva) |

### Columnas exportadas por curso

```
N | Alumno | Nota 1 | Nota 2 | … | Nota N | Promedio | Ultima actualizacion
```

- El **Promedio** se exporta como fórmula `IFERROR(AVERAGE(…),"")` para que se recalcule en Excel
- Los cursores de columna `A:B` quedan **congelados** (freeze panes) para facilitar la lectura
- Se aplica **autofilter** a toda la tabla
- Las columnas tienen anchos preconfigurados para lectura cómoda

### Nombre del archivo exportado

El nombre se genera automáticamente con el formato:

```
{institución}_{materia}_{año}.xlsx
```

Ejemplo: `Colegio_San_Martin_Matematica_2026.xlsx`

Si no hay institución configurada, se omite ese segmento.

### Hoja Resumen

La hoja `Resumen` contiene:
- Datos de la institución, materia y fecha de generación
- Una fila por curso con: cantidad de alumnos, aprobados, desaprobados
- Fórmulas cruzadas que referencian las hojas de cada curso
- Para cursos sin alumnos: valores estáticos `0`/`""` (sin fórmulas, para evitar rangos inválidos)

---

## Exportación automática al modificar alumnos

Cuando se **agrega** o **quita** un alumno desde la pantalla de administración (`alumnos.html`), el sistema genera y descarga automáticamente un Excel actualizado.
Esto ocurre independientemente de si se había cargado un Excel previamente.

El archivo descargado contiene el estado completo: todos los cursos, notas y el historial.

---

## Generación de datos de muestra

El botón **"Generar muestra"** en el paso 2:

1. Crea 6 cursos (1ero–6to) con 20 alumnos cada uno (nombres aleatorios)
2. Asigna notas ficticias con distribución realista:
   - ~12% de alumnos con promedio < 4 (desaprobados bajos)
   - ~18% con promedio 4–6.4 (en proceso)
   - ~70% con promedio ≥ 6.5 (aprobados)
3. Descarga automáticamente el Excel generado (`muestra_aleatoria.xlsx`)

Los datos de muestra **no corresponden a alumnos reales** y están diseñados solo para visualización y pruebas del sistema.

---

## Re-importación de archivos exportados

Un archivo exportado por este sistema puede re-importarse sin pérdida de datos:
- Las columnas `Resumen` e `Historial` se procesan correctamente
- Las fórmulas de promedio se ignoran al importar (se lee el valor `v` calculado)
- El historial se preserva y continúa acumulándose

---

## Notas técnicas

- **Librería**: SheetJS `xlsx.full.min.js` (incluida localmente en `vendor/`)
- **Procesamiento**: 100% cliente — ningún dato sale del navegador al importar/exportar
- **Codificación**: UTF-8, sin BOM
- **Formato de fechas**: `DD/MM/YYYY HH:MM` (sin librería de fechas externa)
- **Rango de notas válidas**: 0–10, con hasta 2 decimales; se aceptan coma y punto como separador decimal
- **Persistencia local**: el estado se guarda en `localStorage` bajo la clave `notas_docente_estado_v2`
- **Backup**: descargable como JSON (incluye todo el estado: alumnos, notas, historial, metadatos)
