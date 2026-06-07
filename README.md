# Ganso-Paralelo

**Sistema académico institucional multiplataforma para gestión de notas, boletines y sincronización escolar.**

Desarrollado por **Eliseo Ignacio Pérez de Villarreal** — [@Eliseoox](https://github.com/Eliseoox)

---

## Descripción

Ganso-Paralelo es una aplicación institucional diseñada para centralizar y simplificar la gestión de calificaciones escolares. Permite a docentes cargar notas, generar boletines y exportar planillas Excel, con sincronización en tiempo real entre múltiples dispositivos y soporte completo para uso sin conexión.

El sistema opera en tres entornos de forma simultánea:

| Plataforma | Distribución | Tecnología |
|---|---|---|
| **Web** | Navegador (Chrome, Firefox, Safari) | HTML/CSS/JS + Firebase |
| **Escritorio** | `Ganso-Paralelo.exe` (Windows x64) | Electron + Express |
| **Móvil** | `app-debug.apk` (Android) | Capacitor WebView |

---

## Características principales

- **Carga de notas** por materia, curso y alumno con validación en tiempo real
- **Sincronización multi-dispositivo** mediante Firebase Firestore con resolución de conflictos
- **Persistencia offline**: los datos se guardan localmente y se sincronizan al reconectar
- **Exportación a Excel** con fórmulas de promedio, historial de cambios y hoja de resumen
- **Boletines institucionales** generados directamente desde el navegador (impresión / PDF)
- **Estadísticas y gráficos** por curso, materia e institución
- **Panel de administración** para gestión de usuarios, instituciones y bloqueo de materias
- **Historial de auditoría** append-only: cada cambio de nota queda registrado
- **Sistema de roles**: Admin, Profesor, Preceptoría con permisos diferenciados
- **Trayectorias pedagógicas**: clasificación automática TEA / TEP / TED por promedio
- **Envío de Excel por correo** directamente desde el EXE (configurable con Nodemailer)
- **Backup y restauración** en formato JSON desde cualquier plataforma

---

## Arquitectura

```
programa para el colegio/
├── web/                        ← Código fuente (única fuente de verdad)
│   ├── index.html              ← Carga de notas (flujo principal)
│   ├── login.html              ← Autenticación Firebase
│   ├── admin.html              ← Panel de administración
│   ├── boletines.html          ← Generación de boletines
│   ├── estadisticas.html       ← Estadísticas y gráficos
│   ├── script.js               ← Lógica principal (~3700 líneas)
│   ├── auth.js                 ← Módulo de autenticación y roles
│   ├── db.js                   ← Módulo Firestore (CRUD completo)
│   ├── ganso-log.js            ← Logging estructurado (debug)
│   ├── firebase-config.js      ← Configuración Firebase (no commitear)
│   ├── styles.css              ← Estilos globales
│   ├── vendor/xlsx.full.min.js ← Librería Excel (SheetJS)
│   └── logos/                  ← Íconos y assets
│
├── ejecutable/electron/        ← App de escritorio (EXE)
│   ├── main.js                 ← Proceso principal Electron + Express
│   ├── sync.js                 ← Sincroniza web/ → electron/app/
│   ├── app/                    ← Copia sincronizada de web/ (generada)
│   └── dist/                   ← EXE compilado (generado)
│
├── android/                    ← App móvil (APK)
│   └── app/src/main/assets/public/ ← Assets web del APK
│
├── patch_apk.py                ← Build tool: parchea + firma el APK
├── firestore.rules             ← Reglas de seguridad Firestore
├── LICENSE                     ← Licencia propietaria
└── README.md                   ← Este archivo
```

### Flujo de persistencia

```
Usuario edita nota
       │
       ├─► localStorage (síncrono, inmediato)
       │
       └─► Firestore (async, debounce 300ms, retry x3)
                │
                └─► onSnapshot listener en otros dispositivos
                          │
                          └─► Auto-merge si no hay conflicto
                              Oferta de carga si el usuario está editando
```

---

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Frontend | HTML5, CSS3, JavaScript (ES2020, sin frameworks) |
| Autenticación | Firebase Authentication (email/contraseña) |
| Base de datos | Cloud Firestore (tiempo real + offline persistence) |
| Desktop | Electron v28 + Express (servidor local 127.0.0.1:3737) |
| Mobile | Capacitor v5 (WebView nativo Android) |
| Excel | SheetJS (xlsx.full.min.js) |
| Email | Nodemailer (solo EXE) |
| Build APK | Python (patch_apk.py) + zipalign + apksigner |

---

## Configuración inicial

### 1. Firebase

1. Crear un proyecto en [Firebase Console](https://console.firebase.google.com)
2. Activar **Authentication → Correo electrónico/contraseña**
3. Activar **Firestore Database** en modo producción
4. Aplicar las reglas de `firestore.rules` en **Firestore → Reglas**
5. Crear el índice compuesto en **Firestore → Índices**:
   - Colección: `history`
   - Campo 1: `institutionId` — Ascendente
   - Campo 2: `subject` — Ascendente
   - Campo 3: `serverTimestamp` — Descendente
6. Obtener la configuración web y completar `web/firebase-config.js`

### 2. Primer usuario administrador

En **Firebase Console → Authentication → Users**, crear un usuario y asignarle en **Firestore → users/{uid}**:

```json
{
  "name": "Nombre del administrador",
  "email": "admin@colegio.edu",
  "role": "admin",
  "institutionId": "id_de_la_institucion",
  "institutionName": "Nombre del Colegio"
}
```

### 3. Entornos de desarrollo

```bash
# EXE — desarrollo
cd ejecutable/electron
npm install
npm run electron:start

# EXE — build portable
npm run electron:make

# APK — build (desde la raíz)
python patch_apk.py
```

---

## Sistema de roles

| Rol | Descripción | Permisos |
|---|---|---|
| **Admin** | Administrador institucional | Todo: usuarios, instituciones, materias, bloqueos, exportación |
| **Profesor** | Docente | Cargar y editar notas de sus materias, exportar Excel |
| **Preceptoría** | Personal auxiliar | Ver notas, boletines y estadísticas (solo lectura) |

---

## Reglas de seguridad (Firestore)

Las reglas en `firestore.rules` implementan:

- **Aislamiento por institución**: ningún usuario puede leer o escribir datos de otra institución
- **Bloqueo de materia a nivel de base de datos**: si `locked == true`, solo el admin puede actualizar (refuerza la restricción que ya existe en la UI)
- **Historial append-only**: el registro de auditoría no puede ser modificado ni eliminado por ningún rol
- **Principio de mínimo privilegio**: cada colección tiene permisos granulares por operación (read / create / update / delete)

---

## Variables y constantes clave

| Constante | Valor | Descripción |
|---|---|---|
| `APP_VERSION` | 2 | Versión del formato de snapshot |
| `SCHEMA_VERSION` | 3 | Versión del esquema de datos |
| `STORAGE_KEY` | `notas_docente_estado_v2` | Clave legacy de localStorage |
| `PASS_THRESHOLD` | 6.5 | Umbral de aprobación |
| `TEA_MIN` | 7.0 | Mínimo para Trayectoria de Aprendizaje Acelerado |
| `TEP_MIN` | 4.0 | Mínimo para Trayectoria de Aprendizaje en Proceso |
| `FS_DEBOUNCE_MS` | 300 | Delay antes de escribir a Firestore |
| `FS_MAX_RETRIES` | 3 | Reintentos ante falla de red |
| `APK_REAUTH_MS` | 900000 | Re-autenticación APK tras 15 min en background |

---

## Seguridad implementada

- **Electron**: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`; navegación externa bloqueada; nuevas ventanas denegadas; rate limiting en `/send-email` (30/hora); sanitización de headers SMTP contra injection
- **APK**: re-login forzado si la app estuvo en background ≥ 15 minutos; sessionStorage limpiado al cerrar el proceso
- **Web/APK/EXE**: `sessionStorage.gp_authenticated` requerido en todas las páginas protegidas; `firebase.auth().signOut()` en cada apertura de login para evitar sesiones cacheadas

---

## Licencia

Copyright © 2026 Eliseo Ignacio Pérez de Villarreal. Todos los derechos reservados.

Este software es propietario. No se permite su reproducción, distribución, modificación ni uso comercial sin autorización escrita del autor.

Consultar el archivo [LICENSE](LICENSE) para los términos completos.

---

*Versión 1.0 — 2026*
