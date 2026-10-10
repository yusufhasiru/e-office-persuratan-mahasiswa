'use strict';

const { getDb } = require('../config/database');
const { env } = require('../config/env');
const pengajuanRepo = require('../repositories/pengajuan.repo');
const templateRepo = require('../repositories/template.repo');
const approvalRepo = require('../repositories/approval.repo');
const userRepo = require('../repositories/user.repo');
const auditRepo = require('../repositories/audit.repo');
const notifService = require('./notification.service');
const { validatePayload } = require('../validators/form-validator');
const { buildPublicReference } = require('../utils/crypto');
const { nowIso, addDaysIso } = require('../utils/date');
const { badRequest, conflict, forbidden, notFound } = require('../utils/http');

const ACTIVE_STATUSES = ['DRAFT', 'MENUNGGU_VERIFIKASI_STAF', 'MENUNGGU_PERSETUJUAN', 'PERLU_REVISI'];

function humanStatus(status) {
  return String(status || '').toLowerCase().replace(/_/g, ' ');
}

// ---------------------------------------------------------------------------
// Resolusi rute persetujuan -> snapshot beku
// ---------------------------------------------------------------------------

/**
 * Mengubah konfigurasi rute template menjadi snapshot yang siap dieksekusi.
 * Penugasan pejabat divalidasi di sini (backend), bukan dari request pengguna:
 *  - bila tahap menunjuk pegawai tertentu, pegawai itu wajib ada, aktif,
 *    berperan PEJABAT, dan memang memegang jabatan pada tahap tersebut;
 *  - bila tahap hanya menunjuk jabatan, sistem memilih pejabat aktif yang
 *    memegang jabatan itu (deterministik berdasarkan urutan id) dan mencatatnya
 *    di snapshot sehingga tidak bisa dimanipulasi dari frontend.
 */
function resolveRouteSnapshot(templateId) {
  const routes = templateRepo.listRoutes(templateId);
  if (routes.length === 0) {
    throw conflict('Template ini belum memiliki rute persetujuan. Hubungi staf administrasi.', 'ROUTE_MISSING');
  }

  const resolved = [];
  for (const route of routes) {
    const position = templateRepo.findPositionById(route.position_id);
    if (!position) {
      throw conflict(`Jabatan pada tahap ${route.urutan_ke} tidak ditemukan.`, 'POSITION_MISSING');
    }

    let assignee = null;
    if (route.assigned_employee_id) {
      const employee = userRepo.findById(route.assigned_employee_id);
      if (!employee || !employee.is_active || employee.role !== 'PEJABAT' || employee.position_id !== position.id) {
        throw conflict(
          `Pejabat pada tahap ${route.urutan_ke} (${position.position_name}) tidak valid atau tidak aktif.`,
          'ASSIGNEE_INVALID'
        );
      }
      assignee = employee;
    } else {
      const candidates = userRepo.listOfficialsByPosition(position.id);
      if (candidates.length === 0) {
        throw conflict(
          `Belum ada pejabat aktif untuk jabatan ${position.position_name} pada tahap ${route.urutan_ke}.`,
          'ASSIGNEE_MISSING'
        );
      }
      assignee = candidates[0];
    }

    resolved.push({
      urutan_ke: route.urutan_ke,
      position_id: position.id,
      position_name: position.position_name,
      assigned_employee_id: assignee.id,
      assigned_employee_name: assignee.full_name,
      is_required: route.is_required,
    });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Pengajuan baru
// ---------------------------------------------------------------------------

async function createSubmission(user, { templateId, payload }) {
  const template = templateRepo.findById(templateId, { onlyActive: true });
  if (!template) throw badRequest('Template surat tidak ditemukan atau sudah tidak aktif.', 'TEMPLATE_INACTIVE');

  const { valid, errors, data } = validatePayload(template.form_schema, payload);
  if (!valid) {
    const err = badRequest('Data pengajuan belum lengkap atau tidak valid.', 'FORM_INVALID');
    err.details = errors;
    throw err;
  }

  const snapshot = resolveRouteSnapshot(template.id);
  if (!snapshot.some((s) => s.is_required === 1 || s.is_required === true)) {
    throw conflict('Rute persetujuan tidak memiliki tahap wajib.', 'ROUTE_NO_REQUIRED');
  }

  const db = getDb();
  const now = nowIso();
  const create = db.transaction(() => {
    const tahun = new Date().getUTCFullYear();
    const seq = pengajuanRepo.nextPublicReferenceSequence(tahun);
    const reference = buildPublicReference(tahun, seq);

    const created = pengajuanRepo.create({
      publicReference: reference,
      studentId: user.id,
      templateId: template.id,
      payload: data,
      status: 'MENUNGGU_VERIFIKASI_STAF',
      submittedAt: now,
    });

    pengajuanRepo.insertSnapshotSteps(created.id, snapshot);
    approvalRepo.createPending({
      pengajuanId: created.id,
      snapshotStepId: null,
      employeeId: null,
      urutanHierarki: 0,
      roundNumber: 1,
    });
    pengajuanRepo.logEvent(created.id, 'PENGAJUAN_DIBUAT', user.id, { template: template.kode, versi: 1 });
    auditRepo.log({
      actorUserId: user.id,
      submissionId: created.id,
      action: 'PENGAJUAN_DIBUAT',
      newValue: { status: 'MENUNGGU_VERIFIKASI_STAF', template: template.kode, reference },
    });
    return created;
  });

  const created = create();
  notifService.notifyAllStaff(
    'Pengajuan baru menunggu verifikasi',
    `${user.full_name} mengajukan ${template.nama_surat} (${created.public_reference}).`,
    created.id
  );

  return { pengajuan: pengajuanRepo.findById(created.id), snapshot };
}

// ---------------------------------------------------------------------------
// Revisi: pengajuan versi baru
// ---------------------------------------------------------------------------

/**
 * Memeriksa apakah pengajuan masih boleh direvisi. Bila deadline sudah lewat,
 * pengajuan ditandai KEDALUWARSA (fungsi idempoten).
 */
function assertRevisionOpen(pengajuan) {
  if (pengajuan.status_pengajuan !== 'PERLU_REVISI') {
    throw conflict('Pengajuan ini tidak sedang dalam status perlu revisi.', 'NOT_IN_REVISION');
  }
  const deadline = pengajuan.deadline_revisi;
  if (deadline && new Date(deadline).getTime() < Date.now()) {
    const db = getDb();
    db.transaction(() => {
      pengajuanRepo.update(pengajuan.id, { status_pengajuan: 'KEDALUWARSA', deadline_revisi: null });
      approvalRepo.cancelPending(pengajuan.id, pengajuan.version_number, 'Kedaluwarsa karena melewati batas waktu revisi');
      pengajuanRepo.logEvent(pengajuan.id, 'PENGAJUAN_KEDALUWARSA', null, { deadline });
      auditRepo.log({
        actorUserId: null,
        submissionId: pengajuan.id,
        action: 'PENGAJUAN_KEDALUWARSA',
        oldValue: { status: 'PERLU_REVISI' },
        newValue: { status: 'KEDALUWARSA', deadline },
      });
    })();
    notifService.notify(
      pengajuan.student_id,
      'Pengajuan kedaluwarsa',
      `Pengajuan ${pengajuan.public_reference} kedaluwarsa karena melewati batas waktu revisi.`,
      pengajuan.id
    );
    throw conflict('Batas waktu revisi sudah lewat. Pengajuan dinyatakan kedaluwarsa.', 'REVISION_EXPIRED');
  }
}

async function resubmitSubmission(user, pengajuanId, payload) {
  const pengajuan = pengajuanRepo.findById(pengajuanId);
  if (!pengajuan) throw notFound('Pengajuan tidak ditemukan.');
  if (pengajuan.student_id !== user.id) throw forbidden('Pengajuan ini bukan milik Anda.');
  assertRevisionOpen(pengajuan);

  const template = templateRepo.findById(pengajuan.template_id);
  if (!template || !template.is_active) {
    throw conflict('Template surat sudah tidak aktif sehingga tidak dapat dikirim ulang.', 'TEMPLATE_INACTIVE');
  }

  const { valid, errors, data } = validatePayload(template.form_schema, payload);
  if (!valid) {
    const err = badRequest('Data pengajuan belum lengkap atau tidak valid.', 'FORM_INVALID');
    err.details = errors;
    throw err;
  }

  const db = getDb();
  const now = nowIso();
  const newVersion = pengajuan.version_number + 1;

  const tx = db.transaction(() => {
    // Simpan versi lama pada catatan revisi yang sudah ada (payload snapshot
    // memang sudah disimpan saat revisi diminta), lalu tandai sudah dikirim ulang.
    pengajuanRepo.markRevisionResubmitted(pengajuan.id, pengajuan.version_number, now);

    pengajuanRepo.update(pengajuan.id, {
      payload_isian_json: JSON.stringify(data),
      version_number: newVersion,
      status_pengajuan: 'MENUNGGU_VERIFIKASI_STAF',
      current_step: 0,
      deadline_revisi: null,
      submitted_at: now,
      tanggal_diajukan: now,
      // Dokumen final sebelumnya tidak berlaku lagi.
      pdf_path: null,
      pdf_checksum: null,
      pdf_status: null,
      pdf_last_error: null,
      surat_number: null,
      issued_at: null,
      verification_token_hash: null,
      completed_at: null,
    });

    // Semua keputusan yang masih menunggu pada ronde sebelumnya dibatalkan;
    // histori keputusan lama TIDAK dihapus.
    approvalRepo.cancelPending(pengajuan.id, pengajuan.version_number, `Versi ${newVersion} dikirim ulang`);

    approvalRepo.createPending({
      pengajuanId: pengajuan.id,
      snapshotStepId: null,
      employeeId: null,
      urutanHierarki: 0,
      roundNumber: newVersion,
    });

    pengajuanRepo.logEvent(pengajuan.id, 'PENGAJUAN_DIKIRIM_ULANG', user.id, { versi: newVersion });
    auditRepo.log({
      actorUserId: user.id,
      submissionId: pengajuan.id,
      action: 'PENGAJUAN_DIKIRIM_ULANG',
      oldValue: { version_number: pengajuan.version_number, status: 'PERLU_REVISI' },
      newValue: { version_number: newVersion, status: 'MENUNGGU_VERIFIKASI_STAF' },
    });
  });
  tx();

  notifService.notifyAllStaff(
    'Pengajuan dikirim ulang',
    `${user.full_name} mengirim ulang ${pengajuan.public_reference} (versi ${newVersion}) untuk diverifikasi.`,
    pengajuan.id
  );

  return pengajuanRepo.findById(pengajuan.id);
}

// ---------------------------------------------------------------------------
// Pembatalan oleh mahasiswa
// ---------------------------------------------------------------------------

function cancelSubmission(user, pengajuanId, alasan) {
  const pengajuan = pengajuanRepo.findById(pengajuanId);
  if (!pengajuan) throw notFound('Pengajuan tidak ditemukan.');
  if (pengajuan.student_id !== user.id) throw forbidden('Pengajuan ini bukan milik Anda.');
  if (!['DRAFT', 'MENUNGGU_VERIFIKASI_STAF', 'PERLU_REVISI', 'MENUNGGU_PERSETUJUAN'].includes(pengajuan.status_pengajuan)) {
    throw conflict('Pengajuan dengan status ini tidak dapat dibatalkan.', 'CANCEL_NOT_ALLOWED');
  }

  const db = getDb();
  const now = nowIso();
  db.transaction(() => {
    pengajuanRepo.update(pengajuan.id, {
      status_pengajuan: 'DIBATALKAN',
      deadline_revisi: null,
      completed_at: now,
    });
    approvalRepo.cancelPending(pengajuan.id, pengajuan.version_number, 'Pengajuan dibatalkan oleh mahasiswa');
    pengajuanRepo.logEvent(pengajuan.id, 'PENGAJUAN_DIBATALKAN', user.id, { alasan: alasan || null });
    auditRepo.log({
      actorUserId: user.id,
      submissionId: pengajuan.id,
      action: 'PENGAJUAN_DIBATALKAN',
      oldValue: { status: pengajuan.status_pengajuan },
      newValue: { status: 'DIBATALKAN', alasan: alasan || null },
    });
  })();

  return pengajuanRepo.findById(pengajuan.id);
}

// ---------------------------------------------------------------------------
// Detail pengajuan (dipakai semua role, dengan penyaringan di route)
// ---------------------------------------------------------------------------

function getSubmissionDetail(pengajuanId) {
  const pengajuan = pengajuanRepo.findById(pengajuanId);
  if (!pengajuan) return null;
  const template = templateRepo.findById(pengajuan.template_id);
  const snapshot = pengajuanRepo.listSnapshot(pengajuanId);
  const approvals = approvalRepo.listBySubmission(pengajuanId);
  return {
    pengajuan,
    template: template
      ? { id: template.id, kode: template.kode, nama_surat: template.nama_surat, deskripsi: template.deskripsi, persyaratan: template.persyaratan, form_schema: template.form_schema }
      : null,
    snapshot,
    approvals,
    revisions: pengajuanRepo.listRevisions(pengajuanId),
    events: pengajuanRepo.listEvents(pengajuanId),
    audit: auditRepo.listBySubmission(pengajuanId),
    deadline_days: env.revisionDeadlineDays,
    active_statuses: ACTIVE_STATUSES,
  };
}

module.exports = {
  createSubmission,
  resubmitSubmission,
  cancelSubmission,
  getSubmissionDetail,
  resolveRouteSnapshot,
  assertRevisionOpen,
  ACTIVE_STATUSES,
  humanStatus,
};
