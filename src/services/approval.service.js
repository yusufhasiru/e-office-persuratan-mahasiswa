'use strict';

const { getDb } = require('../config/database');
const { env } = require('../config/env');
const pengajuanRepo = require('../repositories/pengajuan.repo');
const approvalRepo = require('../repositories/approval.repo');
const templateRepo = require('../repositories/template.repo');
const userRepo = require('../repositories/user.repo');
const auditRepo = require('../repositories/audit.repo');
const notifService = require('./notification.service');
const pdfService = require('./pdf.service');
const { nowIso, addDaysIso } = require('../utils/date');
const { generateVerificationToken, hashVerificationToken } = require('../utils/crypto');
const { badRequest, conflict, forbidden, notFound } = require('../utils/http');

const DECISIONS = { SETUJU: 'SETUJU', TOLAK: 'TOLAK', REVISI: 'REVISI' };

function requireReason(catatan, actionLabel) {
  const note = String(catatan || '').trim();
  if (note.length < 5) throw badRequest(`Alasan ${actionLabel} wajib diisi (minimal 5 karakter).`, 'REASON_REQUIRED');
  if (note.length > 1000) throw badRequest('Alasan maksimal 1000 karakter.', 'REASON_TOO_LONG');
  return note;
}

function isRequired(step) {
  return step.is_required === 1 || step.is_required === true;
}

// ---------------------------------------------------------------------------
// Aktivasi tahap
// ---------------------------------------------------------------------------

/** Membuat baris antrean untuk sebuah tahap pejabat pada ronde berjalan. */
function activateStage(pengajuanId, roundNumber, step, actorId = null) {
  const assignee = userRepo.findById(step.assigned_employee_id);
  if (!assignee || !assignee.is_active || assignee.role !== 'PEJABAT') {
    throw conflict(
      `Pejabat yang ditugaskan pada tahap ${step.urutan_ke} (${step.position_name}) tidak aktif. Hubungi administrator.`,
      'ASSIGNEE_INACTIVE'
    );
  }
  const pending = approvalRepo.createPending({
    pengajuanId,
    snapshotStepId: step.id,
    employeeId: assignee.id,
    urutanHierarki: step.urutan_ke,
    roundNumber,
  });
  pengajuanRepo.logEvent(pengajuanId, 'TAHAP_DIAKTIFKAN', actorId, {
    urutan_ke: step.urutan_ke,
    jabatan: step.position_name,
    pejabat: assignee.full_name,
    ronde: roundNumber,
  });
  return pending;
}

/**
 * Mengaktifkan tahap wajib berikutnya. Tahap opsional (is_required=0) dicatat
 * sebagai dilewati otomatis. Mengembalikan urutan tahap yang aktif, atau null
 * bila seluruh tahap wajib sudah selesai.
 */
function activateNextRequiredStage(pengajuanId, roundNumber, snapshot, approvedOrders, actorId) {
  for (const step of snapshot) {
    if (approvedOrders.has(step.urutan_ke)) continue;
    if (isRequired(step)) {
      const pending = activateStage(pengajuanId, roundNumber, step, actorId);
      return { activeStep: step, pending };
    }
    approvalRepo.createDecision({
      pengajuanId,
      snapshotStepId: step.id,
      employeeId: null,
      urutanHierarki: step.urutan_ke,
      roundNumber,
      status: 'DILANJUTKAN',
      catatan: 'Tahap opsional dilewati otomatis oleh sistem',
    });
  }
  return { activeStep: null, pending: null };
}

function approvedOrdersThisRound(pengajuanId, roundNumber) {
  const rows = approvalRepo.listBySubmission(pengajuanId, roundNumber);
  return new Set(rows.filter((r) => r.status_persetujuan === 'DISETUJUI').map((r) => r.urutan_hierarki));
}

// ---------------------------------------------------------------------------
// Verifikasi staf
// ---------------------------------------------------------------------------

async function verifyByStaff(user, pengajuanId, { decision, catatan, ip }) {
  if (user.role !== 'STAF') throw forbidden('Hanya staf administrasi yang dapat memverifikasi pengajuan.');

  const pengajuan = pengajuanRepo.findById(pengajuanId);
  if (!pengajuan) throw notFound('Pengajuan tidak ditemukan.');
  if (pengajuan.status_pengajuan !== 'MENUNGGU_VERIFIKASI_STAF') {
    throw conflict('Pengajuan ini tidak sedang menunggu verifikasi staf.', 'INVALID_STATE');
  }

  const round = pengajuan.version_number;
  const note = decision === 'REVISI' ? requireReason(catatan, 'permintaan revisi') : String(catatan || '').trim() || null;
  const db = getDb();
  const now = nowIso();

  const result = db.transaction(() => {
    const pending = approvalRepo.findPendingStep(pengajuanId, round, 0);
    if (!pending) throw conflict('Pengajuan ini sudah diproses oleh staf lain.', 'ALREADY_PROCESSED');

    if (decision === 'REVISI') {
      const decided = approvalRepo.decide(pending.id, { status: 'REVISI', catatan: note, employeeId: user.id });
      if (!decided) throw conflict('Pengajuan ini sudah diproses oleh staf lain.', 'ALREADY_PROCESSED');

      const deadline = addDaysIso(now, env.revisionDeadlineDays);
      pengajuanRepo.update(pengajuanId, { status_pengajuan: 'PERLU_REVISI', deadline_revisi: deadline });
      pengajuanRepo.insertRevision({
        pengajuanId,
        versionNumber: round,
        payloadSnapshot: pengajuan.payload_isian,
        revisionReason: note,
        requestedBy: user.id,
        requestedByRole: user.role,
        requestStage: 'VERIFIKASI_STAF',
      });
      pengajuanRepo.logEvent(pengajuanId, 'REVISI_DIMINTA', user.id, { oleh: 'STAF', catatan: note, deadline });
      auditRepo.log({
        actorUserId: user.id,
        submissionId: pengajuanId,
        action: 'REVISI_DIMINTA_STAF',
        oldValue: { status: 'MENUNGGU_VERIFIKASI_STAF' },
        newValue: { status: 'PERLU_REVISI', deadline, catatan: note },
        ipAddress: ip,
      });
      return { finalStatus: 'PERLU_REVISI', deadline };
    }

    // decision === 'LANJUT'
    const decided = approvalRepo.decide(pending.id, { status: 'DILANJUTKAN', catatan: note, employeeId: user.id });
    if (!decided) throw conflict('Pengajuan ini sudah diproses oleh staf lain.', 'ALREADY_PROCESSED');

    const snapshot = pengajuanRepo.listSnapshot(pengajuanId);
    const approved = approvedOrdersThisRound(pengajuanId, round);
    const { activeStep } = activateNextRequiredStage(pengajuanId, round, snapshot, approved, user.id);

    if (!activeStep) {
      pengajuanRepo.update(pengajuanId, { status_pengajuan: 'MENUNGGU_PERSETUJUAN', current_step: 0, pdf_status: 'PENDING' });
      pengajuanRepo.logEvent(pengajuanId, 'MENUNGGU_FINALISASI', user.id, { catatan: 'Tidak ada tahap pejabat wajib' });
      return { finalStatus: 'MENUNGGU_PERSETUJUAN', activeStep: null, needFinalize: true };
    }

    pengajuanRepo.update(pengajuanId, { status_pengajuan: 'MENUNGGU_PERSETUJUAN', current_step: activeStep.urutan_ke });
    auditRepo.log({
      actorUserId: user.id,
      submissionId: pengajuanId,
      action: 'VERIFIKASI_STAF_DISETUJUI',
      oldValue: { status: 'MENUNGGU_VERIFIKASI_STAF' },
      newValue: { status: 'MENUNGGU_PERSETUJUAN', tahap: activeStep.urutan_ke, pejabat: activeStep.position_name },
      ipAddress: ip,
    });
    return { finalStatus: 'MENUNGGU_PERSETUJUAN', activeStep, needFinalize: false };
  });

  const outcome = result();

  if (outcome.finalStatus === 'PERLU_REVISI') {
    notifService.notify(
      pengajuan.student_id,
      'Pengajuan perlu revisi',
      `Pengajuan ${pengajuan.public_reference} perlu direvisi. Alasan: ${note}`,
      pengajuanId
    );
  } else if (outcome.activeStep) {
    notifService.notify(
      outcome.activeStep.assigned_employee_id,
      'Surat menunggu persetujuan Anda',
      `${pengajuan.public_reference} — ${pengajuan.nama_surat} menunggu keputusan Anda sebagai ${outcome.activeStep.position_name}.`,
      pengajuanId
    );
    notifService.notify(
      pengajuan.student_id,
      'Pengajuan lolos verifikasi staf',
      `Pengajuan ${pengajuan.public_reference} diteruskan ke ${outcome.activeStep.position_name}.`,
      pengajuanId
    );
  }

  if (outcome.needFinalize) {
    return { ...(await finalizeDocument(pengajuanId, user.id, ip)), pengajuan: pengajuanRepo.findById(pengajuanId) };
  }

  return { pengajuan: pengajuanRepo.findById(pengajuanId), activeStep: outcome.activeStep || null };
}

// ---------------------------------------------------------------------------
// Keputusan pejabat
// ---------------------------------------------------------------------------

async function decideByOfficial(user, pengajuanId, { decision, catatan, ip }) {
  if (user.role !== 'PEJABAT') throw forbidden('Hanya pejabat pemaraf yang dapat memberikan keputusan.');

  const pengajuan = pengajuanRepo.findById(pengajuanId);
  if (!pengajuan) throw notFound('Pengajuan tidak ditemukan.');
  if (pengajuan.status_pengajuan !== 'MENUNGGU_PERSETUJUAN') {
    throw conflict('Pengajuan ini tidak sedang menunggu persetujuan pejabat.', 'INVALID_STATE');
  }

  const round = pengajuan.version_number;
  const note = decision === DECISIONS.SETUJU ? String(catatan || '').trim() || null : requireReason(catatan, decision === DECISIONS.TOLAK ? 'penolakan' : 'permintaan revisi');
  const db = getDb();
  const now = nowIso();

  const tx = db.transaction(() => {
    const pending = approvalRepo.findPendingStep(pengajuanId, round, pengajuan.current_step);

    // Permintaan ganda: pejabat yang sudah memutuskan pada ronde ini tidak boleh
    // membuat keputusan kedua, meskipun pengajuan sudah berpindah tahap.
    const alreadyDecidedThisRound = approvalRepo
      .listBySubmission(pengajuanId, round)
      .some((a) => a.employee_id === user.id && !['MENUNGGU', 'DIBATALKAN'].includes(a.status_persetujuan));
    if (alreadyDecidedThisRound && (!pending || pending.employee_id !== user.id)) {
      throw conflict('Anda sudah memberikan keputusan pada versi pengajuan ini.', 'ALREADY_PROCESSED');
    }

    if (!pending) throw conflict('Tahap ini sudah diproses atau tidak lagi aktif.', 'ALREADY_PROCESSED');

    // Pejabat hanya boleh memutuskan bila dirinya memang ditugaskan pada tahap itu.
    if (pending.employee_id !== user.id) {
      throw forbidden('Tahap ini bukan kewenangan Anda.', 'NOT_ASSIGNED');
    }

    if (decision === DECISIONS.REVISI) {
      const decided = approvalRepo.decide(pending.id, { status: 'REVISI', catatan: note, employeeId: user.id });
      if (!decided) throw conflict('Tahap ini sudah diproses.', 'ALREADY_PROCESSED');

      const deadline = addDaysIso(now, env.revisionDeadlineDays);
      pengajuanRepo.update(pengajuanId, { status_pengajuan: 'PERLU_REVISI', deadline_revisi: deadline });
      approvalRepo.cancelPending(pengajuanId, round, 'Dibatalkan karena permintaan revisi');
      pengajuanRepo.insertRevision({
        pengajuanId,
        versionNumber: round,
        payloadSnapshot: pengajuan.payload_isian,
        revisionReason: note,
        requestedBy: user.id,
        requestedByRole: user.role,
        requestStage: `PERSETUJUAN_TAHAP_${pending.urutan_hierarki}`,
      });
      pengajuanRepo.logEvent(pengajuanId, 'REVISI_DIMINTA', user.id, { oleh: 'PEJABAT', catatan: note, deadline });
      auditRepo.log({
        actorUserId: user.id,
        submissionId: pengajuanId,
        action: 'REVISI_DIMINTA_PEJABAT',
        oldValue: { status: 'MENUNGGU_PERSETUJUAN' },
        newValue: { status: 'PERLU_REVISI', deadline, catatan: note, tahap: pending.urutan_hierarki },
        ipAddress: ip,
      });
      return { finalStatus: 'PERLU_REVISI', deadline, pending };
    }

    if (decision === DECISIONS.TOLAK) {
      const decided = approvalRepo.decide(pending.id, { status: 'DITOLAK', catatan: note, employeeId: user.id });
      if (!decided) throw conflict('Tahap ini sudah diproses.', 'ALREADY_PROCESSED');
      pengajuanRepo.update(pengajuanId, { status_pengajuan: 'DITOLAK', completed_at: now, current_step: 0 });
      approvalRepo.cancelPending(pengajuanId, round, 'Dibatalkan karena pengajuan ditolak');
      pengajuanRepo.logEvent(pengajuanId, 'PENGAJUAN_DITOLAK', user.id, { catatan: note, tahap: pending.urutan_hierarki });
      auditRepo.log({
        actorUserId: user.id,
        submissionId: pengajuanId,
        action: 'PENGAJUAN_DITOLAK',
        oldValue: { status: 'MENUNGGU_PERSETUJUAN' },
        newValue: { status: 'DITOLAK', catatan: note, tahap: pending.urutan_hierarki },
        ipAddress: ip,
      });
      return { finalStatus: 'DITOLAK', pending };
    }

    // decision === 'SETUJU'
    const decided = approvalRepo.decide(pending.id, { status: 'DISETUJUI', catatan: note, employeeId: user.id });
    if (!decided) throw conflict('Tahap ini sudah diproses.', 'ALREADY_PROCESSED');

    const snapshot = pengajuanRepo.listSnapshot(pengajuanId);
    const approved = approvedOrdersThisRound(pengajuanId, round);
    const { activeStep } = activateNextRequiredStage(pengajuanId, round, snapshot, approved, user.id);

    auditRepo.log({
      actorUserId: user.id,
      submissionId: pengajuanId,
      action: 'TAHAP_DISETUJUI',
      oldValue: { status: 'MENUNGGU_PERSETUJUAN', tahap: pending.urutan_hierarki },
      newValue: { tahap_berikutnya: activeStep ? activeStep.urutan_ke : null },
      ipAddress: ip,
    });
    pengajuanRepo.logEvent(pengajuanId, 'TAHAP_DISETUJUI', user.id, { tahap: pending.urutan_hierarki });

    if (!activeStep) {
      pengajuanRepo.update(pengajuanId, { status_pengajuan: 'MENUNGGU_PERSETUJUAN', current_step: 0, pdf_status: 'PENDING' });
      pengajuanRepo.logEvent(pengajuanId, 'MENUNGGU_FINALISASI', user.id, { catatan: 'Seluruh tahap wajib disetujui' });
      return { finalStatus: 'MENUNGGU_PERSETUJUAN', pending, needFinalize: true };
    }

    pengajuanRepo.update(pengajuanId, { status_pengajuan: 'MENUNGGU_PERSETUJUAN', current_step: activeStep.urutan_ke });
    return { finalStatus: 'MENUNGGU_PERSETUJUAN', pending, activeStep, needFinalize: false };
  });

  const outcome = tx();

  if (outcome.finalStatus === 'PERLU_REVISI') {
    notifService.notify(
      pengajuan.student_id,
      'Pengajuan perlu revisi',
      `${pengajuan.public_reference} perlu direvisi oleh Anda. Alasan: ${note}`,
      pengajuanId
    );
  } else if (outcome.finalStatus === 'DITOLAK') {
    notifService.notify(
      pengajuan.student_id,
      'Pengajuan ditolak',
      `${pengajuan.public_reference} ditolak. Alasan: ${note}`,
      pengajuanId
    );
  } else if (outcome.activeStep) {
    notifService.notify(
      outcome.activeStep.assigned_employee_id,
      'Surat menunggu persetujuan Anda',
      `${pengajuan.public_reference} — ${pengajuan.nama_surat} menunggu keputusan Anda sebagai ${outcome.activeStep.position_name}.`,
      pengajuanId
    );
    notifService.notify(
      pengajuan.student_id,
      'Progres persetujuan',
      `${pengajuan.public_reference} telah disetujui dan diteruskan ke ${outcome.activeStep.position_name}.`,
      pengajuanId
    );
  }

  if (outcome.needFinalize) {
    const finalize = await finalizeDocument(pengajuanId, user.id, ip);
    return { ...finalize, pengajuan: pengajuanRepo.findById(pengajuanId) };
  }

  return { pengajuan: pengajuanRepo.findById(pengajuanId), activeStep: outcome.activeStep || null };
}

// ---------------------------------------------------------------------------
// Finalisasi dokumen (nomor surat, PDF, QR)
// ---------------------------------------------------------------------------

/**
 * Membuat PDF final. Nomor surat & token verifikasi dialokasikan di dalam
 * transaksi; pembuatan file dilakukan di luar transaksi sehingga kegagalan PDF
 * TIDAK pernah membuat status menjadi SELESAI dan bisa di-retry tanpa
 * mengulang persetujuan.
 */
async function finalizeDocument(pengajuanId, actorUserId, ip = null) {
  const pengajuan = pengajuanRepo.findById(pengajuanId);
  if (!pengajuan) throw notFound('Pengajuan tidak ditemukan.');
  if (pengajuan.status_pengajuan !== 'MENUNGGU_PERSETUJUAN') {
    throw conflict('Dokumen hanya dapat difinalisasi setelah seluruh tahap selesai disetujui.', 'INVALID_STATE');
  }

  const template = templateRepo.findById(pengajuan.template_id);
  const snapshot = pengajuanRepo.listSnapshot(pengajuanId);
  const db = getDb();
  const now = nowIso();

  const prep = db.transaction(() => {
    const approvals = approvalRepo.listBySubmission(pengajuanId, pengajuan.version_number);
    const approvedOrders = new Set(approvals.filter((a) => a.status_persetujuan === 'DISETUJUI').map((a) => a.urutan_hierarki));
    const requiredSteps = snapshot.filter(isRequired);
    const missing = requiredSteps.filter((s) => !approvedOrders.has(s.urutan_ke));
    if (requiredSteps.length === 0 || missing.length > 0) {
      throw conflict(
        `Belum semua tahap wajib disetujui (${missing.map((m) => m.position_name).join(', ') || 'tidak ada tahap wajib'}).`,
        'APPROVAL_INCOMPLETE'
      );
    }

    const year = new Date().getUTCFullYear();
    const suratNumber = pengajuan.surat_number || pengajuanRepo.nextSuratNumber(pengajuan.template_id, template.kode, year);
    const token = generateVerificationToken();
    const tokenHash = hashVerificationToken(token);

    pengajuanRepo.update(pengajuanId, {
      surat_number: suratNumber,
      verification_token_hash: tokenHash,
      pdf_status: 'PENDING',
      pdf_last_error: null,
      issued_at: pengajuan.issued_at || now,
    });
    pengajuanRepo.logEvent(pengajuanId, 'FINALISASI_DIMULAI', actorUserId, { surat_number: suratNumber });
    return { suratNumber, token, approvals };
  });

  const { suratNumber, token, approvals } = prep();

  const approvers = approvals
    .filter((a) => a.status_persetujuan === 'DISETUJUI' && a.urutan_hierarki >= 1)
    .sort((a, b) => a.urutan_hierarki - b.urutan_hierarki)
    .map((a) => ({
      urutan_ke: a.urutan_hierarki,
      employee_name: a.employee_name || '-',
      position_name: a.employee_position || '-',
      waktu_diproses: a.waktu_diproses,
    }));

  const verificationUrl = `${env.baseUrl}/verify/${token}`;
  const fresh = pengajuanRepo.findById(pengajuanId);

  try {
    const summaryRows = require('../validators/form-validator')
      .summarizePayload(template.form_schema, fresh.payload_isian)
      .map((r) => ({ ...r, display: r.value }));

    const buffer = await pdfService.buildPdfBuffer({
      pengajuan: fresh,
      template: { kode: template.kode, nama_surat: template.nama_surat, summaryRows },
      snapshot,
      approvers,
      verificationUrl,
    });

    const stored = pdfService.storePdf(fresh, buffer);

    const commit = db.transaction(() => {
      pengajuanRepo.update(pengajuanId, {
        status_pengajuan: 'SELESAI',
        pdf_path: stored.relativePath,
        pdf_checksum: stored.checksum,
        pdf_status: 'READY',
        pdf_last_error: null,
        completed_at: nowIso(),
      });
      pengajuanRepo.logEvent(pengajuanId, 'DOKUMEN_FINAL_DIBUAT', actorUserId, {
        surat_number: suratNumber,
        checksum: stored.checksum,
        ukuran_byte: stored.size,
      });
      auditRepo.log({
        actorUserId,
        submissionId: pengajuanId,
        action: 'DOKUMEN_FINAL_DIBUAT',
        oldValue: { status: 'MENUNGGU_PERSETUJUAN' },
        newValue: { status: 'SELESAI', surat_number: suratNumber, checksum: stored.checksum },
        ipAddress: ip,
      });
    });
    commit();

    notifService.notify(
      fresh.student_id,
      'Surat selesai dan siap diunduh',
      `Surat ${suratNumber} untuk pengajuan ${fresh.public_reference} telah selesai. Silakan unduh dokumen final.`,
      pengajuanId
    );

    return { ok: true, pengajuan: pengajuanRepo.findById(pengajuanId), surat_number: suratNumber, verification_url: verificationUrl };
  } catch (error) {
    const safeMessage = error && error.expected ? error.message : 'Gagal membuat berkas PDF final. Silakan coba lagi.';
    const fail = db.transaction(() => {
      pengajuanRepo.update(pengajuanId, { pdf_status: 'FAILED', pdf_last_error: safeMessage });
      pengajuanRepo.logEvent(pengajuanId, 'FINALISASI_GAGAL', actorUserId, { pesan: safeMessage });
      auditRepo.log({
        actorUserId,
        submissionId: pengajuanId,
        action: 'FINALISASI_GAGAL',
        newValue: { pesan: safeMessage, surat_number: suratNumber },
        ipAddress: ip,
      });
    });
    fail();
    // Status tetap MENUNGGU_PERSETUJUAN agar bisa di-retry tanpa mengulang approval.
    return { ok: false, error: safeMessage, pengajuan: pengajuanRepo.findById(pengajuanId), surat_number: suratNumber };
  }
}

// ---------------------------------------------------------------------------
// Kedaluwarsa
// ---------------------------------------------------------------------------

/**
 * Menandai pengajuan PERLU_REVISI yang melewati batas waktu revisi sebagai
 * KEDALUWARSA. Deadline dihitung dalam hari kalender sejak revisi diminta.
 */
function runExpiryCheck() {
  const now = nowIso();
  const expired = pengajuanRepo.findExpiredRevisions(now);
  const db = getDb();
  const processed = [];

  for (const pengajuan of expired) {
    const tx = db.transaction(() => {
      const fresh = pengajuanRepo.findById(pengajuan.id);
      if (!fresh || fresh.status_pengajuan !== 'PERLU_REVISI') return false;
      if (!fresh.deadline_revisi || new Date(fresh.deadline_revisi).getTime() >= Date.now()) return false;
      pengajuanRepo.update(fresh.id, { status_pengajuan: 'KEDALUWARSA', deadline_revisi: null });
      approvalRepo.cancelPending(fresh.id, fresh.version_number, 'Kedaluwarsa karena melewati batas waktu revisi');
      pengajuanRepo.logEvent(fresh.id, 'PENGAJUAN_KEDALUWARSA', null, { deadline: fresh.deadline_revisi });
      auditRepo.log({
        submissionId: fresh.id,
        action: 'PENGAJUAN_KEDALUWARSA',
        oldValue: { status: 'PERLU_REVISI' },
        newValue: { status: 'KEDALUWARSA', deadline: fresh.deadline_revisi },
      });
      return true;
    });
    if (tx()) {
      processed.push(pengajuan.id);
      notifService.notify(
        pengajuan.student_id,
        'Pengajuan kedaluwarsa',
        `Pengajuan ${pengajuan.public_reference} kedaluwarsa karena melewati batas waktu revisi. Silakan ajukan surat baru.`,
        pengajuan.id
      );
    }
  }
  return processed;
}

module.exports = {
  DECISIONS,
  activateStage,
  activateNextRequiredStage,
  verifyByStaff,
  decideByOfficial,
  finalizeDocument,
  runExpiryCheck,
  approvedOrdersThisRound,
};
