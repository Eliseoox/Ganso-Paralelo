/* web/modules/email.js — envío de Excel por email (.exe, APK, web fallback) */
(function () {
    "use strict";

    let _electronMailCfg = null;

    // Carga la config pública del servidor de correo (solo .exe).
    // Solo cachea cuando está configurada; si no, deja null para reintentar.
    async function fetchConfig() {
        if (_electronMailCfg !== null) return _electronMailCfg;
        try {
            const res = await fetch("/mail-config");
            const cfg = await res.json();
            if (cfg.available) _electronMailCfg = cfg;
            return cfg;
        } catch (_) {
            return { available: false, defaultRecipients: [], messageTemplate: null };
        }
    }

    function arrayToBase64(arr) {
        const bytes = arr instanceof Uint8Array ? arr : new Uint8Array(arr);
        let b64 = "";
        const CHUNK = 8192;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            b64 += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
        }
        return btoa(b64);
    }

    function buildEmailBody(template) {
        const tpl = template ||
            "Estimado/a,\n\nAdjunto encontrará el archivo Excel con las notas de {materia}, año {anio}.\n\nEl documento contiene el registro completo de calificaciones de todos los cursos, actualizado a la fecha de envío.\n\nEste mensaje fue generado automáticamente por el sistema Ganso-Paralelo.\n\nSaludos cordiales,\n{remitente}";
        const remitente = (typeof Auth !== "undefined" && Auth.getUser)
            ? (Auth.getUser()?.displayName || Auth.getUser()?.email || "el/la docente")
            : "el/la docente";
        return tpl
            .replace(/{materia}/g, appState.subject || "la materia")
            .replace(/{anio}/g,    String(new Date().getFullYear()))
            .replace(/{remitente}/g, remitente);
    }

    // exportData = { data: Uint8Array|Array, fileName: string }
    async function share(exportData) {
        if (!exportData) { showToast("Primero generá el archivo."); return; }
        const { data, fileName } = exportData;
        const isElectron = navigator.userAgent.includes("Electron");

        // ── .exe: envío directo con Nodemailer ──────────────────────────────────
        if (isElectron) {
            const cfg       = await fetchConfig();
            const userEmail = (typeof Auth !== "undefined" && Auth.getUser) ? (Auth.getUser()?.email || "") : "";

            return new Promise(resolve => {
                const modal   = elements.shareEmailModal;
                const form    = elements.shareEmailForm;
                const input   = elements.shareEmailInput;
                const sendBtn = elements.shareEmailSendBtn;
                const cancel  = elements.cancelShareEmailBtn;
                if (!modal || !form || !input) { resolve(); return; }

                input.value = (cfg.defaultRecipients || [])[0] || userEmail;
                modal.classList.remove("hidden");
                input.focus();

                const datalist = document.getElementById("shareEmailList");
                if (datalist) {
                    const existing = new Set([...datalist.options].map(o => o.value));
                    (cfg.defaultRecipients || []).forEach(email => {
                        if (!existing.has(email)) {
                            const opt = document.createElement("option");
                            opt.value = email;
                            datalist.appendChild(opt);
                            existing.add(email);
                        }
                    });
                    if (userEmail && !existing.has(userEmail)) {
                        const opt = document.createElement("option");
                        opt.value = userEmail;
                        datalist.appendChild(opt);
                    }
                }

                function setSending(v) {
                    if (sendBtn) { sendBtn.disabled = v; sendBtn.textContent = v ? "Enviando…" : "Enviar"; }
                    if (cancel)  cancel.disabled = v;
                    if (input)   input.disabled  = v;
                }

                function closeModal() {
                    modal.classList.add("hidden");
                    setSending(false);
                    form.removeEventListener("submit", handleSubmit);
                    if (cancel) cancel.removeEventListener("click", handleCancel);
                }

                async function handleSubmit(e) {
                    e.preventDefault();
                    const toEmail = input.value.trim();
                    if (!toEmail) return;
                    setSending(true);
                    try {
                        if (!cfg.available) {
                            showToast("El envío automático no está configurado. Completá mail-config.json.");
                            setSending(false);
                            return;
                        }
                        const loggedUser     = (typeof Auth !== "undefined" && Auth.getUser) ? Auth.getUser() : null;
                        const senderFullName = (typeof Auth !== "undefined" && Auth.getName) ? Auth.getName() : null;
                        const resp = await fetch("/send-email", {
                            method:  "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                to:         toEmail,
                                subject:    `Notas de ${appState.subject || "materia"} — ${new Date().getFullYear()}`,
                                text:       buildEmailBody(cfg.messageTemplate),
                                filename:   fileName,
                                content:    arrayToBase64(data),
                                senderName: senderFullName || loggedUser?.email || null,
                                replyTo:    loggedUser?.email || null,
                            }),
                        });
                        const result = await resp.json();
                        if (result.ok) {
                            closeModal();
                            showToast(`Correo enviado a ${toEmail}`);
                            resolve(true);
                        } else {
                            showToast(result.message || "Error al enviar el correo. Intentá de nuevo.");
                            setSending(false);
                        }
                    } catch (_) {
                        showToast("Error de conexión con el servidor de correo.");
                        setSending(false);
                    }
                }

                function handleCancel() { closeModal(); resolve(true); }

                form.addEventListener("submit", handleSubmit);
                if (cancel) cancel.addEventListener("click", handleCancel);
            });
        }

        // ── APK/Web: Web Share API ─────────────────────────────────────────────
        if (typeof navigator.share === "function") {
            try {
                const file = new File([data], fileName, { type: EXCEL_MIME });
                await navigator.share({
                    files: [file],
                    title: fileName,
                    text:  `Notas de ${appState.subject || "materia"} — ${new Date().getFullYear()}`,
                });
                return false;
            } catch (err) {
                if (err.name === "AbortError") return false;
            }
        }

        // ── Fallback: abrir cliente de correo del sistema ──────────────────────
        const userEmail = (typeof Auth !== "undefined" && Auth.getUser) ? (Auth.getUser()?.email || "") : "";
        const subject   = encodeURIComponent(`Notas — ${appState.subject || "materia"} ${new Date().getFullYear()}`);
        const body      = encodeURIComponent(`Hola,\n\nAdjuntá el archivo de notas: ${fileName}\n\n— Ganso-Paralelo`);
        const a = document.createElement("a");
        a.href = `mailto:${userEmail}?subject=${subject}&body=${body}`;
        a.target = "_blank";
        document.body.appendChild(a);
        a.click();
        a.remove();
        showToast("Se abrió tu correo. Adjuntá el archivo descargado.");
        return false;
    }

    window.EmailModule = { fetchConfig, share };
})();
