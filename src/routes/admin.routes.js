'use strict';

const express = require('express');
const userRepo = require('../repositories/user.repo');
const auditRepo = require('../repositories/audit.repo');
const templateRepo = require('../repositories/template.repo');
const { requireRole } = require('../middleware/auth');
const { requireJsonObject, validateBody } = require('../middleware/validation');
const authService = require('../services/auth.service');
const { asyncHandler, conflict, badRequest } = require('../utils/http');

const router = express.Router();
// Pengelolaan akun pegawai dibatasi pada staf administrasi (bukan registrasi publik).
router.use(requireRole('STAF'));

router.get('/users', (req, res) => {
  const role = req.query.role ? String(req.query.role).toUpperCase() : null;
  const allowed = ['MAHASISWA', 'STAF', 'PEJABAT'];
  if (role && !allowed.includes(role)) throw badRequest('Role tidak dikenal.');
  const users = (role ? userRepo.listByRole(role) : [...userRepo.listByRole('STAF'), ...userRepo.listByRole('PEJABAT'), ...userRepo.listByRole('MAHASISWA')]).map((u) => ({
    id: u.id,
    full_name: u.full_name,
    email: u.email,
    role: u.role,
    nim: u.nim,
    employee_id: u.employee_id,
    study_program: u.study_program,
    position_name: u.position_name,
    is_active: !!u.is_active,
  }));
  res.json({ users });
});

/** Membuat akun pegawai (staf/pejabat). Password tidak pernah dikembalikan. */
router.post(
  '/users',
  requireJsonObject,
  validateBody({
    full_name: { required: true, minLength: 3, maxLength: 120 },
    email: { required: true, type: 'email', maxLength: 120 },
    employee_id: { required: true, minLength: 3, maxLength: 30 },
    password: { required: true, minLength: 8, maxLength: 100 },
    role: { required: true, maxLength: 10 },
  }),
  asyncHandler(async (req, res) => {
    const role = String(req.cleanBody.role).toUpperCase();
    if (!['STAF', 'PEJABAT'].includes(role)) {
      throw badRequest('Role akun pegawai harus STAF atau PEJABAT.', 'ROLE_INVALID');
    }
    if (userRepo.findByEmailWithHash(req.cleanBody.email)) throw conflict('Email sudah terdaftar.', 'EMAIL_TAKEN');
    if (userRepo.findByEmployeeId(req.cleanBody.employee_id)) throw conflict('NIP/NIDN sudah terdaftar.', 'EMPLOYEE_TAKEN');

    let positionId = null;
    if (role === 'PEJABAT') {
      positionId = Number(req.body.position_id);
      if (!Number.isInteger(positionId) || !templateRepo.findPositionById(positionId)) {
        throw badRequest('Pejabat wajib memiliki jabatan yang valid.', 'POSITION_REQUIRED');
      }
    }

    const passwordHash = await authService.hashPassword(req.cleanBody.password);
    const user = userRepo.create({
      employeeId: req.cleanBody.employee_id,
      fullName: req.cleanBody.full_name,
      email: req.cleanBody.email.toLowerCase(),
      passwordHash,
      role,
      positionId,
    });
    auditRepo.log({ actorUserId: req.user.id, action: 'AKUN_PEGAWAI_DIBUAT', newValue: { role, employee_id: user.employee_id }, ipAddress: req.ip });
    res.status(201).json({ message: 'Akun pegawai dibuat.', user: { id: user.id, full_name: user.full_name, role: user.role } });
  })
);

router.patch(
  '/users/:id/status',
  requireJsonObject,
  asyncHandler(async (req, res) => {
    const isActive = req.body.is_active === true || req.body.is_active === 'true' || req.body.is_active === 1;
    const user = userRepo.setActive(Number(req.params.id), isActive);
    if (!user) throw badRequest('Pengguna tidak ditemukan.');
    auditRepo.log({ actorUserId: req.user.id, action: 'STATUS_AKUN_DIUBAH', newValue: { user_id: user.id, is_active: isActive }, ipAddress: req.ip });
    res.json({ message: `Akun ${user.full_name} ${isActive ? 'diaktifkan' : 'dinonaktifkan'}.`, user: { id: user.id, is_active: !!user.is_active } });
  })
);

router.get('/audit-logs', (req, res) => {
  res.json({ audit: auditRepo.listRecent(300) });
});

module.exports = router;
