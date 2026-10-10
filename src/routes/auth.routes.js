'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const authService = require('../services/auth.service');
const auditRepo = require('../repositories/audit.repo');
const { requireAuth } = require('../middleware/auth');
const { requireJsonObject, validateBody } = require('../middleware/validation');
const { csrfTokenHandler } = require('../middleware/csrf');
const { asyncHandler, unauthorized } = require('../utils/http');

const router = express.Router();

const { env } = require('../config/env');

const loginLimiter = rateLimit({
  windowMs: env.loginRateLimitWindowMinutes * 60 * 1000,
  limit: env.loginRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak percobaan login. Coba lagi dalam beberapa menit.', code: 'RATE_LIMITED' },
  skipSuccessfulRequests: true,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak pendaftaran dari alamat ini. Coba lagi nanti.' },
});

/** Token CSRF untuk sesi saat ini (dibaca frontend sebelum request POST). */
router.get('/csrf', csrfTokenHandler);

/** Siapa saya? */
router.get('/me', (req, res) => {
  if (!req.user) return res.status(200).json({ authenticated: false, user: null });
  const { id, full_name, email, role, nim, employee_id, study_program, position_id, position_name } = req.user;
  res.json({
    authenticated: true,
    user: { id, full_name, email, role, nim, employee_id, study_program, position_id, position_name },
  });
});

/** Login: regenerasi session untuk mencegah session fixation. */
router.post(
  '/login',
  loginLimiter,
  requireJsonObject,
  validateBody({ email: { required: true, maxLength: 120 }, password: { required: true, maxLength: 200 } }),
  asyncHandler(async (req, res) => {
    const { email, password } = req.cleanBody;
    const user = await authService.authenticate({ email, password });

    await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));

    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.csrfToken = require('../utils/crypto').generateCsrfToken();

    auditRepo.log({ actorUserId: user.id, action: 'LOGIN_SUKSES', newValue: { role: user.role }, ipAddress: req.ip });

    await new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
    res.json({ message: 'Login berhasil.', user, csrfToken: req.session.csrfToken });
  })
);

/** Registrasi publik hanya untuk mahasiswa. */
router.post(
  '/register',
  registerLimiter,
  requireJsonObject,
  validateBody({
    fullName: { required: true, minLength: 3, maxLength: 120 },
    nim: { required: true, minLength: 4, maxLength: 20 },
    email: { required: true, type: 'email', maxLength: 120 },
    password: { required: true, minLength: 8, maxLength: 100 },
    studyProgram: { required: true, minLength: 3, maxLength: 120 },
  }),
  asyncHandler(async (req, res) => {
    const { fullName, nim, email, password, studyProgram } = req.cleanBody;
    const user = await authService.registerStudent({ fullName, nim, email, password, studyProgram });
    auditRepo.log({ actorUserId: user.id, action: 'REGISTRASI_MAHASISWA', newValue: { nim: user.nim }, ipAddress: req.ip });
    res.status(201).json({ message: 'Registrasi berhasil. Silakan login.', user: { id: user.id, nim: user.nim, full_name: user.full_name } });
  })
);

/** Logout: hapus session sepenuhnya. */
router.post(
  '/logout',
  (req, res, next) => {
    if (!req.session) return next(unauthorized('Session tidak tersedia.'));
    return next();
  },
  asyncHandler(async (req, res) => {
    const userId = req.session.userId || null;
    await new Promise((resolve, reject) => req.session.destroy((err) => (err ? reject(err) : resolve())));
    res.clearCookie(env.sessionName);
    if (userId) auditRepo.log({ actorUserId: userId, action: 'LOGOUT', ipAddress: req.ip });
    res.json({ message: 'Anda telah keluar.' });
  })
);

/** Ringkasan akun sendiri. */
router.get('/profile', requireAuth, (req, res) => {
  const { id, full_name, email, role, nim, employee_id, study_program, position_name } = req.user;
  res.json({ user: { id, full_name, email, role, nim, employee_id, study_program, position_name } });
});

module.exports = router;
