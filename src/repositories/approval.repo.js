'use strict';

const { getDb } = require('../config/database');

const SELECT_BASE = `
  SELECT j.*,
         u.full_name AS employee_name,
         s.position_name AS employee_position,
         sn.urutan_ke AS step_urutan_ke,
         sn.is_required AS step_is_required,
         sn.position_id AS step_position_id
  FROM jalur_persetujuan j
  LEFT JOIN users u ON u.id = j.employee_id
  LEFT JOIN positions s ON s.id = u.position_id
  LEFT JOIN approval_routes_snapshot sn ON sn.id = j.snapshot_step_id`;

function hydrate(row) {
  if (!row) return null;
  return { ...row, step_is_required: row.step_is_required === null ? null : !!row.step_is_required };
}

function findById(id) {
  return hydrate(getDb().prepare(`${SELECT_BASE} WHERE j.id = ?`).get(id));
}

/** Membuat baris tahap yang sedang menunggu keputusan (satu per pengajuan/ronde/tahap). */
function createPending({ pengajuanId, snapshotStepId, employeeId, urutanHierarki, roundNumber, attemptNumber = 1 }) {
  const info = getDb()
    .prepare(
      `INSERT INTO jalur_persetujuan
         (pengajuan_id, snapshot_step_id, employee_id, urutan_hierarki, round_number, status_persetujuan, attempt_number)
       VALUES (?, ?, ?, ?, ?, 'MENUNGGU', ?)`
    )
    .run(pengajuanId, snapshotStepId, employeeId, urutanHierarki, roundNumber, attemptNumber);
  return findById(info.lastInsertRowid);
}

/** Baris non-tahap (mis. verifikasi staf) yang tidak punya snapshot step. */
function createDecision({
  pengajuanId,
  snapshotStepId = null,
  employeeId,
  urutanHierarki,
  roundNumber,
  status,
  catatan = null,
  attemptNumber = 1,
}) {
  const info = getDb()
    .prepare(
      `INSERT INTO jalur_persetujuan
         (pengajuan_id, snapshot_step_id, employee_id, urutan_hierarki, round_number, status_persetujuan, catatan, waktu_diproses, attempt_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(pengajuanId, snapshotStepId, employeeId, urutanHierarki, roundNumber, status, catatan, new Date().toISOString(), attemptNumber);
  return findById(info.lastInsertRowid);
}

/**
 * Keputusan idempoten: hanya berhasil bila baris masih MENUNGGU.
 * Mengembalikan null bila sudah diproses (mencegah keputusan ganda).
 */
function decide(rowId, { status, catatan, employeeId }) {
  const result = getDb()
    .prepare(
      `UPDATE jalur_persetujuan
          SET status_persetujuan = ?, catatan = COALESCE(?, catatan), waktu_diproses = ?,
              employee_id = COALESCE(?, employee_id)
        WHERE id = ? AND status_persetujuan = 'MENUNGGU'`
    )
    .run(status, catatan ?? null, new Date().toISOString(), employeeId ?? null, rowId);
  if (result.changes !== 1) return null;
  return findById(rowId);
}

function findPendingStep(pengajuanId, roundNumber, urutanKe) {
  return hydrate(
    getDb()
      .prepare(
        `${SELECT_BASE} WHERE j.pengajuan_id = ? AND j.round_number = ? AND j.urutan_hierarki = ? AND j.status_persetujuan = 'MENUNGGU'`
      )
      .get(pengajuanId, roundNumber, urutanKe)
  );
}

function listBySubmission(pengajuanId, roundNumber = null) {
  const sql = roundNumber
    ? `${SELECT_BASE} WHERE j.pengajuan_id = ? AND j.round_number = ? ORDER BY j.urutan_hierarki`
    : `${SELECT_BASE} WHERE j.pengajuan_id = ? ORDER BY j.round_number, j.urutan_hierarki`;
  const args = roundNumber ? [pengajuanId, roundNumber] : [pengajuanId];
  return getDb().prepare(sql).all(...args).map(hydrate);
}

/** Antrean pejabat: hanya keputusan yang memang menunggu dia. */
function listQueueForEmployee(employeeId) {
  return getDb()
    .prepare(
      `SELECT j.id AS jalur_id, p.*, t.nama_surat, t.kode AS template_kode,
              s.full_name AS student_name, s.nim AS student_nim, s.study_program
       FROM jalur_persetujuan j
       JOIN pengajuan_surat p ON p.id = j.pengajuan_id
       JOIN template_surat t ON t.id = p.template_id
       JOIN users s ON s.id = p.student_id
       WHERE j.employee_id = ? AND j.status_persetujuan = 'MENUNGGU'
         AND p.status_pengajuan = 'MENUNGGU_PERSETUJUAN'
         AND j.round_number = p.version_number
       ORDER BY j.created_at ASC`
    )
    .all(employeeId);
}

/** Semua keputusan yang pernah ditangani pejabat tersebut (histori). */
function listHistoryForEmployee(employeeId) {
  return getDb()
    .prepare(
      `SELECT j.*, p.public_reference, p.status_pengajuan, p.payload_isian_json,
              p.verification_token_hash, p.version_number AS submission_version,
              t.nama_surat, t.kode AS template_kode, s.full_name AS student_name, s.nim AS student_nim
       FROM jalur_persetujuan j
       JOIN pengajuan_surat p ON p.id = j.pengajuan_id
       JOIN template_surat t ON t.id = p.template_id
       JOIN users s ON s.id = p.student_id
       WHERE j.employee_id = ? AND j.status_persetujuan <> 'MENUNGGU'
       ORDER BY j.waktu_diproses DESC NULLS LAST`
    )
    .all(employeeId);
}

function countQueueForEmployee(employeeId) {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS total FROM jalur_persetujuan j
       JOIN pengajuan_surat p ON p.id = j.pengajuan_id
       WHERE j.employee_id = ? AND j.status_persetujuan = 'MENUNGGU'
         AND p.status_pengajuan = 'MENUNGGU_PERSETUJUAN'
         AND j.round_number = p.version_number`
    )
    .get(employeeId).total;
}

/** Total tahap pejabat yang sedang menunggu keputusan (di seluruh sistem). */
function countAllPending() {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS total FROM jalur_persetujuan j
       JOIN pengajuan_surat p ON p.id = j.pengajuan_id
       WHERE j.status_persetujuan = 'MENUNGGU' AND j.urutan_hierarki >= 1
         AND p.status_pengajuan = 'MENUNGGU_PERSETUJUAN'
         AND j.round_number = p.version_number`
    )
    .get().total;
}

function countDecisionsForEmployee(employeeId, status) {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS total FROM jalur_persetujuan j
       JOIN pengajuan_surat p ON p.id = j.pengajuan_id
       WHERE j.employee_id = ? AND j.status_persetujuan = ?
         AND j.round_number = p.version_number`
    )
    .get(employeeId, status).total;
}

/** Menandai sisa keputusan yang masih MENUNGGU pada ronde berjalan. */
function cancelPending(pengajuanId, roundNumber, note = 'Dibatalkan karena proses dihentikan') {
  return getDb()
    .prepare(
      `UPDATE jalur_persetujuan
          SET status_persetujuan = 'DIBATALKAN', catatan = ?, waktu_diproses = ?
        WHERE pengajuan_id = ? AND round_number = ? AND status_persetujuan = 'MENUNGGU'`
    )
    .run(note, new Date().toISOString(), pengajuanId, roundNumber).changes;
}

module.exports = {
  findById,
  createPending,
  createDecision,
  decide,
  findPendingStep,
  listBySubmission,
  listQueueForEmployee,
  listHistoryForEmployee,
  countQueueForEmployee,
  countDecisionsForEmployee,
  countAllPending,
  cancelPending,
};
