'use strict';

const express = require('express');
const pengajuanRepo = require('../repositories/pengajuan.repo');
const templateRepo = require('../repositories/template.repo');
const userRepo = require('../repositories/user.repo');
const auditRepo = require('../repositories/audit.repo');
const approvalRepo = require('../repositories/approval.repo');
const approvalService = require('../services/approval.service');
const suratService = require('../services/surat.service');
const { requireRole } = require('../middleware/auth');
const { requireJsonObject, validateBody } = require('../middleware/validation');
const { sanitizeFormSchema, sanitizeRoutes, validateRoutesAgainstDb } = require('../validators/template-validator');
const { asyncHandler, badRequest, notFound, conflict } = require('../utils/http');

const router = express.Router();
router.use(requireRole('STAF'));

function summary(p) {
  return {
    id: p.id,
    public_reference: p.public_reference,
    nama_surat: p.nama_surat,
    kode_template: p.template_kode,
    student_name: p.student_name,
    student_nim: p.student_nim,
    study_program: p.study_program,
    status_pengajuan: p.status_pengajuan,
    version_number: p.version_number,
    current_step: p.current_step,
    submitted_at: p.submitted_at,
    deadline_revisi: p.deadline_revisi,
    surat_number: p.surat_number,
    pdf_status: p.pdf_status,
  };
}

// ---------------------------------------------------------------------------
// Dashboard & antrean
// ---------------------------------------------------------------------------
router.get('/dashboard', (req, res) => {
  const counts = Object.fromEntries(pengajuanRepo.countByStatus().map((r) => [r.status_pengajuan, r.total]));
  res.json({
    ringkasan: {
      antrean_verifikasi: counts.MENUNGGU_VERIFIKASI_STAF || 0,
      perlu_revisi: counts.PERLU_REVISI || 0,
      menunggu_persetujuan: counts.MENUNGGU_PERSETUJUAN || 0,
      selesai: counts.SELESAI || 0,
      ditolak: counts.DITOLAK || 0,
      kedaluwarsa: counts.KEDALUWARSA || 0,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
    },
    antrean_verifikasi: pengajuanRepo.listByStatus('MENUNGGU_VERIFIKASI_STAF', 10).map(summary),
    pengajuan_terbaru: pengajuanRepo.listRecent(10).map(summary),
  });
});

router.get('/antrean', (req, res) => {
  res.json({ pengajuan: pengajuanRepo.listByStatus('MENUNGGU_VERIFIKASI_STAF', 200).map(summary) });
});

router.get('/revisi', (req, res) => {
  res.json({ pengajuan: pengajuanRepo.listByStatus('PERLU_REVISI', 200).map(summary) });
});

router.get('/pengajuan', (req, res) => {
  const status = req.query.status ? String(req.query.status).toUpperCase() : null;
  const allowed = ['DRAFT', 'MENUNGGU_VERIFIKASI_STAF', 'MENUNGGU_PERSETUJUAN', 'PERLU_REVISI', 'DITOLAK', 'KEDALUWARSA', 'SELESAI', 'DIBATALKAN'];
  if (status && !allowed.includes(status)) throw badRequest('Filter status tidak dikenal.');
  const rows = status ? pengajuanRepo.listByStatus(status, 300) : pengajuanRepo.listRecent(100);
  const q = String(req.query.q || '').trim().toLowerCase();
  const filtered = q
    ? rows.filter(
        (p) =>
          p.public_reference.toLowerCase().includes(q) ||
          (p.student_name || '').toLowerCase().includes(q) ||
          (p.student_nim || '').toLowerCase().includes(q) ||
          (p.nama_surat || '').toLowerCase().includes(q)
      )
    : rows;
  res.json({ pengajuan: filtered.map(summary) });
});

/** Pengajuan yang sedang menunggu keputusan pejabat (pemantauan staf). */
router.get('/proses', (req, res) => {
  res.json({ pengajuan: pengajuanRepo.listByStatus('MENUNGGU_PERSETUJUAN', 200).map(summary) });
});

// ---------------------------------------------------------------------------
// Verifikasi administratif
// ---------------------------------------------------------------------------
router.post(
  '/pengajuan/:id/verifikasi',
  requireJsonObject,
  validateBody({ decision: { required: true, maxLength: 20 }, catatan: { maxLength: 1000 } }),
  asyncHandler(async (req, res) => {
    const decision = String(req.cleanBody.decision).toUpperCase();
    if (!['LANJUT', 'REVISI'].includes(decision)) {
      throw badRequest('Keputusan verifikasi harus LANJUT atau REVISI.', 'INVALID_DECISION');
    }
    const result = await approvalService.verifyByStaff(req.user, Number(req.params.id), {
      decision,
      catatan: req.cleanBody.catatan,
      ip: req.ip,
    });
    res.json({
      message:
        decision === 'LANJUT'
          ? 'Verifikasi administratif disetujui dan surat diteruskan ke pejabat berikutnya.'
          : 'Permintaan revisi dikirim ke mahasiswa.',
      pengajuan: summary(result.pengajuan),
      finalisasi: result.ok === undefined ? null : { berhasil: result.ok, pesan: result.error || null },
    });
  })
);

/** Retry pembuatan PDF tanpa mengulang persetujuan. */
router.post(
  '/pengajuan/:id/retry-pdf',
  asyncHandler(async (req, res) => {
    const pengajuan = pengajuanRepo.findById(req.params.id);
    if (!pengajuan) throw notFound('Pengajuan tidak ditemukan.');
    if (pengajuan.status_pengajuan !== 'MENUNGGU_PERSETUJUAN') {
      throw conflict('Finalisasi hanya dapat dilakukan pada pengajuan yang seluruh tahap wajibnya sudah disetujui.');
    }
    const result = await approvalService.finalizeDocument(pengajuan.id, req.user.id, req.ip);
    if (!result.ok) {
      throw conflict(result.error || 'Gagal membuat PDF.', 'PDF_GENERATION_FAILED');
    }
    res.json({ message: 'Dokumen final berhasil dibuat.', pengajuan: summary(result.pengajuan), surat_number: result.surat_number });
  })
);

// ---------------------------------------------------------------------------
// Katalog template & rute approval
// ---------------------------------------------------------------------------
router.get('/templates', (req, res) => {
  const templates = templateRepo.listAll().map((t) => ({
    id: t.id,
    kode: t.kode,
    nama_surat: t.nama_surat,
    deskripsi: t.deskripsi,
    persyaratan: t.persyaratan,
    is_active: t.is_active,
    form_schema: t.form_schema,
    rute: templateRepo.listRoutes(t.id),
  }));
  res.json({ templates });
});

router.get('/positions', (req, res) => {
  const positions = templateRepo.listPositions().map((p) => ({
    id: p.id,
    position_name: p.position_name,
    description: p.description,
    pejabat: userRepo.listOfficialsByPosition(p.id).map((u) => ({ id: u.id, full_name: u.full_name, is_active: !!u.is_active })),
  }));
  res.json({ positions });
});

router.post(
  '/templates',
  requireJsonObject,
  validateBody({ kode: { required: true, minLength: 2, maxLength: 12 }, nama_surat: { required: true, minLength: 4, maxLength: 150 } }),
  asyncHandler(async (req, res) => {
    const kode = String(req.cleanBody.kode).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!kode) throw badRequest('Kode template tidak valid.');
    if (templateRepo.findByKode(kode)) throw conflict('Kode template sudah digunakan.', 'KODE_TAKEN');

    const schema = sanitizeFormSchema(req.body.form_schema || []);
    if (schema.length === 0) throw badRequest('Skema form minimal memiliki satu field.', 'SCHEMA_EMPTY');

    const template = templateRepo.create({
      kode,
      namaSurat: req.cleanBody.nama_surat,
      deskripsi: req.body.deskripsi ? String(req.body.deskripsi).slice(0, 2000) : null,
      persyaratan: req.body.persyaratan ? String(req.body.persyaratan).slice(0, 2000) : null,
      formSchema: schema,
      isActive: req.body.is_active === false ? 0 : 1,
    });

    if (Array.isArray(req.body.routes) && req.body.routes.length > 0) {
      const routes = sanitizeRoutes(req.body.routes);
      validateRoutesAgainstDb(routes, { userRepo, templateRepo });
      templateRepo.replaceRoutes(template.id, routes);
    }

    auditRepo.log({ actorUserId: req.user.id, action: 'TEMPLATE_DIBUAT', newValue: { kode, nama_surat: template.nama_surat }, ipAddress: req.ip });
    res.status(201).json({ message: 'Template surat dibuat.', template: { id: template.id, kode: template.kode } });
  })
);

router.put(
  '/templates/:id',
  requireJsonObject,
  asyncHandler(async (req, res) => {
    const template = templateRepo.findById(req.params.id);
    if (!template) throw notFound('Template tidak ditemukan.');

    const patch = {};
    if (req.body.nama_surat !== undefined) {
      const nama = String(req.body.nama_surat).trim();
      if (nama.length < 4) throw badRequest('Nama surat minimal 4 karakter.');
      patch.namaSurat = nama;
    }
    if (req.body.deskripsi !== undefined) patch.deskripsi = String(req.body.deskripsi).slice(0, 2000);
    if (req.body.persyaratan !== undefined) patch.persyaratan = String(req.body.persyaratan).slice(0, 2000);
    if (req.body.is_active !== undefined) patch.isActive = !!req.body.is_active;
    if (req.body.form_schema !== undefined) {
      const schema = sanitizeFormSchema(req.body.form_schema);
      if (schema.length === 0) throw badRequest('Skema form minimal memiliki satu field.', 'SCHEMA_EMPTY');
      patch.formSchema = schema;

      // Template yang sudah dipakai pada pengajuan aktif tidak boleh mengubah
      // skema jika perubahan itu menghapus field required yang sudah ada data.
      const missing = template.form_schema.filter((f) => f.required && !schema.some((s) => s.name === f.name));
      if (missing.length > 0) {
        throw conflict(
          `Field wajib tidak dapat dihapus dari template: ${missing.map((f) => f.name).join(', ')}. Nonaktifkan template bila sudah tidak dipakai.`,
          'SCHEMA_BREAKING'
        );
      }
    }

    templateRepo.update(template.id, patch);

    if (Array.isArray(req.body.routes)) {
      const routes = sanitizeRoutes(req.body.routes);
      validateRoutesAgainstDb(routes, { userRepo, templateRepo });
      templateRepo.replaceRoutes(template.id, routes);
    }

    auditRepo.log({
      actorUserId: req.user.id,
      action: 'TEMPLATE_DIPERBARUI',
      oldValue: { nama_surat: template.nama_surat, is_active: template.is_active },
      newValue: patch,
      ipAddress: req.ip,
    });
    res.json({ message: 'Template diperbarui. Perubahan rute hanya berlaku untuk pengajuan baru.' });
  })
);

// ---------------------------------------------------------------------------
// Laporan administratif & audit
// ---------------------------------------------------------------------------
router.get('/laporan', (req, res) => {
  const counts = Object.fromEntries(pengajuanRepo.countByStatus().map((r) => [r.status_pengajuan, r.total]));
  const byTemplate = pengajuanRepo
    .listRecent(1000)
    .reduce((acc, p) => {
      const key = p.nama_surat;
      acc[key] = acc[key] || { nama_surat: key, total: 0, selesai: 0 };
      acc[key].total += 1;
      if (p.status_pengajuan === 'SELESAI') acc[key].selesai += 1;
      return acc;
    }, {});

  const selesai = pengajuanRepo.listByStatus('SELESAI', 500);
  const rataHari = selesai.length
    ? selesai.reduce((sum, p) => sum + (new Date(p.completed_at) - new Date(p.submitted_at)) / 86400000, 0) / selesai.length
    : 0;

  res.json({
    ringkasan: {
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      per_status: counts,
      total_selesai: counts.SELESAI || 0,
      rata_rata_hari_penyelesaian: Number(rataHari.toFixed(2)),
      jumlah_staf: userRepo.listByRole('STAF').length,
      jumlah_pejabat: userRepo.listByRole('PEJABAT').length,
      antrean_pejabat_aktif: approvalRepo.countAllPending(),
    },
    per_template: Object.values(byTemplate),
    dokumen_terbaru: selesai.slice(0, 10).map((p) => ({
      public_reference: p.public_reference,
      surat_number: p.surat_number,
      nama_surat: p.nama_surat,
      student_name: p.student_name,
      completed_at: p.completed_at,
    })),
  });
});

router.get('/audit', (req, res) => {
  res.json({ audit: auditRepo.listRecent(200) });
});

/** Menjalankan pemeriksaan kedaluwarsa revisi secara manual (endpoint admin/staf). */
router.post('/expiry-check', (req, res) => {
  const processed = approvalService.runExpiryCheck();
  res.json({ message: `${processed.length} pengajuan ditandai kedaluwarsa.`, pengajuan_ids: processed });
});

router.get('/pengajuan/:id/detail', (req, res) => {
  const pengajuan = pengajuanRepo.findById(req.params.id);
  if (!pengajuan) throw notFound('Pengajuan tidak ditemukan.');
  res.json(suratService.getSubmissionDetail(pengajuan.id));
});

module.exports = router;
