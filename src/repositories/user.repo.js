'use strict';

const { getDb } = require('../config/database');

const SAFE_COLUMNS = `u.id, u.nim, u.employee_id, u.full_name, u.email, u.role,
  u.study_program, u.position_id, u.is_active, u.created_at, u.updated_at,
  p.position_name`;

const BASE_SELECT = `SELECT ${SAFE_COLUMNS}
  FROM users u LEFT JOIN positions p ON p.id = u.position_id`;

/** Mencari user berdasarkan email (case-insensitive) — termasuk password_hash. */
function findByEmailWithHash(email) {
  return getDb()
    .prepare(`SELECT u.*, p.position_name FROM users u
              LEFT JOIN positions p ON p.id = u.position_id
              WHERE lower(u.email) = lower(?)`)
    .get(String(email || '').trim());
}

function findByNim(nim) {
  return getDb().prepare(`${BASE_SELECT} WHERE u.nim = ?`).get(String(nim || '').trim());
}

function findById(id) {
  return getDb().prepare(`${BASE_SELECT} WHERE u.id = ?`).get(id);
}

function findByEmployeeId(employeeId) {
  return getDb().prepare(`${BASE_SELECT} WHERE u.employee_id = ?`).get(employeeId);
}

function listByRole(role) {
  return getDb().prepare(`${BASE_SELECT} WHERE u.role = ? ORDER BY u.full_name`).all(role);
}

function listOfficialsByPosition(positionId) {
  return getDb()
    .prepare(`${BASE_SELECT} WHERE u.position_id = ? AND u.role = 'PEJABAT' AND u.is_active = 1 ORDER BY u.full_name`)
    .all(positionId);
}

function create({ nim = null, employeeId = null, fullName, email, passwordHash, role, studyProgram = null, positionId = null, isActive = 1 }) {
  const info = getDb()
    .prepare(
      `INSERT INTO users (nim, employee_id, full_name, email, password_hash, role, study_program, position_id, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(nim, employeeId, fullName, email, passwordHash, role, studyProgram, positionId, isActive ? 1 : 0);
  return findById(info.lastInsertRowid);
}

function updateProfile(id, { fullName, studyProgram, email }) {
  getDb()
    .prepare(
      `UPDATE users SET full_name = COALESCE(?, full_name),
                        study_program = COALESCE(?, study_program),
                        email = COALESCE(?, email),
                        updated_at = ?
       WHERE id = ?`
    )
    .run(fullName ?? null, studyProgram ?? null, email ?? null, new Date().toISOString(), id);
  return findById(id);
}

function setActive(id, isActive) {
  getDb()
    .prepare('UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?')
    .run(isActive ? 1 : 0, new Date().toISOString(), id);
  return findById(id);
}

module.exports = {
  findByEmailWithHash,
  findByNim,
  findById,
  findByEmployeeId,
  listByRole,
  listOfficialsByPosition,
  create,
  updateProfile,
  setActive,
};
