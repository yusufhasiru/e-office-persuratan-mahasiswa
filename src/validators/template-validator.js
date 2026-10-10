'use strict';

const { badRequest } = require('../utils/http');
const { SUPPORTED_TYPES } = require('./form-validator');

const NAME_RE = /^[a-z][a-z0-9_]{1,39}$/;

function validationError(details) {
  const err = badRequest('Data yang dikirim tidak valid.', 'VALIDATION_ERROR');
  err.details = details;
  return err;
}

/**
 * Membersihkan skema form dinamis. Hanya tipe yang didukung yang diterima dan
 * atribut eksekusi (mis. onerror/HTML) tidak pernah lolos karena setiap field
 * direduksi menjadi whitelist kunci.
 */
function sanitizeFormSchema(schema) {
  if (!Array.isArray(schema)) throw validationError({ form_schema: 'Skema form harus berupa array.' });
  const seen = new Set();
  const clean = schema.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw validationError({ form_schema: `Field ke-${index + 1} tidak valid.` });
    }
    const name = String(raw.name || '').trim().toLowerCase();
    if (!NAME_RE.test(name)) {
      throw validationError({ form_schema: `Nama field "${raw.name}" tidak valid (huruf kecil, angka, underscore).` });
    }
    if (seen.has(name)) throw validationError({ form_schema: `Nama field "${name}" duplikat.` });
    seen.add(name);

    const type = String(raw.type || 'text').trim().toLowerCase();
    if (!SUPPORTED_TYPES.includes(type)) {
      throw validationError({ form_schema: `Tipe field "${type}" tidak didukung.` });
    }

    const field = {
      name,
      label: String(raw.label || name).slice(0, 120),
      type,
      placeholder: raw.placeholder ? String(raw.placeholder).slice(0, 160) : '',
      required: raw.required === true || raw.required === 'true',
      order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index + 1,
    };
    if (Number.isFinite(Number(raw.minLength))) field.minLength = Number(raw.minLength);
    if (Number.isFinite(Number(raw.maxLength))) field.maxLength = Number(raw.maxLength);
    if (Number.isFinite(Number(raw.min))) field.min = Number(raw.min);
    if (Number.isFinite(Number(raw.max))) field.max = Number(raw.max);
    if (raw.pattern) {
      try {
        new RegExp(String(raw.pattern));
        field.pattern = String(raw.pattern).slice(0, 200);
        if (raw.patternMessage) field.patternMessage = String(raw.patternMessage).slice(0, 160);
      } catch {
        throw validationError({ form_schema: `Pattern pada field "${name}" bukan regex yang valid.` });
      }
    }
    if (type === 'select') {
      if (!Array.isArray(raw.options) || raw.options.length === 0) {
        throw validationError({ form_schema: `Field select "${name}" wajib memiliki opsi.` });
      }
      field.options = raw.options.slice(0, 50).map((opt) => {
        if (opt && typeof opt === 'object') {
          return { value: String(opt.value ?? opt.label ?? '').slice(0, 120), label: String(opt.label ?? opt.value ?? '').slice(0, 120) };
        }
        return { value: String(opt).slice(0, 120), label: String(opt).slice(0, 120) };
      });
    }
    return field;
  });

  return clean.sort((a, b) => a.order - b.order).map((f, i) => ({ ...f, order: i + 1 }));
}

/** Membersihkan definisi rute approval yang dikirim staf. */
function sanitizeRoutes(routes) {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw validationError({ routes: 'Rute persetujuan minimal memiliki satu tahap.' });
  }
  if (routes.length > 10) throw validationError({ routes: 'Maksimal 10 tahap persetujuan.' });

  const seenPositions = new Set();
  return routes.map((r, index) => {
    const positionId = Number(r?.position_id);
    if (!Number.isInteger(positionId) || positionId <= 0) {
      throw validationError({ routes: `Tahap ${index + 1}: position_id tidak valid.` });
    }
    if (seenPositions.has(positionId)) {
      throw validationError({ routes: `Tahap ${index + 1}: jabatan duplikat dalam satu rute.` });
    }
    seenPositions.add(positionId);

    let assigned = null;
    if (r.assigned_employee_id !== undefined && r.assigned_employee_id !== null && r.assigned_employee_id !== '') {
      assigned = Number(r.assigned_employee_id);
      if (!Number.isInteger(assigned) || assigned <= 0) {
        throw validationError({ routes: `Tahap ${index + 1}: assigned_employee_id tidak valid.` });
      }
    }
    return { position_id: positionId, assigned_employee_id: assigned, is_required: r.is_required === false || r.is_required === 0 ? 0 : 1 };
  });
}

/** Validasi rute dengan memastikan jabatan & pejabat benar-benar ada. */
function validateRoutesAgainstDb(routes, { userRepo, templateRepo }) {
  routes.forEach((r, index) => {
    const position = templateRepo.findPositionById(r.position_id);
    if (!position) throw validationError({ routes: `Tahap ${index + 1}: jabatan tidak ditemukan.` });
    if (r.assigned_employee_id) {
      const employee = userRepo.findById(r.assigned_employee_id);
      if (!employee || employee.role !== 'PEJABAT' || !employee.is_active) {
        throw validationError({ routes: `Tahap ${index + 1}: pejabat yang ditugaskan tidak valid atau tidak aktif.` });
      }
      if (employee.position_id !== r.position_id) {
        throw validationError({ routes: `Tahap ${index + 1}: pejabat tidak memegang jabatan ${position.position_name}.` });
      }
    }
  });
}

module.exports = { sanitizeFormSchema, sanitizeRoutes, validateRoutesAgainstDb };
