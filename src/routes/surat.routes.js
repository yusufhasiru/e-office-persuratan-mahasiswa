'use strict';

const express = require('express');
const approvalRepo = require('../repositories/approval.repo');
const pengajuanRepo = require('../repositories/pengajuan.repo');
const suratService = require('../services/surat.service');
const { requireAuth } = require('../middleware/auth');
const { loadPengajuan } = require('../middleware/authorization');
const { readPdf } = require('../services/pdf.service');
const { asyncHandler, forbidden, conflict, notFound } = require('../utils/http');

const router = express.Router();

/**
 * Memastikan pengguna berhak melihat pengajuan tertentu:
 *  - Mahasiswa: hanya miliknya sendiri.
 *  - Staf    : seluruh pengajuan (kewenangan administratif).
 *  - Pejabat : hanya pengajuan yang pernah/akan menjadi kewenangannya.
 */
function assertCanView(user, pengajuan) {
  if (user.role === 'MAHASISWA') {
    if (pengajuan.student_id !== user.id) throw notFound('Pengajuan tidak ditemukan.');
    return;
  }
  if (user.role === 'STAF') return;

  const decisions = approvalRepo.listBySubmission(pengajuan.id);
  const mine = decisions.some((d) => d.employee_id === user.id);
  if (!mine) throw forbidden('Pengajuan ini belum/tidak menjadi kewenangan Anda.');
}

router.get(
  '/:id',
  requireAuth,
  loadPengajuan(),
  asyncHandler(async (req, res) => {
    assertCanView(req.user, req.pengajuan);
    const detail = suratService.getSubmissionDetail(req.pengajuan.id);

    const isOwner = req.user.role === 'MAHASISWA' && req.pengajuan.student_id === req.user.id;
    const canSeeVerification = req.pengajuan.status_pengajuan === 'SELESAI' && (isOwner || req.user.role === 'STAF');

    res.json({
      pengajuan: {
        id: detail.pengajuan.id,
        public_reference: detail.pengajuan.public_reference,
        nama_surat: detail.pengajuan.nama_surat,
        kode_template: detail.pengajuan.template_kode,
        student_name: detail.pengajuan.student_name,
        student_nim: detail.pengajuan.student_nim,
        study_program: detail.pengajuan.study_program,
        status_pengajuan: detail.pengajuan.status_pengajuan,
        version_number: detail.pengajuan.version_number,
        current_step: detail.pengajuan.current_step,
        payload_isian: detail.pengajuan.payload_isian,
        tanggal_diajukan: detail.pengajuan.tanggal_diajukan,
        submitted_at: detail.pengajuan.submitted_at,
        deadline_revisi: detail.pengajuan.deadline_revisi,
        completed_at: detail.pengajuan.completed_at,
        surat_number: detail.pengajuan.surat_number,
        issued_at: detail.pengajuan.issued_at,
        pdf_status: detail.pengajuan.pdf_status,
        pdf_last_error: detail.pengajuan.pdf_last_error,
        pdf_tersedia: Boolean(detail.pengajuan.pdf_path),
        verification_reference: canSeeVerification ? detail.pengajuan.verification_token_hash?.slice(0, 12) : null,
      },
      template: detail.template,
      snapshot: detail.snapshot,
      approvals: detail.approvals,
      revisions: detail.revisions,
      events: detail.events,
      audit: req.user.role === 'STAF' ? detail.audit : undefined,
      deadline_days: detail.deadline_days,
    });
  })
);

/**
 * Unduh PDF final. Berlapis pemeriksaan: login, kepemilikan/kewenangan,
 * status SELESAI, dan keberadaan berkas.
 */
router.get(
  '/:id/pdf',
  requireAuth,
  loadPengajuan(),
  asyncHandler(async (req, res) => {
    const pengajuan = req.pengajuan;

    const isOwner = req.user.role === 'MAHASISWA' && pengajuan.student_id === req.user.id;
    const isStaff = req.user.role === 'STAF';
    if (!isOwner && !isStaff) throw forbidden('Anda tidak berhak mengunduh dokumen ini.');

    if (pengajuan.status_pengajuan !== 'SELESAI') {
      throw conflict('Dokumen final belum tersedia karena pengajuan belum selesai.', 'NOT_COMPLETED');
    }
    if (!pengajuan.pdf_path) throw conflict('Berkas PDF tidak ditemukan pada sistem.', 'PDF_MISSING');

    const buffer = readPdf(pengajuan.pdf_path);
    if (!buffer) throw notFound('Berkas PDF tidak ditemukan pada penyimpanan.', 'PDF_FILE_MISSING');

    pengajuanRepo.logEvent(pengajuan.id, 'DOKUMEN_DIUNDUH', req.user.id, { oleh: req.user.role });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${pengajuan.public_reference}-${pengajuan.surat_number.replace(/[^0-9A-Za-z]/g, '-')}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
  })
);

module.exports = router;
