'use strict';

/**
 * Validasi form dinamis berdasarkan skema template (form_schema_json).
 *
 * Aturan penting:
 *  - Hanya field yang dideklarasikan skema yang diterima (whitelist).
 *  - Nilai selalu dinormalkan menjadi string/angka aman; HTML/JS dari klien
 *    tidak pernah dieksekusi maupun disimpan sebagai markup.
 *  - Tipe input yang didukung: text, textarea, date, email, tel, number, select.
 */

const SUPPORTED_TYPES = ['text', 'textarea', 'email', 'tel', 'number', 'date', 'select'];
const MAX_TEXTAREA = 2000;
const MAX_TEXT = 255;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TEL_RE = /^[0-9+()\-\s]{6,25}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Membersihkan karakter kontrol yang tidak perlu (NUL, escape) & trim. */
function sanitize(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim();
}

function isValidDateOnly(value) {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function validateField(field, rawValue) {
  const label = field.label || field.name;
  const required = field.required === true || field.required === 'true';
  const value = rawValue === undefined || rawValue === null ? '' : sanitize(rawValue);

  if (value === '') {
    return required ? { error: `${label} wajib diisi.` } : { value: '' };
  }

  const maxLength = Number.isFinite(field.maxLength) ? field.maxLength : field.type === 'textarea' ? MAX_TEXTAREA : MAX_TEXT;
  if (value.length > maxLength) return { error: `${label} maksimal ${maxLength} karakter.` };

  const minLength = Number.isFinite(field.minLength) ? field.minLength : 0;
  if (value.length < minLength) return { error: `${label} minimal ${minLength} karakter.` };

  switch (field.type) {
    case 'email':
      if (!EMAIL_RE.test(value)) return { error: `${label} harus berupa email yang valid.` };
      return { value: value.toLowerCase() };
    case 'tel':
      if (!TEL_RE.test(value)) return { error: `${label} harus berupa nomor telepon yang valid.` };
      return { value };
    case 'date':
      if (!isValidDateOnly(value)) return { error: `${label} harus berupa tanggal yang valid (YYYY-MM-DD).` };
      return { value };
    case 'number': {
      const num = Number(value);
      if (!Number.isFinite(num)) return { error: `${label} harus berupa angka.` };
      const min = field.min !== undefined ? Number(field.min) : null;
      const max = field.max !== undefined ? Number(field.max) : null;
      if (min !== null && num < min) return { error: `${label} minimal ${min}.` };
      if (max !== null && num > max) return { error: `${label} maksimal ${max}.` };
      return { value: num };
    }
    case 'select': {
      const options = Array.isArray(field.options) ? field.options.map((o) => String(typeof o === 'object' ? o.value : o)) : [];
      if (!options.includes(value)) return { error: `${label} berisi pilihan yang tidak valid.` };
      return { value };
    }
    case 'text':
    case 'textarea':
    default:
      if (field.pattern) {
        let re;
        try {
          re = new RegExp(field.pattern);
        } catch {
          re = null;
        }
        if (re && !re.test(value)) return { error: field.patternMessage || `${label} formatnya tidak sesuai.` };
      }
      return { value };
  }
}

/**
 * Memvalidasi payload terhadap skema.
 * @returns {{ valid: boolean, errors: Record<string,string>, data: Record<string, any> }}
 */
function validatePayload(schema, payload) {
  const errors = {};
  const data = {};
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const fields = (Array.isArray(schema) ? schema : []).filter((f) => f && typeof f === 'object' && typeof f.name === 'string');

  for (const field of fields) {
    const { error, value } = validateField(field, input[field.name]);
    if (error) errors[field.name] = error;
    else data[field.name] = value;
  }

  // Aturan silang: tanggal selesai tidak boleh sebelum tanggal mulai.
  const startKey = fields.find((f) => f.type === 'date' && /mulai|start|awal/i.test(f.name))?.name;
  const endKey = fields.find((f) => f.type === 'date' && /selesai|end|akhir/i.test(f.name))?.name;
  if (startKey && endKey && data[startKey] && data[endKey] && data[endKey] < data[startKey]) {
    errors[endKey] = 'Tanggal selesai tidak boleh lebih awal daripada tanggal mulai.';
  }

  return { valid: Object.keys(errors).length === 0, errors, data };
}

/** Ringkasan manusiawi dari payload untuk tampilan/PDF. */
function summarizePayload(schema, payload) {
  const fields = Array.isArray(schema) ? schema : [];
  return fields
    .map((f) => ({ label: f.label || f.name, name: f.name, value: payload?.[f.name] ?? '' }))
    .filter((row) => row.value !== '' && row.value !== null && row.value !== undefined);
}

module.exports = { validatePayload, summarizePayload, SUPPORTED_TYPES };
