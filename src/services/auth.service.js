'use strict';

const bcrypt = require('bcryptjs');
const userRepo = require('../repositories/user.repo');
const { badRequest, unauthorized, conflict } = require('../utils/http');

const BCRYPT_ROUNDS = 10;

async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

/**
 * Login: memverifikasi kredensial dan status akun.
 * Pesan error disamakan untuk email tidak dikenal maupun password salah agar
 * tidak menjadi sarana enumerasi akun.
 */
async function authenticate({ email, password, expectedRole = null }) {
  const genericError = unauthorized('Email/NIM atau password salah.', 'INVALID_CREDENTIALS');
  if (!email || !password) throw genericError;

  const candidates = new Set([String(email).trim()]);
  const user = userRepo.findByEmailWithHash(email) || userRepo.findByNim(email);

  if (!user) {
    // Tetap lakukan hash comparison palsu agar waktu respons konsisten.
    await bcrypt.compare(String(password), '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
    throw genericError;
  }
  const ok = await verifyPassword(String(password), user.password_hash);
  if (!ok) throw genericError;
  if (!user.is_active) throw unauthorized('Akun Anda tidak aktif. Hubungi administrator.', 'ACCOUNT_INACTIVE');
  if (expectedRole && user.role !== expectedRole) throw genericError;

  candidates.clear();
  return {
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    role: user.role,
    nim: user.nim,
    employee_id: user.employee_id,
    study_program: user.study_program,
    position_id: user.position_id,
    position_name: user.position_name,
  };
}

/** Registrasi publik hanya menghasilkan akun mahasiswa. */
async function registerStudent({ fullName, nim, email, password, studyProgram }) {
  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedNim = String(nim).trim();

  if (userRepo.findByEmailWithHash(normalizedEmail)) {
    throw conflict('Email sudah terdaftar.', 'EMAIL_TAKEN');
  }
  if (userRepo.findByNim(normalizedNim)) {
    throw conflict('NIM sudah terdaftar.', 'NIM_TAKEN');
  }
  if (String(password).length < 8) {
    throw badRequest('Password minimal 8 karakter.', 'WEAK_PASSWORD');
  }

  const passwordHash = await hashPassword(String(password));
  const user = userRepo.create({
    nim: normalizedNim,
    fullName: String(fullName).trim(),
    email: normalizedEmail,
    passwordHash,
    role: 'MAHASISWA',
    studyProgram: studyProgram ? String(studyProgram).trim() : null,
  });
  return user;
}

module.exports = { hashPassword, verifyPassword, authenticate, registerStudent };
