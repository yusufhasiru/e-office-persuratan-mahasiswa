'use strict';

/** Utilitas tanggal. Seluruh timestamp internal adalah ISO-8601 UTC. */

const BULAN_ID = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

/** Waktu sekarang sebagai string ISO-8601 UTC. */
function nowIso() {
  return new Date().toISOString();
}

/** Menambah hari kalender ke timestamp ISO (mengembalikan ISO). */
function addDaysIso(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/** Format tanggal Indonesia: 11 Oktober 2026. */
function formatTanggalId(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.getUTCDate()} ${BULAN_ID[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Format tanggal + jam Indonesia: 11 Oktober 2026, 08:30 WIB. */
function formatTanggalWaktuId(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  const wib = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const jam = String(wib.getUTCHours()).padStart(2, '0');
  const menit = String(wib.getUTCMinutes()).padStart(2, '0');
  return `${formatTanggalId(value)}, ${jam}:${menit} WIB`;
}

/** True bila nilai adalah tanggal YYYY-MM-DD yang valid (kalender nyata). */
function isValidDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** True bila iso lebih awal dari isoLain. */
function isBefore(iso, isoLain) {
  return new Date(iso).getTime() < new Date(isoLain).getTime();
}

module.exports = {
  nowIso,
  addDaysIso,
  formatTanggalId,
  formatTanggalWaktuId,
  isValidDateOnly,
  isBefore,
  BULAN_ID,
};
