# Guía de configuración — Sistema institucional de notas

## Paso 1: Crear proyecto en Firebase

1. Ir a https://console.firebase.google.com
2. Hacer clic en **"Crear un proyecto"**
3. Elegir un nombre (ej: `notas-colegio-sanpedro`)
4. Desactivar Google Analytics si no se necesita
5. Clic en **"Crear proyecto"**

---

## Paso 2: Activar Authentication

1. En el menú lateral: **Authentication > Sign-in method**
2. Hacer clic en **"Correo electrónico/contraseña"**
3. Activar la opción y guardar

---

## Paso 3: Activar Firestore Database

1. En el menú lateral: **Firestore Database**
2. Clic en **"Crear base de datos"**
3. Elegir **"Iniciar en modo de producción"**
4. Seleccionar la región más cercana (ej: `us-central1`)
5. Clic en **"Listo"**

### Configurar reglas de seguridad

En **Firestore > Reglas**, reemplazar el contenido con:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isAuth() { return request.auth != null; }
    function profile() {
      return get(/databases/$(database)/documents/users/$(request.auth.uid));
    }
    function role() { return profile().data.role; }
    function myInstId() { return profile().data.institutionId; }
    function isAdmin()  { return isAuth() && role() == 'admin'; }
    function canEdit()  { return isAuth() && role() in ['admin', 'profesor']; }

    match /users/{uid} {
      allow read:  if isAuth() && (request.auth.uid == uid || isAdmin());
      allow write: if isAdmin();
    }
    match /institutions/{id} {
      allow read:  if isAuth();
      allow write: if isAdmin();
    }
    match /subjectData/{id} {
      allow read:   if isAuth() && resource.data.institutionId == myInstId();
      allow create: if canEdit() && request.resource.data.institutionId == myInstId();
      allow update: if canEdit() && resource.data.institutionId == myInstId();
      allow delete: if isAdmin() && resource.data.institutionId == myInstId();
    }
    match /history/{id} {
      allow read:   if isAuth() && resource.data.institutionId == myInstId();
      allow create: if canEdit() && request.resource.data.institutionId == myInstId();
    }
  }
}
```

> **Nota técnica:** Las reglas usan `resource.data.institutionId` (campo del documento) para validar el acceso, lo que es compatible con las queries de colección que ya filtran por ese mismo campo. Las versiones anteriores que usaban `id.matches()` (basado en el ID del documento) eran incompatibles con queries y causaban errores de permisos.

Publicar las reglas con el botón **"Publicar"**.

### Crear el índice compuesto para el historial

El módulo de historial usa una query con dos filtros y ordenamiento:

```
collection: history
where: institutionId == "..."
where: subject == "..."
orderBy: serverTimestamp desc
```

Firestore requiere un índice compuesto para este tipo de query. Sin él, el historial solo muestra datos locales (falla silenciosamente).

**Pasos para crearlo:**

1. Ir a **Firestore > Índices > Compuestos**
2. Hacer clic en **"Agregar índice"**
3. Completar los campos:
   - **Colección:** `history`
   - **Campo 1:** `institutionId` — Ascendente
   - **Campo 2:** `subject` — Ascendente
   - **Campo 3:** `serverTimestamp` — Descendente
4. Hacer clic en **"Crear índice"** y esperar a que el estado sea **"Habilitado"** (puede tardar unos minutos)

> **Alternativa:** La primera vez que el historial falle, Firebase mostrará en la consola del navegador un enlace directo para crear el índice automáticamente. Buscá un error que empiece con `FirebaseError: The query requires an index`.

---

## Paso 4: Obtener la configuración de Firebase

1. En Firebase Console, ir a **Configuración del proyecto** (ícono de engranaje)
2. Ir a la sección **"Tus aplicaciones"**
3. Hacer clic en **"Agregar app" > icono Web (`</>`)**
4. Darle un nombre (ej: "Sistema de notas web")
5. No activar Firebase Hosting por ahora
6. Copiar el objeto `firebaseConfig`

---

## Paso 5: Configurar el archivo firebase-config.js

Abrir `web/firebase-config.js` y reemplazar los valores:

```javascript
const FIREBASE_CONFIG = {
    apiKey:            "tu-api-key",
    authDomain:        "tu-proyecto.firebaseapp.com",
    projectId:         "tu-proyecto-id",
    storageBucket:     "tu-proyecto.firebasestorage.app",
    messagingSenderId: "123456789",
    appId:             "1:123:web:abc123"
};
```

---

## Paso 6: Crear el primer usuario administrador

### Opción A: Desde Firebase Console (recomendado)

1. Ir a **Authentication > Users**
2. Clic en **"Agregar usuario"**
3. Ingresar correo y contraseña
4. Copiar el **UID** del usuario creado
5. Ir a **Firestore > Colecciones > Crear colección** llamada `users`
6. Crear un documento con el UID como ID:
   ```
   name:          "Tu nombre"
   email:         "tu@correo.com"
   role:          "admin"
   institutionId: "mi_colegio"
   institutionName: "Nombre del Colegio"
   ```

### Opción B: Desde el panel de admin

Una vez configurado Firebase, abrir `login.html` con el usuario admin, y desde `admin.html`:
- Crear la institución (ID: `mi_colegio`, Nombre: "Nombre del Colegio")
- Crear otros usuarios (profesores, preceptoría)

---

## Paso 7: Usar el sistema

### Flujo de trabajo

1. **Abrir** `login.html` en el navegador
2. **Ingresar** con correo y contraseña
3. **Seleccionar materia** (Paso 1)
4. **Cargar datos** desde el sistema o importar Excel (Paso 2)
5. **Cargar notas** por curso y alumno (Paso 3)
6. **Exportar** el Excel final (Paso 4)

### Roles

| Rol           | Puede hacer |
|---------------|-------------|
| **Admin**     | Todo: usuarios, materias, bloqueos, exportar |
| **Profesor**  | Cargar y editar notas de sus materias |
| **Preceptoría** | Ver notas y exportar (solo lectura) |

---

## Notas importantes

- **Umbral de aprobación:** promedio ≥ 6.5 → aprobado (verde), < 6.5 → desaprobado (rojo)
- **Exportación parcial:** se puede exportar aunque falten notas (pide confirmación)
- **Bloqueo de edición:** el admin puede bloquear una materia para evitar cambios
- **Backup:** el botón "Backup" descarga un JSON con todos los datos actuales
- **Restaurar backup:** subir el archivo JSON desde el menú de backup
- **Modo sin internet:** los datos se cachean localmente (Firebase offline persistence)
- **Modo local (sin Firebase):** si `firebase-config.js` no está configurado, el sistema funciona igual que antes (con localStorage)

---

## Estructura de archivos

```
web/
├── vendor/
│   └── xlsx.full.min.js     ← Librería Excel (no modificar)
├── logos/                    ← Íconos y logos (no modificar)
├── firebase-config.js        ← Tu configuración de Firebase
├── auth.js                   ← Módulo de autenticación
├── db.js                     ← Módulo de base de datos
├── login.html                ← Página de ingreso
├── index.html                ← Carga de notas (flujo principal)
├── admin.html                ← Panel de administración
├── boletines.html            ← Generación de boletines PDF
├── estadisticas.html         ← Estadísticas y gráficos
├── script.js                 ← Lógica principal
├── styles.css                ← Estilos
└── SETUP.md                  ← Esta guía
```
