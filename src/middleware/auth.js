'use strict';

const userRepo = require('../repositories/user.repo');
const { unauthorized, forbidden } = require('../utils/http');

/** Mengisi req.user bila session valid (tidak memblokir request). */
function loadUser(req, res, next) {
  if (!req.session || !req.session.userId) return next();
  const user = userRepo.findById(req.session.userId);
  if (user && user.is_active) {
    req.user = user;
    return next();
  }
  // Akun dihapus / dinonaktifkan: session lama dibuang, tetapi request tetap
  // diteruskan sehingga pengguna menerima respons yang jelas (bukan error 500).
  return req.session.regenerate((err) => (err ? next(err) : next()));
}

/** Wajib login. */
function requireAuth(req, res, next) {
  if (!req.user) {
    return next(unauthorized('Anda harus login terlebih dahulu.', 'AUTH_REQUIRED'));
  }
  return next();
}

/**
 * Wajib login sebagai mahasiswa. Dipakai juga untuk memblokir mahasiswa
 * mengakses dashboard staf/pejabat pada level backend.
 */
function requireStudent(req, res, next) {
  if (!req.user) return next(unauthorized('Anda harus login terlebih dahulu.', 'AUTH_REQUIRED'));
  if (req.user.role !== 'MAHASISWA') return next(forbidden('Halaman ini khusus mahasiswa.', 'ROLE_STUDENT_ONLY'));
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized('Anda harus login terlebih dahulu.', 'AUTH_REQUIRED'));
    if (!roles.includes(req.user.role)) {
      return next(forbidden('Anda tidak memiliki akses ke sumber daya ini.', 'ROLE_FORBIDDEN'));
    }
    return next();
  };
}

module.exports = { loadUser, requireAuth, requireRole, requireStudent };
