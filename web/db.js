// db.js — Módulo de base de datos Firestore
(function () {
    'use strict';

    function fs() { return firebase.firestore(); }

    function docId(institutionId, subject) {
        return `${clean(institutionId)}_${clean(subject)}`;
    }

    function clean(v) {
        return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_')
            .slice(0, 40).replace(/^_+|_+$/g, '') || 'x';
    }

    window.DB = {
        // ── Instituciones ─────────────────────────────────────────
        async getInstitutions() {
            const snap = await fs().collection('institutions').orderBy('name').get();
            return snap.docs.map(d => ({ id: d.id, ...d.data() }));
        },

        async saveInstitution(id, data) {
            await fs().collection('institutions').doc(id).set(data, { merge: true });
        },

        async deleteInstitution(id) {
            await fs().collection('institutions').doc(id).delete();
        },

        // ── Usuarios ──────────────────────────────────────────────
        async getUsers(institutionId) {
            if (!institutionId) {
                const snap = await fs().collection('users').get();
                return snap.docs.map(d => ({ id: d.id, ...d.data() }));
            }
            // Soporta ambos formatos: institutionIds[] (nuevo) e institutionId (legado).
            const [newFmt, oldFmt] = await Promise.all([
                fs().collection('users').where('institutionIds', 'array-contains', institutionId).get(),
                fs().collection('users').where('institutionId', '==', institutionId).get()
            ]);
            const map = new Map();
            newFmt.docs.forEach(d => map.set(d.id, { id: d.id, ...d.data() }));
            oldFmt.docs.forEach(d => { if (!map.has(d.id)) map.set(d.id, { id: d.id, ...d.data() }); });
            return [...map.values()];
        },

        async getUserByEmail(email) {
            const snap = await fs().collection('users').where('email', '==', email).limit(1).get();
            if (snap.empty) return null;
            return { id: snap.docs[0].id, ...snap.docs[0].data() };
        },

        // Agrega al usuario a una institución sin quitar las anteriores (arrayUnion).
        async addUserToInstitution(uid, institutionId, institutionName, data) {
            await fs().collection('users').doc(uid).set({
                ...data,
                institutionId,
                institutionName,
                institutionIds: firebase.firestore.FieldValue.arrayUnion(institutionId)
            }, { merge: true });
        },

        // Quita al usuario de una institución sin eliminar su perfil (arrayRemove).
        async removeUserFromInstitution(uid, institutionId) {
            await fs().collection('users').doc(uid).set({
                institutionIds: firebase.firestore.FieldValue.arrayRemove(institutionId)
            }, { merge: true });
        },

        // Obtiene los documentos de instituciones para una lista de IDs (multi-institución).
        async getInstitutionsForUser(institutionIds) {
            if (!institutionIds || !institutionIds.length) return [];
            const results = [];
            for (let i = 0; i < institutionIds.length; i += 10) {
                const batch = institutionIds.slice(i, i + 10);
                const snap = await fs().collection('institutions')
                    .where(firebase.firestore.FieldPath.documentId(), 'in', batch).get();
                snap.docs.forEach(d => results.push({ id: d.id, ...d.data() }));
            }
            return results.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'es'));
        },

        async saveUser(uid, data) {
            await fs().collection('users').doc(uid).set(data, { merge: true });
        },

        async deleteUser(uid) {
            await fs().collection('users').doc(uid).delete();
        },

        // ── Datos de materia (notas) ──────────────────────────────
        async loadSubjectData(institutionId, subject) {
            const doc = await fs().collection('subjectData').doc(docId(institutionId, subject)).get();
            return doc.exists ? doc.data() : null;
        },

        async saveSubjectData(institutionId, subject, snapshot, updatedAt) {
            const id  = docId(institutionId, subject);
            const ref = fs().collection('subjectData').doc(id);
            // Excluir lock fields (se manejan por separado) y historyRows/pendingHistoryRows
            // (arrays de arrays — Firestore no los soporta; la historia vive en su propia colección).
            const { locked, lockedBy, lockedByName, lockedAt,
                    historyRows, pendingHistoryRows,
                    studentOverrides,
                    ...dataFields } = snapshot;
            await ref.set({
                ...dataFields,
                institutionId,
                subject,
                updatedAt: updatedAt || new Date().toISOString()
            }, { merge: true });
        },

        async getSubjectMeta(institutionId, subject) {
            const doc = await fs().collection('subjectData').doc(docId(institutionId, subject)).get();
            if (!doc.exists) return { locked: false, lockedBy: null, lockedByName: null, lockedAt: null };
            const d = doc.data();
            return { locked: !!d.locked, lockedBy: d.lockedBy || null, lockedByName: d.lockedByName || null, lockedAt: d.lockedAt || null };
        },

        async setLocked(institutionId, subject, locked, userId, userName) {
            const id = docId(institutionId, subject);
            const doc = await fs().collection('subjectData').doc(id).get();
            if (!doc.exists) return;
            await fs().collection('subjectData').doc(id).update({
                locked,
                lockedBy: locked ? userId : null,
                lockedByName: locked ? userName : null,
                lockedAt: locked ? new Date().toISOString() : null
            });
        },

        async getSubjectsForInstitution(institutionId) {
            const snap = await fs().collection('subjectData')
                .where('institutionId', '==', institutionId).get();
            return snap.docs.map(d => ({
                id: d.id,
                subject: d.data().subject,
                locked: d.data().locked || false,
                updatedAt: d.data().updatedAt || '',
                courseCount: (d.data().courses || []).length,
                studentCount: Object.values(d.data().students || {}).reduce((a, arr) => a + arr.length, 0)
            }));
        },

        // ── Gestión de alumnos (cross-materia) ───────────────────
        async getCoursesForInstitution(institutionId) {
            const snap = await fs().collection('subjectData')
                .where('institutionId', '==', institutionId).get();
            if (snap.empty) return [];
            // Aggregate courses from all subject docs — any doc could have extra courses
            const courseSet = new Set();
            snap.docs.forEach(doc => {
                (doc.data().courses || []).forEach(c => courseSet.add(c));
            });
            return [...courseSet].sort();
        },

        async getStudentsForCourse(institutionId, course) {
            const snap = await fs().collection('subjectData')
                .where('institutionId', '==', institutionId).get();
            // Aggregate students from ALL subject docs for this course and deduplicate.
            // Different subjects can have different student lists if manual additions
            // happened to one subject but not all; the union is the authoritative list.
            const seen = new Set();
            snap.docs.forEach(doc => {
                (doc.data().students?.[course] || []).forEach(s => seen.add(s));
            });
            return [...seen].sort();
        },

        async addStudentToAllSubjects(institutionId, course, studentName) {
            const gradeColumns = ['Nota 1','Nota 2','Nota 3','Nota 4','Nota 5','Nota 6'];
            const nameLower    = studentName.toLowerCase();
            const snap = await fs().collection('subjectData')
                .where('institutionId', '==', institutionId).get();
            if (snap.empty) return 0;
            const batch = fs().batch();
            let count = 0;
            snap.docs.forEach(doc => {
                const data = doc.data();
                if (!(data.courses || []).includes(course)) return;
                const currentStudents = data.students?.[course] || [];
                if (currentStudents.some(s => s.toLowerCase() === nameLower)) return;
                const newStudents = [...currentStudents, studentName].sort();
                const newCourseRecords = { ...(data.records?.[course] || {}) };
                newCourseRecords[studentName] = {
                    number: newStudents.indexOf(studentName) + 1,
                    grades: Object.fromEntries(gradeColumns.map(c => [c, ''])),
                    average: '', updatedAt: '', notes: '', status: ''
                };
                // Renumerar registros existentes tras inserción con sort
                newStudents.forEach((s, i) => {
                    if (newCourseRecords[s]) newCourseRecords[s].number = i + 1;
                });
                // Actualizar studentOverrides: agregar a additions, quitar de removals
                const curOverrides  = data.studentOverrides || { additions: {}, removals: {} };
                const curAdditions  = Array.isArray(curOverrides.additions?.[course]) ? [...curOverrides.additions[course]] : [];
                const curRemovals   = Array.isArray(curOverrides.removals?.[course])  ? [...curOverrides.removals[course]]  : [];
                if (!curAdditions.some(s => s.toLowerCase() === nameLower)) curAdditions.push(studentName);
                const newRemovals   = curRemovals.filter(s => s.toLowerCase() !== nameLower);
                const newOverrides  = {
                    ...curOverrides,
                    additions: { ...curOverrides.additions, [course]: curAdditions },
                    removals:  { ...curOverrides.removals,  [course]: newRemovals  },
                };
                batch.update(doc.ref, {
                    students:         { ...data.students, [course]: newStudents },
                    records:          { ...data.records,  [course]: newCourseRecords },
                    studentOverrides: newOverrides,
                    updatedAt:        new Date().toISOString()
                });
                count++;
            });
            await batch.commit();
            return count;
        },

        // Versión bulk de addStudentToAllSubjects: agrega varios alumnos en una sola
        // query + batch para evitar race conditions cuando el usuario agrega 2+ alumnos
        // simultáneamente (el patrón Promise.all anterior hacía N queries y N commits
        // independientes sobre el mismo snapshot, y el último sobreescribía a los anteriores).
        async addStudentsToAllSubjects(institutionId, course, studentNames) {
            if (!studentNames || !studentNames.length) return 0;
            const gradeColumns = ['Nota 1','Nota 2','Nota 3','Nota 4','Nota 5','Nota 6'];
            const snap = await fs().collection('subjectData')
                .where('institutionId', '==', institutionId).get();
            if (snap.empty) return 0;
            const batch = fs().batch();
            let count = 0;
            snap.docs.forEach(doc => {
                const data = doc.data();
                if (!(data.courses || []).includes(course)) return;
                let currentStudents = [...(data.students?.[course] || [])];
                const newCourseRecords = { ...(data.records?.[course] || {}) };
                const curOverrides = data.studentOverrides || { additions: {}, removals: {} };
                let curAdditions   = Array.isArray(curOverrides.additions?.[course]) ? [...curOverrides.additions[course]] : [];
                let curRemovals    = Array.isArray(curOverrides.removals?.[course])  ? [...curOverrides.removals[course]]  : [];
                let changed = false;
                studentNames.forEach(studentName => {
                    const nameLower = studentName.toLowerCase();
                    if (currentStudents.some(s => s.toLowerCase() === nameLower)) return;
                    currentStudents = [...currentStudents, studentName].sort();
                    newCourseRecords[studentName] = {
                        number: 0,
                        grades: Object.fromEntries(gradeColumns.map(c => [c, ''])),
                        average: '', updatedAt: '', notes: '', status: ''
                    };
                    if (!curAdditions.some(s => s.toLowerCase() === nameLower)) curAdditions.push(studentName);
                    curRemovals = curRemovals.filter(s => s.toLowerCase() !== nameLower);
                    changed = true;
                });
                if (!changed) return;
                // Renumerar todos los registros una vez al final (más eficiente que por alumno)
                currentStudents.forEach((s, i) => {
                    if (newCourseRecords[s]) newCourseRecords[s].number = i + 1;
                });
                const newOverrides = {
                    ...curOverrides,
                    additions: { ...curOverrides.additions, [course]: curAdditions },
                    removals:  { ...curOverrides.removals,  [course]: curRemovals  },
                };
                batch.update(doc.ref, {
                    students:         { ...data.students, [course]: currentStudents },
                    records:          { ...data.records,  [course]: newCourseRecords },
                    studentOverrides: newOverrides,
                    updatedAt:        new Date().toISOString()
                });
                count++;
            });
            await batch.commit();
            return count;
        },

        async removeStudentFromAllSubjects(institutionId, course, studentName) {
            const nameLower = studentName.toLowerCase();
            const snap = await fs().collection('subjectData')
                .where('institutionId', '==', institutionId).get();
            if (snap.empty) return 0;
            const batch = fs().batch();
            let count = 0;
            snap.docs.forEach(doc => {
                const data = doc.data();
                // Procesar todos los docs que tengan el curso (aunque el alumno no esté en students)
                const hasCourse = (data.courses || []).includes(course) ||
                                  Object.keys(data.students || {}).includes(course);
                if (!hasCourse) return;

                // Actualizar studentOverrides: agregar a removals, quitar de additions
                const curOverrides = data.studentOverrides || { additions: {}, removals: {} };
                const curAdditions = Array.isArray(curOverrides.additions?.[course]) ? [...curOverrides.additions[course]] : [];
                const curRemovals  = Array.isArray(curOverrides.removals?.[course])  ? [...curOverrides.removals[course]]  : [];
                const newAdditions = curAdditions.filter(s => s.toLowerCase() !== nameLower);
                if (!curRemovals.some(s => s.toLowerCase() === nameLower)) curRemovals.push(studentName);
                const newOverrides = {
                    ...curOverrides,
                    additions: { ...curOverrides.additions, [course]: newAdditions },
                    removals:  { ...curOverrides.removals,  [course]: curRemovals  },
                };

                const updateData = {
                    studentOverrides: newOverrides,
                    updatedAt:        new Date().toISOString(),
                };

                // Si el alumno está en la lista, también removerlo de students y records
                const currentStudents = data.students?.[course] || [];
                const match = currentStudents.find(s => s.toLowerCase() === nameLower);
                if (match) {
                    const newStudents = currentStudents.filter(s => s.toLowerCase() !== nameLower);
                    const newCourseRecords = { ...(data.records?.[course] || {}) };
                    delete newCourseRecords[match];
                    // Renumerar tras eliminación
                    newStudents.forEach((s, i) => {
                        if (newCourseRecords[s]) newCourseRecords[s].number = i + 1;
                    });
                    updateData.students = { ...data.students, [course]: newStudents };
                    updateData.records  = { ...data.records,  [course]: newCourseRecords };
                }

                batch.update(doc.ref, updateData);
                count++;
            });
            await batch.commit();
            return count;
        },

        // ── Inicialización de materia ─────────────────────────────
        async initializeSubject(institutionId, subject, selectedCourses, studentsPerCourse = 30) {
            const id = docId(institutionId, subject);
            const existing = await fs().collection('subjectData').doc(id).get();
            if (existing.exists) return false;

            const courses = (Array.isArray(selectedCourses) && selectedCourses.length > 0)
                ? selectedCourses
                : ['1ero','2do','3ero','4to','5to','6to'];
            const gradeColumns = ['Nota 1','Nota 2','Nota 3','Nota 4','Nota 5','Nota 6'];
            const maleNames   = ['Lautaro','Santiago','Mateo','Thiago','Valentín','Facundo','Agustín','Ezequiel','Ignacio','Nicolás','Federico','Rodrigo','Marcos','Lucas','Martín','Pablo','Sebastián','Andrés','Diego','Alejandro','Gabriel','Ramiro','Emiliano','Leandro','Maximiliano'];
            const femaleNames = ['Valentina','Sofía','Camila','Lucía','Martina','Florencia','Agustina','Guadalupe','Valeria','Antonella','Catalina','Julieta','Micaela','Rocío','Luisina','Milagros','Aldana','Brenda','Natalia','Celeste'];
            const lastNames   = ['García','González','Rodríguez','López','Martínez','Hernández','Pérez','Sánchez','Ramírez','Flores','Torres','Morales','Romero','Álvarez','Díaz','Ruiz','Méndez','Muñoz','Alonso','Ramos','Vega','Medina','Castro','Ortega','Molina','Suárez','Domínguez','Vargas','Fuentes','Ríos'];

            function randomStudents(count) {
                const used = new Set();
                const list = [];
                let attempts = 0;
                while (list.length < count && attempts < 3000) {
                    attempts++;
                    const isF  = Math.random() < 0.5;
                    const first = isF ? femaleNames[Math.floor(Math.random() * femaleNames.length)]
                                     : maleNames[Math.floor(Math.random() * maleNames.length)];
                    const l1   = lastNames[Math.floor(Math.random() * lastNames.length)];
                    const l2   = lastNames[Math.floor(Math.random() * lastNames.length)];
                    const name = `${l1} ${l2}, ${first}`;
                    if (!used.has(name)) { used.add(name); list.push(name); }
                }
                return list.sort();
            }

            // Pull existing student lists from other subjects in this institution
            const existingSnap = await fs().collection('subjectData')
                .where('institutionId', '==', institutionId).get();
            const existingByCourse = {};
            existingSnap.docs.forEach(doc => {
                const studs = doc.data().students || {};
                Object.keys(studs).forEach(course => {
                    if (!existingByCourse[course] && (studs[course] || []).length > 0) {
                        existingByCourse[course] = [...studs[course]];
                    }
                });
            });

            const students = {};
            const records  = {};
            const existingCourses = [];
            const randomCourses   = [];

            courses.forEach(course => {
                let list;
                if (existingByCourse[course] && existingByCourse[course].length > 0) {
                    list = [...existingByCourse[course]];
                    existingCourses.push(course);
                } else {
                    list = randomStudents(studentsPerCourse);
                    randomCourses.push(course);
                }
                students[course] = list;
                records[course]  = {};
                list.forEach((s, i) => {
                    records[course][s] = {
                        number: i + 1,
                        grades: Object.fromEntries(gradeColumns.map(c => [c, ''])),
                        average: '', updatedAt: '', notes: '', status: ''
                    };
                });
            });

            await fs().collection('subjectData').doc(id).set({
                institutionId, subject, courses, students, records,
                studentOverrides: { additions: {}, removals: {} },
                locked: false, lockedBy: null, lockedByName: null, lockedAt: null,
                updatedAt: new Date().toISOString(),
                lastSavedAt: new Date().toLocaleDateString('es-AR')
            });
            return { courses: courses.length, existingCourses, randomCourses };
        },

        async deleteSubjectData(institutionId, subject) {
            await fs().collection('subjectData').doc(docId(institutionId, subject)).delete();
        },

        // ── Historial ─────────────────────────────────────────────
        async logHistory(institutionId, subject, entry) {
            await fs().collection('history').add({
                ...entry,
                institutionId,
                subject,
                serverTimestamp: firebase.firestore.FieldValue.serverTimestamp()
            });
        },

        async getHistory(institutionId, subject, limitCount = 300) {
            const snap = await fs().collection('history')
                .where('institutionId', '==', institutionId)
                .where('subject', '==', subject)
                .orderBy('serverTimestamp', 'desc')
                .limit(limitCount)
                .get();
            return snap.docs.map(d => ({ id: d.id, ...d.data() }));
        },

        // ── Carga masiva (boletines / estadísticas) ────────────────
        async getAllSubjectDataForInstitution(institutionId) {
            const snap = await fs().collection('subjectData')
                .where('institutionId', '==', institutionId).get();
            return snap.docs.map(d => ({ id: d.id, ...d.data() }));
        },

        // ── Listener en tiempo real ────────────────────────────────
        // Retorna la función unsubscribe. Usar { includeMetadataChanges: true }
        // para poder distinguir escrituras propias (hasPendingWrites) de remotas.
        subscribeToSubject(institutionId, subject, callback) {
            return fs().collection('subjectData')
                .doc(docId(institutionId, subject))
                .onSnapshot({ includeMetadataChanges: true }, callback, () => {});
        },

        // Listener a nivel colección: dispara cuando cualquier materia de la
        // institución cambia. Usado por boletines y estadísticas para auto-refrescar
        // sin que el usuario tenga que recargar manualmente.
        // Retorna la función unsubscribe.
        subscribeToInstitutionSubjects(institutionId, callback) {
            return fs().collection('subjectData')
                .where('institutionId', '==', institutionId)
                .onSnapshot(callback, () => {});
        }
    };
})();
