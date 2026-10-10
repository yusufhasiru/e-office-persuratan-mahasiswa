'use strict';

const express = require('express');
const approvalRepo = require('../repositories/approval.repo');
const pengajuanRepo = require('../repositories/pengajuan.repo');
const approvalService = require('../services/approval.service');
const { requireRole } = require('../middleware/auth');
const { requireJsonObject, validateBody } = require('../middleware/validation');
const { asyncHandler, badRequest } = require('../utils/http');

const router = express.Router();
router.use(requireRole('PEJABAT'));

function queueItem(row) {
  return {
    id: row.id,
    public_reference: row.public_reference,
    nama_surat: row.nama_surat,
    kode_template: row.template_kode,
    student_name: row.student_name,
    student_nim: row.student_nim,
    study_program: row.study_program,
    status_pengajuan: row.status_pengajuan,
    version_number: row.version_number,
    current_step: row.current_step,
    submitted_at: row.submitted_at,
  };
}

// ---------------------------------------------------------------------------
// Dashboard & antrean kewenangan sendiri
// ---------------------------------------------------------------------------
router.get('/dashboard', (req, res) => {
  const menunggu = approvalRepo.listQueueForEmployee(req.user.id);
  res.json({
    ringkasan: {
      menunggu_persetujuan_saya: menunggu.length,
      disetujui: approvalRepo.countDecisionsForEmployee(req.user.id, 'DISETUJUI'),
      ditolak: approvalRepo.countDecisionsForEmployee(req.user.id, 'DITOLAK'),
      perlu_revisi: approvalRepo.countDecisionsForEmployee(req.user.id, 'REVISI'),
    },
    jabatan: req.user.position_name || null,
    antrean: menunggu.slice(0, 10).map(queueItem),
  });
});

/** Hanya pengajuan yang memang menunggu keputusan pejabat yang login. */
router.get('/antrean', (req, res) => {
  res.json({ pengajuan: approvalRepo.listQueueForEmployee(req.user.id).map(queueItem) });
});

router.get('/riwayat', (req, res) => {
  const rows = approvalRepo.listHistoryForEmployee(req.user.id).map((j) => ({
    jalur_id: j.id,
    pengajuan_id: j.pengajuan_id,
    public_reference: j.public_reference,
    nama_surat: j.nama_surat,
    kode_template: j.template_kode,
    student_name: j.student_name,
    student_nim: j.student_nim,
    status_pengajuan: j.status_pengajuan,
    status_persetujuan: j.status_persetujuan,
    catatan: j.catatan,
    waktu_diproses: j.waktu_diproses,
    urutan_hierarki: j.urutan_hierarki,
    round_number: j.round_number,
    versi_pengajuan: j.submission_version,
  }));
  res.json({ riwayat: rows });
});

// ---------------------------------------------------------------------------
// Keputusan pejabat
// ---------------------------------------------------------------------------
router.post(
  '/pengajuan/:id/keputusan',
  requireJsonObject,
  validateBody({ decision: { required: true, maxLength: 20 }, catatan: { maxLength: 1000 } }),
  asyncHandler(async (req, res) => {
    const decision = String(req.cleanBody.decision).toUpperCase();
    if (!['SETUJU', 'TOLAK', 'REVISI'].includes(decision)) {
      throw badRequest('Keputusan harus salah satu dari SETUJU, TOLAK, atau REVISI.', 'INVALID_DECISION');
    }

    const result = await approvalService.decideByOfficial(req.user, Number(req.params.id), {
      decision,
      catatan: req.cleanBody.catatan,
      ip: req.ip,
    });

    const fresh = result.pengajuan;
    res.json({
      message:
        decision === 'SETUJU'
          ? fresh.status_pengajuan === 'SELESAI'
            ? 'Seluruh tahap wajib telah disetujui. Dokumen final berhasil dibuat.'
            : 'Keputusan persetujuan disimpan.'
          : decision === 'TOLAK'
            ? 'Pengajuan ditolak.'
            : 'Permintaan revisi dikirim ke mahasiswa.',
      pengajuan: {
        id: fresh.id,
        public_reference: fresh.public_reference,
        status_pengajuan: fresh.status_pengajuan,
        current_step: fresh.current_step,
        pdf_status: fresh.pdf_status,
        surat_number: fresh.surat_number,
      },
      finalisasi: result.ok === undefined ? null : { berhasil: result.ok, pesan: result.error || null },
    });
  })
);

module.exports = router;
