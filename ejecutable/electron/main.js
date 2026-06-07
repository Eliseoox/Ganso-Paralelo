const { app, BrowserWindow, shell } = require('electron');
const express  = require('express');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');
const nodemailer = require('nodemailer');

const PORT = 3737;
let server = null;
let serverReady = false;

let _transporter = null;
let _transporterUser = null;

function getTransporter(cfg) {
    if (_transporter && _transporterUser === cfg.user) return _transporter;
    _transporter = nodemailer.createTransport({
        host:   cfg.host   || 'smtp.gmail.com',
        port:   cfg.port   || 465,
        secure: cfg.secure !== false,
        auth:   { user: cfg.user, pass: cfg.pass },
        pool:   true,
        maxConnections: 2,
    });
    _transporterUser = cfg.user;
    return _transporter;
}

function readMailConfig() {
    const configPath = path.join(__dirname, 'mail-config.json');
    if (!fs.existsSync(configPath)) return null;
    try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch { return null; }
}

// ── Seguridad: rate limiter para /send-email ──────────────────────────────────
// Máx 30 envíos por hora (por sesión del proceso). Protege las credenciales SMTP
// contra abuso local en caso de bug, script externo o error del usuario.
const _emailWindow = { count: 0, start: Date.now() };
const EMAIL_RATE_MAX = 30;
const EMAIL_RATE_MS  = 60 * 60 * 1000; // 1 hora

function emailRateAllowed() {
    const now = Date.now();
    if (now - _emailWindow.start > EMAIL_RATE_MS) {
        _emailWindow.count = 0;
        _emailWindow.start = now;
    }
    if (_emailWindow.count >= EMAIL_RATE_MAX) return false;
    _emailWindow.count++;
    return true;
}

// Elimina CR/LF/TAB para prevenir SMTP header injection.
// Un \r\n en el asunto o destinatario permite inyectar headers SMTP arbitrarios.
function sanitizeHeader(v) {
    return String(v ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 500);
}

// Validación de dirección de correo (formato básico pero suficiente)
function isValidEmail(addr) {
    return /^[^\s@,;:<>()\[\]]{1,64}@[^\s@,;:<>()\[\]]{1,253}$/.test(addr.trim());
}

// Valida el body de /send-email antes de usar cualquier campo
function validateEmailRequest({ to, subject, content, filename } = {}) {
    if (!to || typeof to !== 'string') return 'Destinatario requerido.';
    const recipients = to.split(',').map(s => s.trim()).filter(Boolean);
    if (recipients.length === 0 || recipients.length > 5)
        return 'Número de destinatarios inválido (máx 5).';
    if (!recipients.every(isValidEmail))
        return 'Una o más direcciones de correo son inválidas.';
    if (typeof subject !== 'string' || subject.length > 300)
        return 'Asunto inválido o demasiado largo.';
    if (!content || typeof content !== 'string' || content.length > 20_000_000)
        return 'Contenido vacío o demasiado grande (máx ~15 MB).';
    if (!filename || typeof filename !== 'string'
        || /[/\\<>:"|?*\x00-\x1f]/.test(filename) || filename.length > 120)
        return 'Nombre de archivo inválido.';
    return null;
}

function startServer() {
    return new Promise((resolve, reject) => {
        const webApp = express();

        // Cabeceras de seguridad mínimas para todas las respuestas
        webApp.use((_req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'SAMEORIGIN');
            res.setHeader('Content-Security-Policy',
                "default-src 'self' 127.0.0.1:3737; " +
                "script-src 'self' https://www.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; " +
                "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com; " +
                "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
                "font-src 'self' https://fonts.gstatic.com; " +
                "img-src 'self' data:; " +
                "frame-src 'none';"
            );
            next();
        });

        webApp.use(express.static(path.join(__dirname, 'app'), {
            maxAge: 0,
            etag: false,
            lastModified: false,
            setHeaders: (res) => {
                res.setHeader('Cache-Control', 'no-store');
            },
        }));

        webApp.use(express.json({ limit: '15mb' }));

        // Devuelve la configuración pública (sin credenciales) para el renderer
        webApp.get('/mail-config', (req, res) => {
            const cfg = readMailConfig();
            if (!cfg) return res.json({ available: false, defaultRecipients: [], messageTemplate: null });
            const configured = !!(cfg.user && cfg.pass
                && cfg.user !== 'tu.correo@gmail.com'
                && cfg.pass !== 'xxxx xxxx xxxx xxxx');
            res.json({
                available:        configured,
                defaultRecipients: cfg.defaultRecipients || [],
                messageTemplate:  cfg.messageTemplate || null,
                senderName:       cfg.senderName || 'Ganso-Paralelo',
            });
        });

        // Envía el Excel por correo usando nodemailer
        webApp.post('/send-email', async (req, res) => {
            // Rate limiting — protege credenciales SMTP contra abuso local
            if (!emailRateAllowed()) {
                return res.status(429).json({
                    error:   'rate_limited',
                    message: 'Límite de envíos alcanzado. Esperá un momento e intentá de nuevo.',
                });
            }

            const cfg = readMailConfig();
            if (!cfg)
                return res.status(503).json({ error: 'config_missing', message: 'Falta el archivo mail-config.json.' });

            const configured = !!(cfg.user && cfg.pass
                && cfg.user !== 'tu.correo@gmail.com'
                && cfg.pass !== 'xxxx xxxx xxxx xxxx');
            if (!configured)
                return res.status(503).json({ error: 'config_incomplete', message: 'Completá mail-config.json con tu cuenta de correo.' });

            // Validar inputs antes de usar cualquier campo
            const validErr = validateEmailRequest(req.body);
            if (validErr)
                return res.status(400).json({ error: 'bad_request', message: validErr });

            const { to, subject, text, filename, content, senderName, replyTo } = req.body;

            try {
                const transporter = getTransporter(cfg);

                // Sanitizar todos los campos que van a headers SMTP (previene header injection)
                let fromName;
                if (senderName && replyTo && replyTo !== cfg.user) {
                    fromName = `${sanitizeHeader(senderName)} <${sanitizeHeader(replyTo)}> — Ganso-Paralelo`;
                } else if (senderName) {
                    fromName = `${sanitizeHeader(senderName)} — Ganso-Paralelo`;
                } else {
                    fromName = sanitizeHeader(cfg.senderName || 'Ganso-Paralelo');
                }

                await transporter.sendMail({
                    from:    `"${fromName}" <${cfg.user}>`,
                    replyTo: sanitizeHeader(replyTo || cfg.user),
                    to:      to.split(',').map(e => sanitizeHeader(e.trim())).join(', '),
                    subject: sanitizeHeader(subject),
                    text,
                    attachments: [{
                        filename:    path.basename(String(filename)),
                        content:     Buffer.from(content, 'base64'),
                        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    }],
                });

                res.json({ ok: true });
            } catch (err) {
                console.error('send-email error:', err.code, err.message);
                let message = 'Error al enviar el correo. Intentá de nuevo.';
                if (err.code === 'EAUTH' || err.responseCode === 535)
                    message = 'Credenciales incorrectas. Revisá mail-config.json.';
                else if (err.code === 'ECONNREFUSED')
                    message = 'No se pudo conectar al servidor SMTP.';
                else if (err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND')
                    message = 'Sin conexión a internet o servidor SMTP no encontrado.';
                else if (err.responseCode >= 550)
                    message = 'La dirección destinataria fue rechazada por el servidor.';
                res.status(500).json({ error: err.code || 'send_failed', message });
            }
        });

        // Abre el cliente de correo del sistema (fallback).
        // Solo acepta mailto: URLs; elimina caracteres de control que podrían causar
        // inyección de headers en clientes de correo antiguos.
        webApp.get('/open-mailto', (req, res) => {
            const raw = String(req.query.url || '');
            if (raw.startsWith('mailto:')) {
                const sanitized = raw.replace(/[\r\n\0\t]/g, '').slice(0, 2000);
                shell.openExternal(sanitized).catch(() => {});
            }
            res.json({ ok: true });
        });

        server = http.createServer(webApp);
        server.listen(PORT, '127.0.0.1', () => { serverReady = true; resolve(); });
        server.on('error', reject);
    });
}

// Inicia el servidor en paralelo con la inicialización de Electron para ganar tiempo
const serverPromise = startServer();

function createWindow() {
    const iconPath = path.join(__dirname, 'app', 'logos', 'favicon.ico');

    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        icon: iconPath,
        title: 'Ganso-Paralelo',
        autoHideMenuBar: true,
        show: false,
        backgroundColor: '#f8f9fb',
        webPreferences: {
            nodeIntegration: false,   // el renderer no accede a APIs de Node
            contextIsolation: true,   // contexto JS del renderer aislado del main
            sandbox: true,            // renderer corre en sandbox OS-level
            spellcheck: false,
            backgroundThrottling: false,
        },
    });

    win.once('ready-to-show', () => win.show());
    return win;
}

app.whenReady().then(() => {
    const win = createWindow();

    // In Electron, beforeunload calling e.preventDefault() silently blocks navigation.
    // All page data is auto-saved to localStorage, so it is always safe to navigate.
    win.webContents.on('will-prevent-unload', (event) => {
        event.preventDefault();
    });

    // Bloquear navegación a URLs externas desde el renderer.
    // Las páginas internas son todas 127.0.0.1; Firebase hace requests via fetch,
    // no via navegación de página.
    win.webContents.on('will-navigate', (event, url) => {
        try {
            const parsed = new URL(url);
            if (parsed.hostname !== '127.0.0.1') {
                event.preventDefault();
                // Abrir en el browser del sistema si es http/https externo
                if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                    shell.openExternal(url).catch(() => {});
                }
            }
        } catch (_) {
            event.preventDefault();
        }
    });

    // Bloquear apertura de nuevas ventanas Electron desde el renderer.
    // Links externos se redirigen al browser del sistema.
    win.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const parsed = new URL(url);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
                shell.openExternal(url).catch(() => {});
            }
        } catch (_) {}
        return { action: 'deny' };
    });

    // When the user closes the window, trigger a flush in the renderer so any pending
    // Firestore write has time to complete before the process exits.
    let readyToClose = false;
    win.on('close', (e) => {
        if (readyToClose) return;
        e.preventDefault();
        win.webContents.executeJavaScript(`
            (function() {
                try {
                    if (typeof hasData === 'function' && hasData()) {
                        if (typeof saveLocalState === 'function') saveLocalState(false);
                        if (typeof flushFirestoreSave === 'function') flushFirestoreSave();
                    }
                } catch(_) {}
                return true;
            })()
        `).catch(() => {}).finally(() => {
            setTimeout(() => { readyToClose = true; win.close(); }, 1500);
        });
    });

    serverPromise
        .then(() => win.loadURL(`http://127.0.0.1:${PORT}/login.html`))
        .catch(err => {
            win.show();
            win.loadURL(`data:text/html,<h2 style="font-family:sans-serif;padding:40px;color:#c00">Error al iniciar el servidor local: ${encodeURIComponent(err.message)}</h2>`);
        });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            const newWin = createWindow();
            if (serverReady) {
                newWin.loadURL(`http://127.0.0.1:${PORT}/login.html`);
            } else {
                serverPromise.then(() => newWin.loadURL(`http://127.0.0.1:${PORT}/login.html`));
            }
        }
    });
});

app.on('window-all-closed', () => {
    if (server) server.close();
    if (process.platform !== 'darwin') app.quit();
});
