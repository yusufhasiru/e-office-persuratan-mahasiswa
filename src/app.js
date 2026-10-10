'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');

const { env, ROOT } = require('./config/env');
const { SqliteSessionStore } = require('./repositories/session.store');
const { loadUser } = require('./middleware/auth');
const { csrfProtection, csrfTokenHandler } = require('./middleware/csrf');
const { HttpError } = require('./utils/http');

const authRoutes = require('./routes/auth.routes');
const mahasiswaRoutes = require('./routes/mahasiswa.routes');
const stafRoutes = require('./routes/staf.routes');
const pejabatRoutes = require('./routes/pejabat.routes');
const adminRoutes = require('./routes/admin.routes');
const suratRoutes = require('./routes/surat.routes');
const verificationRoutes = require('./routes/verification.routes');
const notificationRoutes = require('./routes/notification.routes');

const VIEWS_DIR = path.join(ROOT, 'views');
const PUBLIC_DIR = path.join(ROOT, 'public');
const sessionStore = new SqliteSessionStore();

function createApp() {
  const app = express();

  app.set('trust proxy', env.trustProxy ? 1 : false);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
    })
  );

  app.use(express.json({ limit: '200kb' }));
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));

  app.use(
    session({
      name: env.sessionName,
      secret: env.sessionSecret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.isProduction,
        maxAge: env.sessionTtlMs,
      },
    })
  );

  // Statis: hanya aset publik. Berkas PDF pengguna TIDAK pernah disajikan statis.
  app.use('/css', express.static(path.join(PUBLIC_DIR, 'css'), { maxAge: '1h' }));
  app.use('/js', express.static(path.join(PUBLIC_DIR, 'js'), { maxAge: '1h' }));
  app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets'), { maxAge: '1h' }));

  app.use(loadUser);
  app.use(csrfProtection);

  // ---------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------
  app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
  // Token CSRF untuk sesi saat ini (juga tersedia di /api/auth/csrf).
  app.get('/api/csrf', csrfTokenHandler);
  app.use('/api/auth', authRoutes);
  app.use('/api/mahasiswa', mahasiswaRoutes);
  app.use('/api/staf', stafRoutes);
  app.use('/api/pejabat', pejabatRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/surat', suratRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/verify', verificationRoutes);

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Endpoint tidak ditemukan.', code: 'API_NOT_FOUND' });
  });

  // ---------------------------------------------------------------------
  // Halaman
  // ---------------------------------------------------------------------
  const sendPage = (file) => (req, res) => {
    const full = path.join(VIEWS_DIR, file);
    if (!fs.existsSync(full)) return res.status(500).send('Halaman belum tersedia.');
    return res.sendFile(full);
  };

  /** Guard halaman: pengecekan role juga dilakukan di sini, bukan hanya di frontend. */
  const guardPage = (roles) => (req, res, next) => {
    if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    if (roles && !roles.includes(req.user.role)) {
      return res.status(403).sendFile(path.join(VIEWS_DIR, 'auth', 'akses-ditolak.html'));
    }
    return next();
  };

  const dashboardFor = (role) =>
    role === 'MAHASISWA' ? '/mahasiswa/dashboard' : role === 'STAF' ? '/staf/dashboard' : '/pejabat/dashboard';

  app.get('/', (req, res) => {
    if (!req.user) return res.redirect('/login');
    return res.redirect(dashboardFor(req.user.role));
  });

  app.get('/login', (req, res) => {
    if (req.user) return res.redirect(dashboardFor(req.user.role));
    return sendPage('auth/login.html')(req, res);
  });
  app.get('/register', (req, res) => {
    if (req.user) return res.redirect(dashboardFor(req.user.role));
    return sendPage('auth/register.html')(req, res);
  });
  app.get('/akses-ditolak', sendPage('auth/akses-ditolak.html'));
  app.get('/sesi-berakhir', sendPage('auth/sesi-berakhir.html'));

  // Halaman verifikasi publik (tanpa login)
  app.get('/verify/:token', sendPage('public/verify.html'));

  // Partial yang diambil frontend untuk membentuk layout.
  // Nama dibatasi pola aman (tanpa path traversal) dan ekstensi .html opsional.
  app.get('/partials/:name', (req, res) => {
    const name = String(req.params.name).replace(/\.html$/i, '');
    if (!/^[a-z0-9-]+$/i.test(name)) return res.status(404).send('');
    const full = path.join(VIEWS_DIR, 'partials', `${name}.html`);
    if (!fs.existsSync(full)) return res.status(404).send('');
    return res.type('html').sendFile(full);
  });

  // Mahasiswa
  const mahasiswaPages = {
    '/mahasiswa/dashboard': 'mahasiswa/dashboard.html',
    '/mahasiswa/katalog': 'mahasiswa/katalog.html',
    '/mahasiswa/pengajuan-baru': 'mahasiswa/pengajuan-baru.html',
    '/mahasiswa/pengajuan/:id': 'mahasiswa/pengajuan-detail.html',
    '/mahasiswa/pengajuan': 'mahasiswa/pengajuan.html',
    '/mahasiswa/revisi/:id': 'mahasiswa/pengajuan-revisi.html',
    '/mahasiswa/notifikasi': 'mahasiswa/notifikasi.html',
    '/mahasiswa/profil': 'mahasiswa/profil.html',
  };
  for (const [route, file] of Object.entries(mahasiswaPages)) {
    app.get(route, guardPage(['MAHASISWA']), sendPage(file));
  }

  // Staf
  const stafPages = {
    '/staf/dashboard': 'staf/dashboard.html',
    '/staf/antrean': 'staf/antrean.html',
    '/staf/pengajuan': 'staf/pengajuan.html',
    '/staf/pengajuan/:id': 'staf/detail.html',
    '/staf/proses': 'staf/proses.html',
    '/staf/template': 'staf/template.html',
    '/staf/rute': 'staf/rute.html',
    '/staf/laporan': 'staf/laporan.html',
    '/staf/akun': 'staf/akun.html',
    '/staf/notifikasi': 'mahasiswa/notifikasi.html',
  };
  for (const [route, file] of Object.entries(stafPages)) {
    app.get(route, guardPage(['STAF']), sendPage(file));
  }

  // Pejabat
  const pejabatPages = {
    '/pejabat/dashboard': 'pejabat/dashboard.html',
    '/pejabat/antrean': 'pejabat/antrean.html',
    '/pejabat/pengajuan/:id': 'pejabat/detail.html',
    '/pejabat/riwayat': 'pejabat/riwayat.html',
    '/pejabat/notifikasi': 'mahasiswa/notifikasi.html',
  };
  for (const [route, file] of Object.entries(pejabatPages)) {
    app.get(route, guardPage(['PEJABAT']), sendPage(file));
  }

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Endpoint tidak ditemukan.', code: 'API_NOT_FOUND' });
    }
    return res.status(404).sendFile(path.join(VIEWS_DIR, 'public', '404.html'));
  });

  // ---------------------------------------------------------------------
  // Error handler: tidak pernah membocorkan stack trace ke pengguna
  // ---------------------------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const isApi = req.path.startsWith('/api/') || req.xhr || req.is('application/json');
    const status = err instanceof HttpError ? err.status : 500;

    if (status >= 500) {
      console.error('[error]', req.method, req.originalUrl, '-', err.message);
    }

    const payload = {
      error: err.expected || status < 500 ? err.message : 'Terjadi kesalahan pada server.',
      code: err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'ERROR'),
    };
    if (err.details) payload.details = err.details;

    if (status === 401 && !isApi) {
      return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    }
    if (isApi) return res.status(status).json(payload);
    return res.status(status).send(`<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Galat</title><link rel="stylesheet" href="/css/styles.css"></head><body><div class="container"><div class="card"><h1>Galat ${status}</h1><p>${payload.error}</p><a class="btn" href="/">Kembali ke beranda</a></div></div></body></html>`);
  });

  return app;
}

module.exports = { createApp, sessionStore, PUBLIC_DIR, VIEWS_DIR };
