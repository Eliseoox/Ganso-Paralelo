    'use strict';
    const $ = id => document.getElementById(id);
    let toastTimer;

    function showToast(msg, dur = 3500) {
        const t = $('toast');
        clearTimeout(toastTimer);
        t.textContent = msg;
        t.classList.add('visible');
        toastTimer = setTimeout(() => t.classList.remove('visible'), dur);
    }

    function showNotice(type, msg) {
        const n = $('adminNotice');
        $('adminNoticeText').textContent = msg;
        n.className = `notice ${type}`;
        n.classList.remove('hidden');
        setTimeout(() => n.classList.add('hidden'), 5000);
    }

    function escHtml(v) {
        return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function confirmDialog(message, { confirmText = 'Confirmar', cancelText = 'Cancelar' } = {}) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'confirm-overlay';
            overlay.innerHTML = `
                <div class="confirm-card" role="dialog" aria-modal="true">
                    <p>${escHtml(message)}</p>
                    <div class="confirm-actions">
                        <button class="secondary-button confirm-cancel">${escHtml(cancelText)}</button>
                        <button class="danger-button confirm-ok">${escHtml(confirmText)}</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            const cleanup = (result) => { overlay.remove(); resolve(result); };
            overlay.querySelector('.confirm-ok').addEventListener('click', () => cleanup(true));
            overlay.querySelector('.confirm-cancel').addEventListener('click', () => cleanup(false));
            overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') cleanup(false); });
            overlay.querySelector('.confirm-ok').focus();
        });
    }

    // ── Auth ─────────────────────────────────────────────────────
    Auth.requireAuth(['admin']);

    let selectedInstId = '';

    function getSessionInst() {
        try { const r = sessionStorage.getItem('app_institution'); return r ? JSON.parse(r) : null; } catch(_) { return null; }
    }
    function setSessionInst(id, name) {
        try { sessionStorage.setItem('app_institution', JSON.stringify({ id, name })); } catch(_) {}
    }
    function clearSessionInst() {
        try { sessionStorage.removeItem('app_institution'); } catch(_) {}
    }

    Auth.onReady(profile => {
        if (!profile) return;
        $('adminName').textContent = Auth.getName();
        const instName = Auth.getInstitutionName();
        if (instName && $('instLabel')) $('instLabel').textContent = instName;
        loadInstitutions();
        const saved = getSessionInst();
        if (saved) selectInstitution(saved.id, saved.name);
        // else: picker screen stays visible (default)
    });

    $('logoutButton').addEventListener('click', () => Auth.signOut());

    // ── Tabs ──────────────────────────────────────────────────────
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            $('tab-' + btn.dataset.tab).classList.add('active');
        });
    });

    // ── Selector de institución ───────────────────────────────────
    function selectInstitution(id, name) {
        setSessionInst(id, name);
        selectedInstId = id;

        // Actualizar barra de contexto
        $('selectedInstName').textContent    = name || id;
        $('selectedInstIdDisplay').textContent = id;

        // Cambiar pantalla
        $('instPickerScreen').classList.add('hidden');
        $('adminContent').classList.remove('hidden');

        // Cargar todo automáticamente
        loadUsers();
        loadSubjects();
        loadCoursesIntoSelect(id, $('addStuCourse'));
        loadCoursesIntoSelect(id, $('rmStuCourse'));
        $('rmStudentListWrap').classList.add('hidden');
    }

    $('changeInstBtn').addEventListener('click', () => {
        clearSessionInst();
        $('adminContent').classList.add('hidden');
        $('instPickerScreen').classList.remove('hidden');
        selectedInstId = '';
        loadInstitutions();
    });

    // ── Instituciones ─────────────────────────────────────────────
    $('instForm').addEventListener('submit', async e => {
        e.preventDefault();
        const id   = $('instId').value.trim().replace(/\s+/g,'_').toLowerCase();
        const name = $('instName').value.trim();
        if (!id || !name) { showToast('Completá nombre e ID.'); return; }
        try {
            await DB.saveInstitution(id, { name });
            showToast('Institución guardada.');
            $('instForm').reset();
            loadInstitutions();
        } catch(err) { showToast('Error al guardar: ' + err.message); }
    });

    async function loadInstitutions() {
        const wrap = $('instTableWrap');
        wrap.innerHTML = '<div style="padding:18px;color:var(--muted);">Cargando...</div>';
        try {
            const insts = await DB.getInstitutions();
            if (!insts.length) {
                wrap.innerHTML = '<div style="padding:18px;color:var(--muted);">Sin instituciones registradas. Usá el formulario de abajo para agregar una.</div>';
                return;
            }
            wrap.innerHTML = `<div class="inst-cards-grid">
                ${insts.map(i => `
                    <div class="inst-card" data-action="select-inst" data-id="${escHtml(i.id)}" data-name="${escHtml(i.name)}">
                        <div class="inst-card-name">${escHtml(i.name)}</div>
                        <code class="inst-card-id">${escHtml(i.id)}</code>
                        <p class="inst-click-hint">Clic para seleccionar →</p>
                        <button class="action-btn danger inst-delete-btn" data-action="delete-inst" data-id="${escHtml(i.id)}">Eliminar</button>
                    </div>`).join('')}
            </div>`;
            wrap.querySelectorAll('[data-action="select-inst"]').forEach(card => {
                card.addEventListener('click', () => selectInstitution(card.dataset.id, card.dataset.name));
            });
            wrap.querySelectorAll('[data-action="delete-inst"]').forEach(btn => {
                btn.addEventListener('click', e => { e.stopPropagation(); deleteInst(btn.dataset.id); });
            });
        } catch(err) { wrap.innerHTML = `<div style="padding:18px;color:var(--danger);">Error al cargar: ${escHtml(err.message)}</div>`; }
    }

    async function deleteInst(id) {
        if (!await confirmDialog(`¿Eliminar la institución "${id}"?\nNo se borran los datos de materias.`, { confirmText: 'Sí, eliminar', cancelText: 'Cancelar' })) return;
        try { await DB.deleteInstitution(id); showToast('Institución eliminada.'); loadInstitutions(); }
        catch(err) { showToast('Error: ' + err.message); }
    }

    // ── Usuarios ──────────────────────────────────────────────────
    $('addUserForm').addEventListener('submit', async e => {
        e.preventDefault();
        const name  = $('newUserName').value.trim();
        const email = $('newUserEmail').value.trim();
        const pass  = $('newUserPass').value;
        const role  = $('newUserRole').value;
        if (!name||!email||!pass||!selectedInstId) { showToast('Seleccioná una institución y completá todos los campos.'); return; }
        const btn = $('addUserBtn');
        btn.disabled = true; btn.textContent = 'Creando...';
        try {
            let instName = selectedInstId;
            try { const doc = await firebase.firestore().collection('institutions').doc(selectedInstId).get(); if(doc.exists) instName = doc.data().name; } catch(_){}

            let uid;
            try {
                uid = await Auth.createUser(email, pass);
            } catch(authErr) {
                if (authErr.code === 'auth/email-already-in-use') {
                    // El correo ya tiene cuenta en Firebase Auth.
                    // Buscamos el perfil en Firestore para poder reasignarlo a esta institución.
                    btn.textContent = 'Buscando perfil...';
                    const existing = await DB.getUserByEmail(email);
                    if (!existing) {
                        showToast('Ese correo ya tiene cuenta de acceso pero no tiene perfil en el sistema. Contactá al soporte.');
                        return;
                    }
                    const fromInsts = Array.isArray(existing.institutionIds) && existing.institutionIds.length
                        ? existing.institutionIds.join(', ')
                        : (existing.institutionName || existing.institutionId || 'otra institución');
                    if (!await confirmDialog(`"${email}" ya existe en: ${fromInsts}.\n¿Querés agregarlo a esta institución también?\n\nSe actualizarán nombre y rol. La contraseña no cambia.`, { confirmText: 'Sí, agregar', cancelText: 'Cancelar' })) return;
                    await DB.addUserToInstitution(existing.id, selectedInstId, instName, { name, email, role });
                    showToast(`"${name}" agregado a esta institución correctamente.`);
                    $('addUserForm').reset();
                    loadUsers();
                    return;
                }
                throw authErr;
            }

            await DB.saveUser(uid, { name, email, role, institutionId: selectedInstId, institutionName: instName, institutionIds: [selectedInstId], createdAt: new Date().toISOString() });
            showToast(`Usuario "${name}" creado correctamente.`);
            $('addUserForm').reset();
            loadUsers();
        } catch(err) {
            const msgs = {
                'auth/invalid-email': 'El correo no es válido.',
                'auth/weak-password': 'La contraseña es muy débil (mínimo 6 caracteres).'
            };
            showToast(msgs[err.code] || 'Error: ' + err.message);
        } finally {
            btn.disabled = false; btn.textContent = 'Crear usuario';
        }
    });

    async function loadUsers() {
        const wrap = $('usersTableWrap');
        if (!selectedInstId) {
            wrap.innerHTML = '<div style="padding:18px;color:var(--muted);">Seleccioná una institución para ver sus usuarios.</div>';
            return;
        }
        wrap.innerHTML = '<div style="padding:18px;color:var(--muted);">Cargando...</div>';
        try {
            const users = await DB.getUsers(selectedInstId);
            if (!users.length) { wrap.innerHTML = '<div style="padding:18px;color:var(--muted);">Sin usuarios registrados aún.</div>'; return; }
            wrap.innerHTML = `
                <table class="data-table">
                    <thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Institución</th><th></th></tr></thead>
                    <tbody>
                        ${users.map(u => `
                            <tr>
                                <td>${escHtml(u.name||'-')}</td>
                                <td>${escHtml(u.email||'-')}</td>
                                <td>
                                    <select class="role-select" data-uid="${escHtml(u.id)}" style="min-height:32px;padding:0 8px;font-size:13px;">
                                        <option value="admin"       ${u.role==='admin'?'selected':''}>Administrador</option>
                                        <option value="profesor"    ${u.role==='profesor'?'selected':''}>Profesor</option>
                                        <option value="preceptoria" ${u.role==='preceptoria'?'selected':''}>Preceptoría</option>
                                    </select>
                                </td>
                                <td>${escHtml(Array.isArray(u.institutionIds) && u.institutionIds.length ? u.institutionIds.join(', ') : (u.institutionName||u.institutionId||'-'))}</td>
                                <td style="display:flex;gap:6px;">
                                    <button class="action-btn" data-action="save-role" data-uid="${escHtml(u.id)}">Guardar rol</button>
                                    <button class="action-btn danger" data-action="remove-user" data-uid="${escHtml(u.id)}" data-name="${escHtml(u.name||u.email)}">Quitar</button>
                                </td>
                            </tr>`).join('')}
                    </tbody>
                </table>`;
            wrap.querySelectorAll('[data-action="save-role"]').forEach(btn => {
                btn.addEventListener('click', () => saveUserRole(btn.dataset.uid, btn));
            });
            wrap.querySelectorAll('[data-action="remove-user"]').forEach(btn => {
                btn.addEventListener('click', () => removeUser(btn.dataset.uid, btn.dataset.name));
            });
        } catch(err) { wrap.innerHTML = `<div style="padding:18px;color:var(--danger);">Error: ${escHtml(err.message)}</div>`; }
    }

    async function saveUserRole(uid, btn) {
        const select = btn.closest('tr').querySelector('.role-select');
        const role   = select.value;
        btn.disabled = true; btn.textContent = '...';
        try { await DB.saveUser(uid, { role }); showToast('Rol actualizado.'); }
        catch(err) { showToast('Error: ' + err.message); }
        finally { btn.disabled = false; btn.textContent = 'Guardar rol'; }
    }

    async function removeUser(uid, name) {
        if (!await confirmDialog(`¿Quitar a "${name}" de esta institución?\n\nEl usuario conserva acceso a sus otras instituciones. Su cuenta de acceso no se elimina.`, { confirmText: 'Sí, quitar', cancelText: 'Cancelar' })) return;
        try {
            await DB.removeUserFromInstitution(uid, selectedInstId);
            showToast(`"${name}" quitado de esta institución.`);
            loadUsers();
        } catch(err) { showToast('Error: ' + err.message); }
    }

    // ── Materias ──────────────────────────────────────────────────
    $('loadSubjectsBtn').addEventListener('click', loadSubjects);

    async function loadSubjects() {
        if (!selectedInstId) return;
        const wrap = $('subjectsTableWrap');
        wrap.innerHTML = '<div style="padding:18px;"><span class="spinner"></span> Cargando...</div>';
        try {
            const subjects = await DB.getSubjectsForInstitution(selectedInstId);
            if (!subjects.length) { wrap.innerHTML = '<div style="padding:18px;color:var(--muted);">Sin materias para esta institución.</div>'; return; }
            wrap.innerHTML = `
                <table class="data-table">
                    <thead><tr><th>Materia</th><th>Cursos</th><th>Alumnos</th><th>Última actualización</th><th>Estado</th><th></th></tr></thead>
                    <tbody>
                        ${subjects.map(s => `
                            <tr>
                                <td><strong>${escHtml(s.subject)}</strong></td>
                                <td>${s.courseCount}</td>
                                <td>${s.studentCount}</td>
                                <td>${s.updatedAt ? escHtml(s.updatedAt.slice(0,10)) : '-'}</td>
                                <td>${s.locked
                                    ? '<span class="lock-badge" style="font-size:12px;min-height:28px;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Bloqueada</span>'
                                    : '<span style="color:var(--muted);font-size:13px;">Editable</span>'}</td>
                                <td style="display:flex;gap:6px;flex-wrap:wrap;">
                                    <button class="action-btn" data-action="toggle-lock" data-inst="${escHtml(selectedInstId)}" data-subject="${escHtml(s.subject)}" data-locked="${s.locked ? '1' : '0'}">
                                        ${s.locked ? 'Desbloquear' : 'Bloquear'}
                                    </button>
                                    <button class="action-btn danger" data-action="delete-subject" data-inst="${escHtml(selectedInstId)}" data-subject="${escHtml(s.subject)}">
                                        Eliminar
                                    </button>
                                </td>
                            </tr>`).join('')}
                    </tbody>
                </table>`;
            wrap.querySelectorAll('[data-action="toggle-lock"]').forEach(btn => {
                btn.addEventListener('click', () => toggleLock(btn.dataset.inst, btn.dataset.subject, btn.dataset.locked === '1', btn));
            });
            wrap.querySelectorAll('[data-action="delete-subject"]').forEach(btn => {
                btn.addEventListener('click', () => deleteSubject(btn.dataset.inst, btn.dataset.subject, btn));
            });
        } catch(err) { wrap.innerHTML = `<div style="padding:18px;color:var(--danger);">Error: ${escHtml(err.message)}</div>`; }
    }

    async function toggleLock(instId, subject, currentlyLocked, btn) {
        btn.disabled = true; btn.textContent = '...';
        try {
            await DB.setLocked(instId, subject, !currentlyLocked, Auth.getUser().uid, Auth.getName());
            showToast(!currentlyLocked ? `"${subject}" bloqueada para edición.` : `"${subject}" desbloqueada.`);
            loadSubjects();
        } catch(err) { showToast('Error: ' + err.message); btn.disabled = false; btn.textContent = currentlyLocked ? 'Desbloquear' : 'Bloquear'; }
    }

    async function deleteSubject(instId, subject, btn) {
        if (!await confirmDialog(`¿Eliminar la materia "${subject}"?\n\nSe borrarán todos los datos (alumnos, notas, historial).\nEsta acción no se puede deshacer.`, { confirmText: 'Sí, eliminar', cancelText: 'Cancelar' })) return;
        btn.disabled = true; btn.textContent = '...';
        try {
            await DB.deleteSubjectData(instId, subject);
            showNotice('ready', `Materia "${subject}" eliminada. Podés volver a inicializarla si es necesario.`);
            loadSubjects();
        } catch(err) {
            showToast('Error: ' + err.message);
            btn.disabled = false; btn.textContent = 'Eliminar';
        }
    }

    // ── Gestión de alumnos ────────────────────────────────────────
    const FIXED_COURSES = ["1ero","2do","3ero","4to","5to","6to"];

    function loadCoursesIntoSelect(instId, selectEl) {
        selectEl.innerHTML = FIXED_COURSES.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
    }

    $('loadRmStudentsBtn').addEventListener('click', async () => {
        const course = $('rmStuCourse').value;
        if (!selectedInstId || !course) { showToast('Elegí un curso.'); return; }
        const btn = $('loadRmStudentsBtn');
        btn.disabled = true; btn.textContent = 'Buscando...';
        try {
            const students = await DB.getStudentsForCourse(selectedInstId, course);
            if (!students.length) { showToast('No hay alumnos en ese curso.'); return; }
            const sel = $('rmStudentSelect');
            sel.innerHTML = students.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('');
            $('rmStudentListWrap').classList.remove('hidden');
        } catch(err) { showToast('Error: ' + err.message); }
        finally { btn.disabled = false; btn.textContent = 'Buscar alumnos'; }
    });

    $('addStudentForm').addEventListener('submit', async e => {
        e.preventDefault();
        const course    = $('addStuCourse').value;
        const lastName  = $('addStuLastName').value.trim();
        const firstName = $('addStuFirstName').value.trim();
        if (!selectedInstId || !course || !lastName || !firstName) {
            showToast('Completá todos los campos.');
            return;
        }
        const studentName = `${lastName}, ${firstName}`;
        const btn = $('addStudentBtn');
        btn.disabled = true; btn.textContent = 'Agregando...';
        try {
            const count = await DB.addStudentToAllSubjects(selectedInstId, course, studentName);
            if (count > 0) {
                showNotice('ready', `"${studentName}" agregado a ${count} materia(s) del curso ${course}.`);
                $('addStudentForm').reset();
                await loadCoursesIntoSelect(selectedInstId, $('addStuCourse'));
            } else {
                showToast(`El alumno ya existe en todas las materias del curso ${course}.`);
            }
        } catch(err) { showToast('Error: ' + err.message); }
        finally { btn.disabled = false; btn.textContent = 'Agregar alumno'; }
    });

    $('removeStudentFromAllBtn').addEventListener('click', async () => {
        const course      = $('rmStuCourse').value;
        const studentName = $('rmStudentSelect').value;
        if (!selectedInstId || !course || !studentName) { showToast('Seleccioná curso y alumno.'); return; }
        if (!await confirmDialog(`¿Quitar a "${studentName}" de todas las materias del curso ${course}?\nEsta acción no se puede deshacer.`, { confirmText: 'Sí, quitar', cancelText: 'Cancelar' })) return;
        const btn = $('removeStudentFromAllBtn');
        btn.disabled = true; btn.textContent = 'Quitando...';
        try {
            const count = await DB.removeStudentFromAllSubjects(selectedInstId, course, studentName);
            showNotice('ready', `"${studentName}" eliminado de ${count} materia(s) del curso ${course}.`);
            $('rmStudentListWrap').classList.add('hidden');
            await loadCoursesIntoSelect(selectedInstId, $('rmStuCourse'));
        } catch(err) { showToast('Error: ' + err.message); }
        finally { btn.disabled = false; btn.textContent = 'Quitar alumno de todas las materias'; }
    });

    // ── Inicializar materia ───────────────────────────────────────
    $('initSubjectForm').addEventListener('submit', async e => {
        e.preventDefault();
        const subject        = $('initSubjectName').value.trim();
        const perCourse      = parseInt($('initStudentsCount').value, 10) || 30;
        const selectedCourses = [...document.querySelectorAll('#initSubjectCourses input:checked')].map(cb => cb.value);
        if (!selectedInstId || !subject) { showToast('Completá el nombre de la materia.'); return; }
        if (!selectedCourses.length) { showToast('Seleccioná al menos un curso.'); return; }
        const btn = $('initSubjectBtn');
        btn.disabled = true; btn.textContent = 'Inicializando...';
        try {
            const result = await DB.initializeSubject(selectedInstId, subject, selectedCourses, perCourse);
            if (result) {
                const usedExisting = result.existingCourses.length > 0
                    ? ` Alumnos copiados en: ${result.existingCourses.join(', ')}.` : '';
                const usedRandom = result.randomCourses.length > 0
                    ? ` Alumnos aleatorios en: ${result.randomCourses.join(', ')}.` : '';
                showNotice('ready', `Materia "${subject}" inicializada para ${result.courses} curso(s).${usedExisting}${usedRandom}`);
                loadSubjects();
            } else {
                showToast(`La materia "${subject}" ya existe en el sistema. No se sobreescribieron los datos.`);
            }
        } catch(err) { showToast('Error al inicializar: ' + err.message); }
        finally { btn.disabled = false; btn.textContent = 'Inicializar materia'; }
    });
