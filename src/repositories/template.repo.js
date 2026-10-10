'use strict';

const { getDb } = require('../config/database');

function parseTemplate(row) {
  if (!row) return null;
  return {
    ...row,
    is_active: !!row.is_active,
    form_schema: safeJsonParse(row.form_schema_json, []),
  };
}

function safeJsonParse(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function listAll({ onlyActive = false } = {}) {
  const sql = onlyActive
    ? 'SELECT * FROM template_surat WHERE is_active = 1 ORDER BY nama_surat'
    : 'SELECT * FROM template_surat ORDER BY is_active DESC, nama_surat';
  return getDb().prepare(sql).all().map(parseTemplate);
}

function findById(id, { onlyActive = false } = {}) {
  const sql = onlyActive
    ? 'SELECT * FROM template_surat WHERE id = ? AND is_active = 1'
    : 'SELECT * FROM template_surat WHERE id = ?';
  return parseTemplate(getDb().prepare(sql).get(id));
}

function findByKode(kode) {
  return parseTemplate(getDb().prepare('SELECT * FROM template_surat WHERE kode = ?').get(kode));
}

function create({ kode, namaSurat, deskripsi, persyaratan, formSchema, isActive = 1 }) {
  const info = getDb()
    .prepare(
      `INSERT INTO template_surat (kode, nama_surat, deskripsi, persyaratan, form_schema_json, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(kode, namaSurat, deskripsi ?? null, persyaratan ?? null, JSON.stringify(formSchema || []), isActive ? 1 : 0);
  return findById(info.lastInsertRowid);
}

function update(id, { namaSurat, deskripsi, persyaratan, formSchema, isActive }) {
  getDb()
    .prepare(
      `UPDATE template_surat SET
         nama_surat = COALESCE(?, nama_surat),
         deskripsi = COALESCE(?, deskripsi),
         persyaratan = COALESCE(?, persyaratan),
         form_schema_json = COALESCE(?, form_schema_json),
         is_active = COALESCE(?, is_active),
         updated_at = ?
       WHERE id = ?`
    )
    .run(
      namaSurat ?? null,
      deskripsi ?? null,
      persyaratan ?? null,
      formSchema ? JSON.stringify(formSchema) : null,
      isActive === undefined ? null : isActive ? 1 : 0,
      new Date().toISOString(),
      id
    );
  return findById(id);
}

// ---------------------------------------------------------------------------
// Rute approval template
// ---------------------------------------------------------------------------

function listRoutes(templateId) {
  return getDb()
    .prepare(
      `SELECT r.*, p.position_name, u.full_name AS assigned_employee_name
       FROM rute_approval_template r
       JOIN positions p ON p.id = r.position_id
       LEFT JOIN users u ON u.id = r.assigned_employee_id
       WHERE r.template_id = ?
       ORDER BY r.urutan_ke`
    )
    .all(templateId);
}

/**
 * Mengganti seluruh rute sebuah template secara atomik.
 * Dibatasi pada template; pengajuan lama tetap memakai snapshot rute masing-masing.
 */
function replaceRoutes(templateId, routes) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM rute_approval_template WHERE template_id = ?').run(templateId);
    const insert = db.prepare(
      `INSERT INTO rute_approval_template (template_id, urutan_ke, position_id, assigned_employee_id, is_required)
       VALUES (?, ?, ?, ?, ?)`
    );
    routes.forEach((r, index) => {
      insert.run(templateId, index + 1, r.position_id, r.assigned_employee_id ?? null, r.is_required === false ? 0 : 1);
    });
  });
  tx();
  return listRoutes(templateId);
}

function listPositions() {
  return getDb().prepare('SELECT * FROM positions ORDER BY id').all();
}

function findPositionById(id) {
  return getDb().prepare('SELECT * FROM positions WHERE id = ?').get(id);
}

module.exports = {
  listAll,
  findById,
  findByKode,
  create,
  update,
  listRoutes,
  replaceRoutes,
  listPositions,
  findPositionById,
  safeJsonParse,
};
