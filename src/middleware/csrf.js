'use strict';

const { generateCsrfToken, safeEqual } = require('../utils/crypto');
const { forbidden } = require('../utils/http');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Proteksi CSRF berbasis token per-session (pola double submit):
 *  - Token dibuat sekali per session, hanya boleh dibaca oleh pemilik session.
 *  - Semua request yang mengubah data wajib menyertakan header X-CSRF-Token.
 *  - Perbandingan dilakukan konstan-waktu.
 */
function csrfProtection(req, res, next) {
  if (!req.session) return next(forbidden('Session tidak tersedia.'));

  if (!req.session.csrfToken) {
    req.session.csrfToken = generateCsrfToken();
  }

  if (SAFE_METHODS.has(req.method)) return next();

  const provided = req.get('x-csrf-token') || (req.body && req.body._csrf);
  if (!provided || !safeEqual(provided, req.session.csrfToken)) {
    return next(forbidden('Token CSRF tidak valid atau kedaluwarsa. Muat ulang halaman.', 'CSRF_INVALID'));
  }
  return next();
}

/** Endpoint agar frontend dapat mengambil token CSRF miliknya sendiri. */
function csrfTokenHandler(req, res) {
  if (!req.session.csrfToken) req.session.csrfToken = generateCsrfToken();
  res.json({ csrfToken: req.session.csrfToken });
}

module.exports = { csrfProtection, csrfTokenHandler };
