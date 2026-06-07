# Análisis de Mejoras — Ganso-Paralelo

**Fecha:** Junio 2026  
**Archivos analizados:** `web/script.js` (~3700 líneas), `web/auth.js`, `web/db.js`, `web/boletines.html`, `firestore.rules`, `ejecutable/electron/main.js`, `README.md`, `CLAUDE.md`

---

## Resumen ejecutivo

El proyecto está técnicamente sólido para ser un desarrollo individual. La arquitectura de persistencia en dos capas (localStorage + Firestore), la resolución de conflictos multi-dispositivo, el sistema de roles y las reglas de Firestore son correctos y bien pensados. Las mejoras listadas abajo no son correcciones de bugs críticos sino inversiones en mantenibilidad, escalabilidad y robustez a futuro.

Las mejoras están ordenadas de mayor a menor impacto.

---

## 1. Dividir `script.js` en módulos — ALTA PRIORIDAD

**Problema:** `script.js` tiene ~3700 líneas con lógica de estado, renderizado, Excel, sincronización, backup e historial mezclados. Cada bug obliga a navegar cientos de líneas.

**Solución:** Crear `web/modules/` con un archivo por responsabilidad.

### Estructura propuesta

```
web/
└── modules/
    ├── state.js          ← appState, createInitialState, createSnapshot, loadStateFromSnapshot
    ├── render.js         ← renderAll, renderTable, renderTabs, renderStats, renderFlow
    ├── grades.js         ← insertGrade, changeGrade, deleteSelectedGrade, parseGrade, calculateAverage
    ├── excel.js          ← importWorkbook, validateWorkbook, readWorkbookState, buildWorkbookFromState
    ├── backup.js         ← downloadBackup, importRestoreBackup, clearAllData
    ├── history.js        ← logHistoryEntry, openHistoryModal
    ├── sync.js           ← scheduleFirestoreSave, flushFirestoreSave, attachSubjectListener
    └── email.js          ← shareExcelByEmail, fetchElectronMailCfg
```

### Pasos de implementación

1. Crear la carpeta `web/modules/`.
2. Por cada módulo nuevo, extraer las funciones correspondientes de `script.js` y envolverlas en un `export` (o exponer en `window.NombreModulo` si se mantiene sin bundler).
3. En `index.html`, agregar `<script src="modules/state.js">` antes de `<script src="script.js">`.
4. En `script.js`, reemplazar cada función extraída por una llamada al módulo: en vez de definir `parseGrade()` localmente, usar `Grades.parseGrade()`.
5. Verificar con `node sync.js` y probar en EXE que todo sigue funcionando.

**Tiempo estimado:** 2-3 días de refactor gradual. Se puede hacer módulo por módulo sin romper nada.

**Advertencia:** `renderTabs()` usa `data-tabcourse` para reusar nodos DOM. NO reemplazar con `innerHTML = ""` en ningún refactor (ya está documentado en CLAUDE.md).

---

## 2. Extraer scripts inline de boletines, estadísticas y admin — ALTA PRIORIDAD

**Problema:** `boletines.html`, `estadisticas.html` y `admin.html` tienen el script directamente dentro de la página (800+ líneas cada uno). Esto hace imposible:
- Buscar funciones con Ctrl+P en el editor
- Reusar funciones entre páginas
- Aplicar linting específico

**Solución:** Mover cada bloque `<script>...</script>` a un archivo externo.

### Pasos de implementación

1. En `boletines.html`, cortar todo el contenido del `<script>` que está al final.
2. Crear `web/boletines.js` y pegar el contenido ahí.
3. Reemplazar el `<script>` en `boletines.html` por `<script src="boletines.js"></script>`.
4. Repetir para `estadisticas.html` → `estadisticas.js` y `admin.html` → `admin.js`.
5. Correr `node sync.js` y verificar que las tres páginas funcionen igual.

**Tiempo estimado:** 30 minutos. Es la mejora con mejor ratio esfuerzo/ganancia.

---

## 3. Agregar ESLint + Prettier — ALTA PRIORIDAD

**Problema:** Sin linter, el código puede acumular errores silenciosos (variables no declaradas, comparaciones débiles `==` en vez de `===`, etc.) sin que nadie lo detecte.

**Solución:** Configurar ESLint con reglas básicas + Prettier para formato automático.

### Pasos de implementación

```bash
# Desde web/ o la raíz del proyecto
npm init -y
npm install --save-dev eslint prettier eslint-config-prettier

# Crear .eslintrc.json en la raíz
```

**Contenido de `.eslintrc.json`:**
```json
{
  "env": { "browser": true, "es2020": true },
  "extends": ["eslint:recommended", "prettier"],
  "rules": {
    "no-unused-vars": "warn",
    "no-undef": "error",
    "eqeqeq": ["error", "always"],
    "no-console": "off"
  },
  "globals": {
    "firebase": "readonly",
    "XLSX": "readonly",
    "DB": "readonly",
    "Auth": "readonly",
    "GansoLog": "readonly",
    "FIREBASE_CONFIG": "readonly"
  }
}
```

**Contenido de `.prettierrc`:**
```json
{
  "semi": true,
  "singleQuote": false,
  "tabWidth": 4,
  "printWidth": 120
}
```

**Agregar a `package.json`:**
```json
"scripts": {
  "lint": "eslint web/script.js web/auth.js web/db.js",
  "lint:fix": "eslint --fix web/script.js web/auth.js web/db.js",
  "format": "prettier --write web/script.js web/auth.js web/db.js"
}
```

---

## 4. Agregar tests unitarios con Vitest — ALTA PRIORIDAD

**Problema:** Las funciones más críticas del sistema (`parseGrade`, `calculateAverage`, `computeTrajectory`, `normalizeHeader`, `migrateSnapshot`) no tienen tests. Un error en `parseGrade` afecta a todos los promedios.

**Solución:** Agregar Vitest (compatible con Vanilla JS sin bundler complejo).

### Pasos de implementación

```bash
npm install --save-dev vitest jsdom
```

**Crear `tests/grades.test.js`:**
```javascript
import { describe, it, expect } from 'vitest';

// Para testear funciones que aún están en script.js, primero extraerlas a módulos
// Ejemplo: import { parseGrade, calculateAverage } from '../web/modules/grades.js';

describe('parseGrade', () => {
  it('convierte "7" a 7', () => expect(parseGrade("7")).toBe(7));
  it('convierte "7,5" a 7.5', () => expect(parseGrade("7,5")).toBe(7.5));
  it('convierte "7.5" a 7.5', () => expect(parseGrade("7.5")).toBe(7.5));
  it('retorna null para ""', () => expect(parseGrade("")).toBeNull());
  it('retorna null para "abc"', () => expect(parseGrade("abc")).toBeNull());
  it('retorna null para "11"', () => expect(parseGrade("11")).toBeNull()); // fuera de rango
  it('retorna null para "-1"', () => expect(parseGrade("-1")).toBeNull());
  it('acepta "S" como ausente (sin nota)', () => expect(parseGrade("S")).toBe("S")); // ajustar según lógica real
});

describe('calculateAverage', () => {
  it('promedia notas numéricas ignorando vacíos', () => {
    expect(calculateAverage({ "N1": "7", "N2": "", "N3": "9" })).toBeCloseTo(8);
  });
  it('retorna null si no hay notas', () => {
    expect(calculateAverage({ "N1": "", "N2": "" })).toBeNull();
  });
});

describe('computeTrajectory', () => {
  it('7.0 → TEA', () => expect(computeTrajectory(7.0)).toBe('TEA'));
  it('6.5 → TEP', () => expect(computeTrajectory(6.5)).toBe('TEP'));
  it('3.9 → TED', () => expect(computeTrajectory(3.9)).toBe('TED'));
  it('null → null', () => expect(computeTrajectory(null)).toBeNull());
});
```

**Agregar a `package.json`:**
```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest"
}
```

**Prerequisito:** Esto requiere haber extraído las funciones a módulos (mejora #1). Mientras están en `script.js`, no son importables.

---

## 5. Separar `normalizeState()` de `createSnapshot()` — MEDIA PRIORIDAD

**Problema:** `createSnapshot()` tiene un side effect oculto: llama a `normalizeState(appState)` que **muta** `appState` en el proceso de serialización. Esto viola el principio de que serializar datos no debería cambiar el estado.

Actualmente (en `script.js`):
```javascript
function createSnapshot() {
    normalizeState(appState);  // ← muta appState como side effect!
    return { ... };
}
```

**Solución:** Llamar a `normalizeState(appState)` explícitamente antes de crear el snapshot, en los lugares donde hace falta.

### Pasos de implementación

1. Buscar todos los lugares donde se llama `createSnapshot()`: son `saveLocalState()` y el listener de Firestore.
2. En `saveLocalState()`, antes de `const snapshot = createSnapshot()`, agregar `normalizeState(appState)` explícitamente.
3. En `createSnapshot()`, eliminar la llamada a `normalizeState(appState)`.
4. Hacer lo mismo en cualquier otro lugar donde `createSnapshot()` implique la normalización.
5. Documentar el cambio en comentarios.

**Resultado:** `createSnapshot()` se convierte en función pura — misma entrada, mismo output, sin cambios de estado.

---

## 6. Reemplazar `window.confirm()` por modales propios — MEDIA PRIORIDAD

**Problema:** Hay al menos 3 usos de `window.confirm()` para confirmaciones destructivas (cambiar institución, importar backup, iniciar nueva sesión). `window.confirm()`:
- Tiene estilo diferente según el sistema operativo
- En Electron puede comportarse inesperadamente
- No permite personalizar el texto de los botones ("OK/Cancelar" en vez de "Sí, borrar/No, volver")

**Solución:** Crear una función `confirmDialog(mensaje, { confirmText, cancelText })` que crea un modal propio.

### Pasos de implementación

1. Agregar esta función en `script.js` (o en un módulo `ui.js`):

```javascript
function confirmDialog(message, { confirmText = "Confirmar", cancelText = "Cancelar" } = {}) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "confirm-overlay";
        overlay.innerHTML = `
            <div class="confirm-card" role="dialog" aria-modal="true">
                <p>${escapeHtml(message)}</p>
                <div class="confirm-actions">
                    <button class="btn secondary confirm-cancel">${escapeHtml(cancelText)}</button>
                    <button class="btn danger confirm-ok">${escapeHtml(confirmText)}</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const cleanup = (result) => { overlay.remove(); resolve(result); };
        overlay.querySelector(".confirm-ok").addEventListener("click", () => cleanup(true));
        overlay.querySelector(".confirm-cancel").addEventListener("click", () => cleanup(false));
        overlay.addEventListener("keydown", e => { if (e.key === "Escape") cleanup(false); });
        overlay.querySelector(".confirm-ok").focus();
    });
}
```

2. Agregar estilos en `styles.css`:
```css
.confirm-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center; z-index: 9999;
}
.confirm-card {
    background: var(--bg); border-radius: 12px; padding: 24px; max-width: 400px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
}
.confirm-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 20px; }
```

3. Reemplazar cada `window.confirm("...")` por `await confirmDialog("...", { confirmText: "...", cancelText: "..." })`.

Ejemplo: en `changeInstitution()`:
```javascript
// Antes:
if (hasData() && !window.confirm("Cambiar de institución va a limpiar los datos...")) return;

// Después:
if (hasData() && !await confirmDialog(
    "Cambiar de institución va a limpiar los datos cargados actualmente.",
    { confirmText: "Sí, cambiar", cancelText: "Cancelar" }
)) return;
```

---

## 7. TEA/TEP/TED — Una sola fuente de verdad — MEDIA PRIORIDAD

**Problema:** La lógica de trayectorias (TEA/TEP/TED) está duplicada en dos lugares:
- `script.js`: función `computeTrajectory(avg)` 
- `boletines.html`: funciones `computeAvg()` y `getTrajectory()` inline

Si cambian los umbrales o la lógica, hay que actualizar en dos lugares. Ya hay inconsistencia: en `boletines.html` los umbrales vienen de inputs de UI, en `script.js` son constantes `TEA_MIN=7.0` y `TEP_MIN=4.0`.

**Solución:** Mover `computeTrajectory` a `db.js` o a un módulo `utils.js` compartido, y que `boletines.html` lo importe.

### Pasos de implementación

1. Agregar en `db.js` (o crear `web/utils.js`):
```javascript
// En window.Utils o como export
function computeTrajectory(avg, { teaMin = 7.0, tepMin = 4.0 } = {}) {
    if (avg === null || avg === undefined) return null;
    if (avg >= teaMin) return "TEA";
    if (avg >= tepMin) return "TEP";
    return "TED";
}
```

2. En `boletines.html`, reemplazar `getTrajectory(avg)` por `Utils.computeTrajectory(avg, { teaMin, tepMin })`.
3. En `script.js`, reemplazar `computeTrajectory(avg)` por `Utils.computeTrajectory(avg)`.

---

## 8. Firestore Rules: eliminar lecturas extra con Custom Claims — MEDIA PRIORIDAD

**Problema:** En `firestore.rules`, cada función helper llama a `userDoc()` que hace `get()` del documento del usuario. En una operación de update de `subjectData`, se evalúan `canEdit()`, `userInstIds()` e `isAdmin()`, que llaman a `userDoc()` tres veces. Cada `get()` en las reglas cuenta como una lectura de Firestore cobrable.

```javascript
// Actual: userDoc() se llama múltiples veces por operación
function isAdmin()    { return isAuth() && userRole() == 'admin'; }  // userDoc() aquí
function canEdit()    { return isAuth() && userRole() in [...]; }    // userDoc() aquí
function userInstIds(){ let d = userDoc().data; return ...; }        // userDoc() aquí
```

**Solución:** Usar Firebase Custom Claims. El rol y las instituciones del usuario se almacenan en el JWT, que está disponible en `request.auth.token` — sin costo adicional.

### Pasos de implementación

1. **Crear una Firebase Cloud Function** que setea los custom claims al crear/actualizar un usuario:

```javascript
// functions/index.js
const admin = require('firebase-admin');
const functions = require('firebase-functions');
admin.initializeApp();

exports.setUserClaims = functions.firestore
    .document('users/{uid}')
    .onWrite(async (change, context) => {
        const uid = context.params.uid;
        const data = change.after.exists ? change.after.data() : null;
        if (!data) return;
        await admin.auth().setCustomUserClaims(uid, {
            role: data.role || 'profesor',
            institutionIds: data.institutionIds || (data.institutionId ? [data.institutionId] : [])
        });
    });
```

2. **Actualizar `firestore.rules`** para usar los claims en vez de `userDoc()`:

```javascript
function userRole()    { return request.auth.token.role; }
function userInstIds() { return request.auth.token.institutionIds; }
function isAdmin()     { return isAuth() && userRole() == 'admin'; }
function canEdit()     { return isAuth() && userRole() in ['admin', 'profesor']; }
// Eliminar completamente la función userDoc()
```

3. En el frontend (`auth.js`), al hacer `onAuthStateChanged`, forzar refresh del token para que los nuevos claims se apliquen:
```javascript
await user.getIdToken(true); // Fuerza refresh del ID token con claims actualizados
```

**Resultado:** Las reglas de Firestore pasan de necesitar 3+ lecturas a 0 lecturas adicionales por operación.

---

## 9. Auto-actualización del EXE con `electron-updater` — MEDIA PRIORIDAD

**Problema:** Actualmente, cuando se publica una nueva versión, el usuario tiene que descargar el `.exe` manualmente, instalarlo y cerrar la versión anterior. No hay ningún mecanismo de notificación ni actualización automática.

**Solución:** Integrar `electron-updater` (parte del paquete `electron-builder`) para actualizaciones automáticas desde GitHub Releases.

### Pasos de implementación

```bash
cd ejecutable/electron
npm install electron-updater
```

En `main.js`, agregar:
```javascript
const { autoUpdater } = require('electron-updater');

app.on('ready', () => {
    // ... código existente ...
    
    // Verificar actualizaciones al iniciar (solo en producción)
    if (!isDev) {
        autoUpdater.checkForUpdatesAndNotify();
    }
});

autoUpdater.on('update-available', () => {
    mainWindow.webContents.send('update-available');
});

autoUpdater.on('update-downloaded', () => {
    mainWindow.webContents.send('update-downloaded');
});
```

En el renderer (`script.js` o `index.html`):
```javascript
// Escuchar eventos de actualización desde el proceso principal
if (typeof require !== 'undefined') {
    const { ipcRenderer } = require('electron');
    ipcRenderer.on('update-available', () => showToast("Nueva versión disponible, descargando..."));
    ipcRenderer.on('update-downloaded', () => {
        showToast("Actualización lista. Reiniciá la app para instalarla.");
    });
}
```

En `electron-builder.yml` o `package.json`:
```json
"publish": {
    "provider": "github",
    "owner": "Eliseoox",
    "repo": "ganso-paralelo"
}
```

**Nota:** Requiere subir las releases a GitHub y firmar el ejecutable (ver mejora #10).

---

## 10. Firmar el `.exe` (Code Signing) — MEDIA PRIORIDAD

**Problema:** El `.exe` actual no está firmado. Windows Defender o SmartScreen puede bloquearlo con un aviso de "aplicación desconocida", lo cual genera desconfianza en los usuarios del colegio.

**Solución:** Firmar el ejecutable con un certificado de código.

### Opciones

**Opción A (gratuita, recomendada para uso interno):** Certificado auto-firmado
```powershell
# Crear certificado auto-firmado
New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Ganso-Paralelo" -CertStoreLocation "Cert:\CurrentUser\My"

# Exportar como .pfx
$cert = Get-ChildItem -Path "Cert:\CurrentUser\My" -CodeSigningCert
Export-PfxCertificate -Cert $cert -FilePath "ganso.pfx" -Password (Read-Host -AsSecureString "Contraseña")
```

**Opción B (paga, recomendada para distribución pública):** Comprar un certificado EV de Sectigo o DigiCert (~$500/año). Windows confiará automáticamente en el ejecutable.

**En `electron-builder.yml`:**
```yaml
win:
  certificateFile: ganso.pfx
  certificatePassword: ${CERT_PASSWORD}
  signingHashAlgorithms: ["sha256"]
```

---

## 11. APK — Cambiar de debug a release firmado — MEDIA PRIORIDAD

**Problema:** En `README.md` dice `app-debug.apk`. Un APK debug:
- Está firmado con la clave de debug genérica de Android
- Puede tener overhead de debugging (logging extra, sin optimizaciones)
- Técnicamente Android puede rechazarlo en versiones futuras o en ciertas configuraciones de seguridad

**Solución:** Generar y distribuir el APK de release.

### Pasos de implementación

1. Generar un keystore de producción (una sola vez):
```bash
keytool -genkey -v -keystore ganso.keystore -alias ganso -keyalg RSA -keysize 2048 -validity 10000
```

2. Guardar `ganso.keystore` de forma segura (NO en el repositorio Git).

3. Actualizar `patch_apk.py` para firmar con el keystore de producción:
```python
# En patch_apk.py, en el paso de firma:
subprocess.run([
    "apksigner", "sign",
    "--ks", "ganso.keystore",
    "--ks-key-alias", "ganso",
    "--ks-pass", f"pass:{KEYSTORE_PASS}",
    "--out", "app-release.apk",
    "app-release-unsigned.apk"
], check=True)
```

4. Actualizar el README para mencionar `app-release.apk` en lugar de `app-debug.apk`.

---

## 12. Content Security Policy (CSP) en Electron — BAJA PRIORIDAD

**Problema:** Las páginas HTML no tienen encabezados CSP configurados. Aunque el servidor Express de Electron solo sirve `127.0.0.1:3737` y las navegaciones externas están bloqueadas en `main.js`, un CSP explícito añade una capa adicional de defensa en profundidad contra XSS.

**Solución:** Agregar el CSP como meta-tag en cada HTML o como header en Express.

### En Express (`main.js`), agregar el middleware:
```javascript
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', 
        "default-src 'self' 127.0.0.1:3737; " +
        "script-src 'self' 'unsafe-inline' https://www.gstatic.com https://cdn.jsdelivr.net; " +
        "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; " +
        "frame-src 'none';"
    );
    next();
});
```

**Nota:** `'unsafe-inline'` es necesario por los scripts inline que todavía existen en boletines/estadísticas/admin. Una vez completada la mejora #2, se puede eliminar y usar nonces en su lugar.

---

## 13. CI/CD con GitHub Actions — BAJA PRIORIDAD

**Problema:** No hay pipeline de integración continua. Cada build del `.exe` o APK se hace manualmente.

**Solución:** Crear workflows de GitHub Actions para automatizar lint, tests y builds.

### Crear `.github/workflows/ci.yml`:
```yaml
name: CI

on: [push, pull_request]

jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run lint
      - run: npm test

  build-exe:
    needs: lint-and-test
    runs-on: windows-latest
    if: startsWith(github.ref, 'refs/tags/v')
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: cd ejecutable/electron && npm ci && npm run build:installer
      - uses: actions/upload-artifact@v4
        with:
          name: ganso-exe
          path: ejecutable/electron/dist/*.exe
```

---

## 14. Mejorar accesibilidad de modales — BAJA PRIORIDAD

**Problema:** Los modales (selector de institución, historial, etc.) no tienen atributos ARIA completos ni focus trap. Lectores de pantalla no anuncian correctamente la apertura de modales.

**Solución:** Agregar `role="dialog"`, `aria-modal="true"`, `aria-labelledby` y focus trap en todos los modales.

### Patrón para aplicar a todos los modales:
```javascript
// Al abrir cualquier modal:
overlay.setAttribute('role', 'dialog');
overlay.setAttribute('aria-modal', 'true');
overlay.setAttribute('aria-labelledby', 'modal-title-id');

// Focus trap: atrapar Tab dentro del modal
overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = [...overlay.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )];
    const first = focusable[0];
    const last  = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
});
```

---

## 15. Agregar paginación o virtualización para tablas grandes — BAJA PRIORIDAD

**Problema:** `renderTable()` reconstruye el tbody completo con innerHTML en cada cambio de nota. Para cursos con 30 alumnos y 6 columnas de notas, eso son 180 inputs destruidos y recreados. Aunque es rápido con 30 alumnos, podría escalar mal si se permiten más alumnos.

**Solución a corto plazo:** Limitar las actualizaciones a la celda modificada en vez de reconstruir la tabla entera.

```javascript
function updateCell(studentName, columnKey, value) {
    const input = elements.tableBody.querySelector(
        `[data-student="${CSS.escape(studentName)}"][data-column="${CSS.escape(columnKey)}"]`
    );
    if (input && input !== document.activeElement) input.value = value;
    // Actualizar solo el promedio de esa fila
    updateRowAverage(studentName);
}
```

**Advertencia:** `renderTable()` existe por razón — cuando cambia la estructura (columnas, alumnos), hay que reconstruir. Aplicar esta optimización solo para cambios de valor, no cambios estructurales.

---

## 16. Migrar a TypeScript — LARGO PLAZO

**Problema:** Sin tipos explícitos, las interfaces de datos (`AppState`, `Snapshot`, `StudentRecord`, `MailConfig`) están implícitas. Errores como pasar `null` donde se espera un número se detectan solo en runtime.

**Solución:** Migrar gradualmente a TypeScript. La estrategia recomendada para proyectos vanilla JS es empezar con JSDoc types (sin cambiar nada de infraestructura) y luego migrar archivo por archivo.

### Paso 1 — JSDoc types (sin romper nada):
```javascript
/**
 * @typedef {Object} AppState
 * @property {string} subject
 * @property {string[]} courses
 * @property {Object.<string, string[]>} students  // course → list of names
 * @property {Object} records
 * @property {string[]} gradeColumns
 */

/** @type {AppState} */
let appState = createInitialState();
```

### Paso 2 — Agregar `tsconfig.json` con `allowJs: true, checkJs: true`:
```json
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "strict": false,
    "target": "ES2020",
    "lib": ["ES2020", "DOM"]
  },
  "include": ["web/**/*.js"]
}
```

Esto activa el type-checker de TypeScript sobre el JS existente sin modificar ningún archivo.

### Paso 3 — Migrar módulo a módulo a `.ts` cuando estén listos.

---

## 17. Encriptar credenciales SMTP con el keychain del sistema — BAJA PRIORIDAD

**Problema:** `mail-config.json` (en la carpeta del EXE) guarda la contraseña de Gmail en texto plano. Aunque el archivo no está en el repositorio Git, cualquier persona con acceso al directorio del EXE puede leer las credenciales.

**Solución:** Usar `keytar` para almacenar la contraseña en el keychain nativo de Windows (Credential Manager).

```bash
cd ejecutable/electron
npm install keytar
```

```javascript
// En main.js, al leer la configuración:
const keytar = require('keytar');

async function getMailConfig() {
    const cfg = JSON.parse(fs.readFileSync(mailConfigPath, 'utf8'));
    // La contraseña se guarda por separado en el keychain
    const storedPass = await keytar.getPassword('GansoParalelo', cfg.user);
    return { ...cfg, pass: storedPass || cfg.pass };
}

// Al guardar por primera vez:
async function saveMailPassword(user, password) {
    await keytar.setPassword('GansoParalelo', user, password);
}
```

---

## Tabla resumen de prioridades

| # | Mejora | Prioridad | Tiempo estimado |
|---|--------|-----------|-----------------|
| 1 | Dividir script.js en módulos | Alta | 2-3 días |
| 2 | Extraer scripts inline de boletines/estadísticas/admin | Alta | 30 min |
| 3 | Agregar ESLint + Prettier | Alta | 1 hora |
| 4 | Agregar tests unitarios (Vitest) | Alta | 1 día |
| 5 | Separar normalizeState() del createSnapshot() | Media | 1 hora |
| 6 | Reemplazar window.confirm() por modales propios | Media | 2 horas |
| 7 | TEA/TEP/TED — fuente de verdad única | Media | 1 hora |
| 8 | Firestore Rules — Custom Claims | Media | 3 horas |
| 9 | Auto-actualización del EXE con electron-updater | Media | 4 horas |
| 10 | Firmar el .exe (Code Signing) | Media | 2 horas |
| 11 | APK release firmado (no debug) | Media | 2 horas |
| 12 | CSP en Electron | Baja | 30 min |
| 13 | CI/CD con GitHub Actions | Baja | 2 horas |
| 14 | Accesibilidad ARIA en modales | Baja | 2 horas |
| 15 | Optimizar renderTable() para actualizaciones parciales | Baja | 3 horas |
| 16 | Migrar a TypeScript (gradual) | Largo plazo | Semanas |
| 17 | Keychain para credenciales SMTP | Baja | 1 hora |

---

## Por dónde empezar

Si querés arrancar hoy, el orden recomendado es:

1. **Mejora #2** (30 min): Sacar los scripts inline. No rompe nada y hace todo lo demás más fácil.
2. **Mejora #3** (1 hora): ESLint + Prettier. Corre `npm run lint` y fijate qué sale — probablemente encuentres cosas inesperadas.
3. **Mejora #6** (2 horas): Reemplazar `window.confirm()`. Visible para el usuario final y mejora la UX.
4. **Mejora #1** (2-3 días): El refactor grande. Una vez que los scripts estén externos y el linter esté listo, dividir `script.js` es mucho más seguro.

---

*Generado el 7 de junio de 2026.*
