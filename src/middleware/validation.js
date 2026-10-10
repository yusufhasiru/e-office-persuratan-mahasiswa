'use strict';

const { badRequest } = require('../utils/http');

/** Memastikan body adalah objek JSON sederhana. */
function requireJsonObject(req, res, next) {
  const body = req.body;
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    return next(badRequest('Body request harus berupa objek JSON.'));
  }
  return next();
}

/**
 * Validasi skalar dengan whitelist panjang & tipe.
 * `rules` contoh: { email: { required: true, type: 'email' }, catatan: { maxLength: 1000 } }
 */
function validateBody(rules) {
  return (req, res, next) => {
    const body = req.body || {};
    const clean = {};
    const errors = {};

    for (const [key, rule] of Object.entries(rules)) {
      let value = body[key];
      if (value === undefined || value === null) value = '';
      if (typeof value === 'object') {
        errors[key] = `${key} tidak valid.`;
        continue;
      }
      value = String(value).trim();

      if (!value && rule.required) {
        errors[key] = rule.message || `${key} wajib diisi.`;
        continue;
      }
      if (value && rule.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
        errors[key] = 'Format email tidak valid.';
        continue;
      }
      if (value && rule.type === 'integer' && !/^\d+$/.test(value)) {
        errors[key] = `${key} harus berupa angka bulat.`;
        continue;
      }
      if (value && rule.maxLength && value.length > rule.maxLength) {
        errors[key] = `${key} maksimal ${rule.maxLength} karakter.`;
        continue;
      }
      if (value && rule.minLength && value.length < rule.minLength) {
        errors[key] = rule.message || `${key} minimal ${rule.minLength} karakter.`;
        continue;
      }
      clean[key] = value;
    }

    if (Object.keys(errors).length > 0) {
      const err = badRequest('Data yang dikirim tidak valid.', 'VALIDATION_ERROR');
      err.details = errors;
      return next(err);
    }
    req.cleanBody = clean;
    return next();
  };
}

module.exports = { requireJsonObject, validateBody };
