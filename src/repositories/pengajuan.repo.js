'use strict';

const { getDb } = require('../config/database');
const { nowIso } = require('../utils/date');

const SELECT_BASE = `
  SELECT p.*,
         t.kode AS template_kode, t.nama_surat, t.deskripsi AS template_deskripsi,
         s.full_name AS student_name, s.nim AS student_nim, s.study_program,
         s.email AS student_email
  FROM pengajuan_surat p
  JOIN template_surat t ON t.id = p.template_id
  JOIN users s ON s.id = p.student_id`;

function hydrate(row) {
  if (!row) return null;
  let payload = {};
  try {
    payload = JSON.parse(row.payload_isian_json) || {};
  } catch {
    payload = {};
  }
  return { ...row, payload_isian: payload };
}

function findById(id) {
  return hydrate(getDb().prepare(`${SELECT_BASE} WHERE p.id = ?`).get(id));
}

function findByPublicReference(ref) {
  return hydrate(getDb().prepare(`${SELECT_BASE} WHERE p.public_reference = ?`).get(ref));
}

function findByVerificationTokenHash(hash) {
  return hydrate(getDb().prepare(`${SELECT_BASE} WHERE p.verification_token_hash = ?`).get(hash));
}

function listByStudent(studentId) {
  return getDb()
    .prepare(`${SELECT_BASE} WHERE p.student_id = ? ORDER BY p.created_at DESC`)
    .all(studentId)
    .map(hydrate);
}

function create({ publicReference, studentId, templateId, payload, status, submittedAt }) {
  const info = getDb()
    .prepare(
      `INSERT INTO pengajuan_surat
         (public_reference, student_id, template_id, payload_isian_json, status_pengajuan, tanggal_diajukan, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(publicReference, studentId, templateId, JSON.stringify(payload || {}), status, submittedAt, submittedAt);
  return findById(info.lastInsertRowid);
}

/** Update kolom spesifik (whitelist) — mencegah mass-assignment dari request. */
const MUTABLE = new Set([
  'payload_isian_json', 'version_number', 'current_step', 'status_pengajuan',
  'tanggal_diajukan', 'deadline_revisi', 'submitted_at', 'completed_at',
  'pdf_path', 'pdf_checksum', 'pdf_status', 'pdf_last_error',
  'surat_number', 'issued_at', 'verification_token_hash',
]);

function update(id, patch) {
  const keys = Object.keys(patch).filter((k) => MUTABLE.has(k));
  if (keys.length === 0) return findById(id);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => patch[k]);
  getDb()
    .prepare(`UPDATE pengajuan_surat SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...values, nowIso(), id);
  return findById(id);
}

/** Referensi publik berikutnya, dihitung di dalam transaksi agar tidak duplikat. */
function nextPublicReferenceSequence(tahun) {
  const prefix = `SRT-${tahun}-`;
  const row = getDb()
    .prepare(`SELECT public_reference FROM pengajuan_surat WHERE public_reference LIKE ? ORDER BY public_reference DESC LIMIT 1`)
    .get(`${prefix}%`);
  if (!row) return 1;
  const n = Number.parseInt(row.public_reference.slice(prefix.length), 10);
  return Number.isFinite(n) ? n + 1 : 1;
}

// ---------------------------------------------------------------------------
// Snapshot rute
// ---------------------------------------------------------------------------
function insertSnapshotSteps(pengajuanId, steps) {
  const stmt = getDb().prepare(
    `INSERT INTO approval_routes_snapshot
       (pengajuan_id, urutan_ke, position_id, assigned_employee_id, is_required, position_name)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const s of steps) {
    stmt.run(pengajuanId, s.urutan_ke, s.position_id, s.assigned_employee_id ?? null, s.is_required ? 1 : 0, s.position_name);
  }
}

function listSnapshot(pengajuanId) {
  return getDb()
    .prepare(
      `SELECT sn.*, u.full_name AS assigned_employee_name
       FROM approval_routes_snapshot sn
       LEFT JOIN users u ON u.id = sn.assigned_employee_id
       WHERE sn.pengajuan_id = ? ORDER BY sn.urutan_ke`
    )
    .all(pengajuanId);
}

function findSnapshotStep(pengajuanId, urutanKe) {
  return getDb()
    .prepare('SELECT * FROM approval_routes_snapshot WHERE pengajuan_id = ? AND urutan_ke = ?')
    .get(pengajuanId, urutanKe);
}

// ---------------------------------------------------------------------------
// Riwayat versi & revisi
// ---------------------------------------------------------------------------
function insertRevision({ pengajuanId, versionNumber, payloadSnapshot, revisionReason, requestedBy, requestedByRole, requestStage }) {
  const info = getDb()
    .prepare(
      `INSERT INTO submission_revisions
         (pengajuan_id, version_number, payload_snapshot_json, revision_reason, requested_by, requested_by_role, request_stage)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(pengajuanId, versionNumber, JSON.stringify(payloadSnapshot || {}), revisionReason, requestedBy, requestedByRole, requestStage);
  return getDb().prepare('SELECT * FROM submission_revisions WHERE id = ?').get(info.lastInsertRowid);
}

function listRevisions(pengajuanId) {
  return getDb()
    .prepare(
      `SELECT r.*, u.full_name AS requested_by_name
       FROM submission_revisions r JOIN users u ON u.id = r.requested_by
       WHERE r.pengajuan_id = ? ORDER BY r.version_number`
    )
    .all(pengajuanId);
}

function markRevisionResubmitted(pengajuanId, versionNumber, at) {
  getDb()
    .prepare('UPDATE submission_revisions SET resubmitted_at = ? WHERE pengajuan_id = ? AND version_number = ?')
    .run(at, pengajuanId, versionNumber);
}

function findOpenRevision(pengajuanId) {
  return getDb()
    .prepare('SELECT * FROM submission_revisions WHERE pengajuan_id = ? AND resubmitted_at IS NULL ORDER BY version_number DESC LIMIT 1')
    .get(pengajuanId);
}

// ---------------------------------------------------------------------------
// Antrean (queue) untuk staf & pejabat
// ---------------------------------------------------------------------------
function listByStatus(status, limit = 100) {
  return getDb()
    .prepare(`${SELECT_BASE} WHERE p.status_pengajuan = ? ORDER BY p.submitted_at DESC, p.id DESC LIMIT ?`)
    .all(status, limit)
    .map(hydrate);
}

function listRecent(limit = 20) {
  return getDb().prepare(`${SELECT_BASE} ORDER BY p.created_at DESC LIMIT ?`).all(limit).map(hydrate);
}

/** Pengajuan yang menunggu revisi dan sudah melewati deadline. */
function findExpiredRevisions(now = nowIso()) {
  return getDb()
    .prepare(
      `${SELECT_BASE}
       WHERE p.status_pengajuan = 'PERLU_REVISI'
         AND p.deadline_revisi IS NOT NULL
         AND p.deadline_revisi < ?`
    )
    .all(now)
    .map(hydrate);
}

function countByStatusForStudent(studentId) {
  return getDb()
    .prepare('SELECT status_pengajuan, COUNT(*) AS total FROM pengajuan_surat WHERE student_id = ? GROUP BY status_pengajuan')
    .all(studentId);
}

function countByStatus() {
  return getDb().prepare('SELECT status_pengajuan, COUNT(*) AS total FROM pengajuan_surat GROUP BY status_pengajuan').all();
}

function countCompleted() {
  return getDb().prepare("SELECT COUNT(*) AS total FROM pengajuan_surat WHERE status_pengajuan = 'SELESAI'").get().total;
}

// ---------------------------------------------------------------------------
// Penomoran surat & peristiwa dokumen
// ---------------------------------------------------------------------------

/**
 * Mengambil nomor surat berikutnya untuk template+tahun. Harus dipanggil di
 * dalam transaksi; UNIQUE constraint pada surat_number menjadi pengaman terakhir.
 */
function nextSuratNumber(templateId, kode, tahun) {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO surat_counters (template_id, tahun, last_seq) VALUES (?, ?, 0)').run(templateId, tahun);
  db.prepare('UPDATE surat_counters SET last_seq = last_seq + 1 WHERE template_id = ? AND tahun = ?').run(templateId, tahun);
  const seq = db.prepare('SELECT last_seq FROM surat_counters WHERE template_id = ? AND tahun = ?').get(templateId, tahun).last_seq;
  return `${String(seq).padStart(3, '0')}/E-Office/${kode}/${tahun}`;
}

function logEvent(pengajuanId, eventType, actorUserId = null, payload = null) {
  const info = getDb()
    .prepare('INSERT INTO document_events (pengajuan_id, event_type, actor_user_id, payload_json) VALUES (?, ?, ?, ?)')
    .run(pengajuanId, eventType, actorUserId, payload ? JSON.stringify(payload) : null);
  return info.lastInsertRowid;
}

function listEvents(pengajuanId) {
  return getDb()
    .prepare(
      `SELECT e.*, u.full_name AS actor_name FROM document_events e
       LEFT JOIN users u ON u.id = e.actor_user_id
       WHERE e.pengajuan_id = ? ORDER BY e.id`
    )
    .all(pengajuanId);
}

module.exports = {
  findById,
  findByPublicReference,
  findByVerificationTokenHash,
  listByStudent,
  listByStatus,
  listRecent,
  findExpiredRevisions,
  countByStatusForStudent,
  countByStatus,
  countCompleted,
  create,
  update,
  nextPublicReferenceSequence,
  insertSnapshotSteps,
  listSnapshot,
  findSnapshotStep,
  insertRevision,
  listRevisions,
  markRevisionResubmitted,
  findOpenRevision,
  nextSuratNumber,
  logEvent,
  listEvents,
};
