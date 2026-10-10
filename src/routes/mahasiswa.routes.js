'use strict';

const express = require('express');
const templateRepo = require('../repositories/template.repo');
const pengajuanRepo = require('../repositories/pengajuan.repo');
const notifRepo = require('../repositories/notification.repo');
const suratService = require('../services/surat.service');
const { requireRole } = require('../middleware/auth');
const { requireJsonObject, validateBody } = require('../middleware/validation');
const { asyncHandler, badRequest, notFound } = require('../utils/http');

const router = express.Router();
router.use(requireRole('MAHASISWA'));

// ---------------------------------------------------------------------------
// Katalog template surat
// ---------------------------------------------------------------------------
router.get('/templates', (req, res) => {
  const templates = templateRepo.listAll({ onlyActive: true }).map((t) => ({
    id: t.id,
    kode: t.kode,
    nama_surat: t.nama_surat,
    deskripsi: t.deskripsi,
    persyaratan: t.persyaratan,
    form_schema: t.form_schema,
  }));
  res.json({ templates });
});

router.get('/templates/:id', (req, res) => {
  const template = templateRepo.findById(req.params.id, { onlyActive: true });
  if (!template) throw notFound('Template surat tidak ditemukan atau tidak aktif.');
  const routes = templateRepo.listRoutes(template.id).map((r) => ({ urutan_ke: r.urutan_ke, position_name: r.position_name }));
  res.json({
    template: {
      id: template.id,
      kode: template.kode,
      nama_surat: template.nama_surat,
      deskripsi: template.deskripsi,
      persyaratan: template.persyaratan,
      form_schema: template.form_schema,
    },
    rute_persetujuan: routes,
  });
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
router.get('/dashboard', (req, res) => {
  const rows = pengajuanRepo.countByStatusForStudent(req.user.id);
  const counts = Object.fromEntries(rows.map((r) => [r.status_pengajuan, r.total]));
  const total = rows.reduce((sum, r) => sum + r.total, 0);
  res.json({
    ringkasan: {
      total,
      menunggu_verifikasi: counts.MENUNGGU_VERIFIKASI_STAF || 0,
      menunggu_persetujuan: counts.MENUNGGU_PERSETUJUAN || 0,
      perlu_revisi: counts.PERLU_REVISI || 0,
      selesai: counts.SELESAI || 0,
      ditolak: counts.DITOLAK || 0,
      kedaluwarsa: counts.KEDALUWARSA || 0,
      dibatalkan: counts.DIBATALKAN || 0,
    },
    pengajuan_terbaru: pengajuanRepo.listByStudent(req.user.id).slice(0, 5).map(serializeSummary),
    notifikasi_belum_dibaca: notifRepo.countUnread(req.user.id),
  });
});

function serializeSummary(p) {
  return {
    id: p.id,
    public_reference: p.public_reference,
    nama_surat: p.nama_surat,
    kode_template: p.template_kode,
    status_pengajuan: p.status_pengajuan,
    version_number: p.version_number,
    current_step: p.current_step,
    tanggal_diajukan: p.tanggal_diajukan,
    deadline_revisi: p.deadline_revisi,
    surat_number: p.surat_number,
    pdf_status: p.pdf_status,
  };
}

// ---------------------------------------------------------------------------
// Pengajuan
// ---------------------------------------------------------------------------
router.get('/pengajuan', (req, res) => {
  res.json({ pengajuan: pengajuanRepo.listByStudent(req.user.id).map(serializeSummary) });
});

router.post(
  '/pengajuan',
  requireJsonObject,
  validateBody({ template_id: { required: true, type: 'integer' } }),
  asyncHandler(async (req, res) => {
    const payload = req.body.payload;
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw badRequest('Field payload harus berupa objek data isian.', 'PAYLOAD_INVALID');
    }
    const result = await suratService.createSubmission(req.user, {
      templateId: Number(req.cleanBody.template_id),
      payload,
    });
    res.status(201).json({
      message: 'Pengajuan berhasil dikirim dan menunggu verifikasi staf administrasi.',
      pengajuan: serializeSummary(result.pengajuan),
      rute_persetujuan: result.snapshot.map((s) => ({ urutan_ke: s.urutan_ke, position_name: s.position_name })),
    });
  })
);

router.get('/pengajuan/:id', (req, res) => {
  const pengajuan = pengajuanRepo.findById(req.params.id);
  if (!pengajuan || pengajuan.student_id !== req.user.id) throw notFound('Pengajuan tidak ditemukan.');
  const detail = suratService.getSubmissionDetail(pengajuan.id);
  res.json(publicDetail(detail));
});

/** Detail yang aman untuk mahasiswa: tanpa audit log internal & IP. */
function publicDetail(detail) {
  return {
    pengajuan: detail.pengajuan,
    template: detail.template,
    snapshot: detail.snapshot.map((s) => ({
      urutan_ke: s.urutan_ke,
      position_name: s.position_name,
      is_required: !!s.is_required,
      assigned_employee_name: s.assigned_employee_name,
    })),
    approvals: detail.approvals.map((a) => ({
      urutan_hierarki: a.urutan_hierarki,
      round_number: a.round_number,
      status_persetujuan: a.status_persetujuan,
      catatan: a.catatan,
      waktu_diproses: a.waktu_diproses,
      employee_name: a.employee_name,
      employee_position: a.employee_position,
    })),
    revisions: detail.revisions.map((r) => ({
      version_number: r.version_number,
      revision_reason: r.revision_reason,
      requested_by_name: r.requested_by_name,
      requested_by_role: r.requested_by_role,
      request_stage: r.request_stage,
      created_at: r.created_at,
      resubmitted_at: r.resubmitted_at,
      payload_snapshot: r.payload_snapshot_json,
    })),
    events: detail.events.map((e) => ({ event_type: e.event_type, created_at: e.created_at, actor_name: e.actor_name })),
    deadline_days: detail.deadline_days,
  };
}

router.put(
  '/pengajuan/:id/resubmit',
  requireJsonObject,
  asyncHandler(async (req, res) => {
    const payload = req.body.payload;
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw badRequest('Field payload harus berupa objek data isian.', 'PAYLOAD_INVALID');
    }
    const updated = await suratService.resubmitSubmission(req.user, req.params.id, payload);
    res.json({ message: 'Pengajuan berhasil dikirim ulang dan menunggu verifikasi ulang.', pengajuan: serializeSummary(updated) });
  })
);

router.post(
  '/pengajuan/:id/cancel',
  requireJsonObject,
  validateBody({ alasan: { required: true, minLength: 5, maxLength: 500 } }),
  asyncHandler(async (req, res) => {
    const updated = suratService.cancelSubmission(req.user, req.params.id, req.cleanBody.alasan);
    res.json({ message: 'Pengajuan dibatalkan.', pengajuan: serializeSummary(updated) });
  })
);

// ---------------------------------------------------------------------------
// Profil
// ---------------------------------------------------------------------------
router.put(
  '/profile',
  requireJsonObject,
  validateBody({
    full_name: { required: true, minLength: 3, maxLength: 120 },
    study_program: { required: true, minLength: 3, maxLength: 120 },
    email: { required: true, type: 'email', maxLength: 120 },
  }),
  asyncHandler(async (req, res) => {
    const userRepo = require('../repositories/user.repo');
    const user = userRepo.updateProfile(req.user.id, {
      fullName: req.cleanBody.full_name,
      studyProgram: req.cleanBody.study_program,
      email: req.cleanBody.email.toLowerCase(),
    });
    res.json({ message: 'Profil diperbarui.', user: { id: user.id, full_name: user.full_name, email: user.email, study_program: user.study_program } });
  })
);

module.exports = router;
module.exports.serializeSummary = serializeSummary;
