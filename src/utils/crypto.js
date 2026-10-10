'use strict';

const crypto = require('node:crypto');

/** Referensi publik pengajuan yang mudah dibaca: SRT-2026-000123. */
function buildPublicReference(tahun, sequence) {
  return `SRT-${tahun}-${String(sequence).padStart(6, '0')}`;
}

/** Token verifikasi berentropi tinggi (32 byte acak -> 64 karakter hex). */
function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Token verifikasi disimpan dalam bentuk hash, bukan plaintext. */
function hashVerificationToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Checksum SHA-256 konten (buffer/string) untuk integritas dokumen. */
function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Token CSRF per sesi. */
function generateCsrfToken() {
  return crypto.randomBytes(24).toString('hex');
}

/** Perbandingan string konstan-waktu untuk token. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  buildPublicReference,
  generateVerificationToken,
  hashVerificationToken,
  sha256,
  generateCsrfToken,
  safeEqual,
};
