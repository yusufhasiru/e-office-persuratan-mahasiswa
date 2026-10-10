'use strict';

const pengajuanRepo = require('../repositories/pengajuan.repo');
const { notFound } = require('../utils/http');

/**
 * Memuat pengajuan dari :id / :reference dan menyimpannya di req.pengajuan.
 * Mengembalikan 404 (bukan 403) bila mahasiswa mencoba mengakses milik orang
 * lain agar keberadaan dokumen tidak bocor.
 */
function loadPengajuan({ param = 'id', studentOnly = false } = {}) {
  return (req, res, next) => {
    const raw = req.params[param];
    let pengajuan = null;
    if (/^\d+$/.test(String(raw))) pengajuan = pengajuanRepo.findById(Number(raw));
    if (!pengajuan) pengajuan = pengajuanRepo.findByPublicReference(String(raw));
    if (!pengajuan) return next(notFound('Pengajuan tidak ditemukan.'));

    if (studentOnly && req.user.role === 'MAHASISWA' && pengajuan.student_id !== req.user.id) {
      return next(notFound('Pengajuan tidak ditemukan.'));
    }
    req.pengajuan = pengajuan;
    return next();
  };
}

module.exports = { loadPengajuan };
