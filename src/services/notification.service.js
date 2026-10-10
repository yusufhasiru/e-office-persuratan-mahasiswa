'use strict';

const notifRepo = require('../repositories/notification.repo');
const userRepo = require('../repositories/user.repo');

/**
 * Notifikasi internal aplikasi (in-app). Tidak ada pengiriman email pada versi
 * ini karena layanan email belum dikonfigurasi.
 */
function notify(userId, title, message, submissionId = null) {
  if (!userId) return null;
  return notifRepo.create(userId, title, message, submissionId);
}

function notifyMany(userIds, title, message, submissionId = null) {
  const unique = [...new Set(userIds.filter(Boolean))];
  return unique.map((id) => notify(id, title, message, submissionId));
}

/** Notifikasi untuk seluruh pejabat yang ditugaskan langsung pada sebuah tahap. */
function notifyAssignedOfficial(employeeId, title, message, submissionId) {
  return notify(employeeId, title, message, submissionId);
}

/** Notifikasi ke semua staf aktif (antrean verifikasi baru). */
function notifyAllStaff(title, message, submissionId) {
  const staff = userRepo.listByRole('STAF').filter((u) => u.is_active);
  return notifyMany(staff.map((s) => s.id), title, message, submissionId);
}

module.exports = { notify, notifyMany, notifyAllStaff, notifyAssignedOfficial };
