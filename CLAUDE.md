# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and run commands

All commands run from `ejecutable/electron/`:

```bash
npm run electron:start      # dev: sync web/ → app/, then launch Electron
npm run electron:make       # build portable .exe (electron-packager, loose-files folder)
npm run build:win           # build NSIS installer + self-contained portable .exe (electron-builder) → dist-installer/
npm run build:installer     # alias of build:win, kept for backward compatibility
node sync.js                # copy web/ → electron/app/ manually
```

**After every edit to `web/`**, run `node sync.js` (or `npm run electron:start`) before testing in Electron. The EXE serves files from `electron/app/`, not from `web/` directly.

There are no tests and no linter configured.

## Architecture

Vanilla HTML/CSS/JS multi-page app running in three environments: browser (web), Electron desktop (EXE), and mobile (APK). No build pipeline for the web layer — plain files served as-is.

### Pages and their JS files

| Page | Script |
|---|---|
| `index.html` | `script.js` (inline via `<script src>`) — grades entry |
| `boletines.html` | inline `<script>` (~800 lines) — report card generation |
| `estadisticas.html` | inline `<script>` — stats and charts |
| `admin.html` | inline `<script>` — user/institution management |
| `login.html` | inline `<script>` — Firebase Auth login |

Shared modules loaded by `<script src>` on every page: `firebase-config.js`, `auth.js`, `db.js`. `vendor/xlsx.full.min.js` is loaded by `index.html` only.

### Persistence layer — two-tier write, single read path

`index.html` (the grades editor) writes in two steps:
1. **Synchronous**: `localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))` — always succeeds immediately.
2. **Async fire-and-forget**: `DB.saveSubjectData(institutionId, subject, snapshot)` → Firestore.

`boletines.html` and `estadisticas.html` read **only from Firestore** via `DB.getAllSubjectDataForInstitution(institutionId)`. To bridge the race condition (Firestore write may be pending), `boletines.html` calls `mergeLocalStorageData(allSubjectData)` after every Firestore fetch. This function reads `localStorage` key `notas_docente_estado_v2`, matches by subject name, and overwrites the Firestore doc in-memory with the fresh local grades.

### State in `script.js`

- `appState` — in-memory working state: `{ subject, students, records, courses, gradeColumns, gradeColumnsMeta, historyRows, … }`
- `STORAGE_KEY = "notas_docente_estado_v2"` — primary localStorage key
- `savedSnapshot` — last written snapshot (used to detect unsaved changes)
- `isSaving` — mutex flag preventing concurrent saves
- `saveLocalState(updateTimestamp)` — writes localStorage + fires Firestore async
- `saveStateAndRender(msg)` — saves + full re-render with focus restoration
- `createSnapshot()` — serializes `appState` to a plain object for localStorage/Firestore
- `normalizeState(appState)` — called inside `createSnapshot()`; creates NEW record objects (side effect: mutates `appState`)

### Firestore collections

- `subjectData/{institutionId}_{subject}` — all grades for one subject in one institution
- `users/{uid}` — user profile: `{ institutionId, role: 'admin'|'profesor'|'preceptoria', name }`
- `institutions/{id}` — institution records
- `history/{auto}` — audit log entries

`DB.saveSubjectData()` uses `set({...}, { merge: true })` and excludes lock fields from the grade snapshot.

### Electron (EXE)

`ejecutable/electron/main.js` starts an Express server on `127.0.0.1:3737` serving `electron/app/` (static files). It also exposes three local endpoints: `GET /mail-config`, `POST /send-email` (Nodemailer), `GET /open-mailto`. SMTP credentials live in `ejecutable/electron/mail-config.json` (not committed).

### TEA / TEP / TED logic

Computed at render time in `boletines.html`:
- `computeAvg(grades, cols)` — filters non-numeric values, returns `null` if no grades
- `getTrajectory(avg)` — `>= teaMin` → TEA, `>= tepMin` → TEP, else → TED
- Thresholds (`teaMin`, `tepMin`) come from UI inputs, defaulting to 7.0 and 4.0

### Critical constraints

- **NEVER delete** `web/logos/` or any file inside it.
- **NEVER create a ZIP** on the Desktop.
- After any edit to `web/`, run `node sync.js` before testing the EXE.
- Do not break: Firebase, localStorage persistence, Excel export, authentication, boletines, estadísticas, EXE build, visual design, responsive layout.
- `will-prevent-unload` is suppressed in `main.js` intentionally — all data auto-saves to localStorage, so navigation is always safe from Electron's perspective.
- `renderTabs()` uses `data-tabcourse` attributes to reuse existing DOM nodes — do not replace with `innerHTML = ""` (breaks event listeners and loses focus mid-edit).
