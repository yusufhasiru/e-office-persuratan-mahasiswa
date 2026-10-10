'use strict';

const pengajuanRepo = require('../repositories/pengajuan.repo');
const approvalRepo = require('../repositories/approval.repo');
const pengajuanService = require('./surat.service');
const { hashVerificationToken, sha256 } = require('../utils/crypto');
const { formatTanggalId, formatTanggalWaktuId } = require('../utils/date');
const { readPdf } = require('./pdf.service');

const INVALID_STATUSES = {
  DITOLAK: 'Dokumen ini terkait pengajuan yang DITOLAK, sehingga tidak sah.',
  DIBATALKAN: 'Dokumen ini terkait pengajuan yang DIBATALKAN, sehingga tidak sah.',
  KEDALUWARSA: 'Dokumen ini terkait pengajuan yang KEDALUWARSA, sehingga tidak sah.',
  PERLU_REVISI: 'Pengajuan masih dalam proses revisi sehingga dokumen final belum sah.',
  MENUNGGU_VERIFIKASI_STAF: 'Pengajuan masih dalam proses verifikasi.',
  MENUNGGU_PERSETUJUAN: 'Pengajuan masih menunggu persetujuan pejabat.',
  DRAFT: 'Pengajuan masih berstatus draft.',
};

/**
 * Verifikasi publik berdasarkan token pada QR Code.
 * Hanya menampilkan informasi yang aman dipublikasikan; memeriksa checksum
 * berkas PDF terhadap catatan di database untuk mendeteksi perubahan berkas.
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string' || token.length < 32 || !/^[a-f0-9]+$/i.test(token)) {
    return { valid: false, status: 'TIDAK_VALID', message: 'Token verifikasi tidak valid.' };
  }

  const pengajuan = pengajuanRepo.findByVerificationTokenHash(hashVerificationToken(token));
  if (!pengajuan) {
    return {
      valid: false,
      status: 'TIDAK_DITEMUKAN',
      message: 'Dokumen tidak terdaftar pada sistem e-Office. Token tidak dikenali.',
    };
  }

  if (pengajuan.status_pengajuan !== 'SELESAI') {
    return {
      valid: false,
      status: pengajuan.status_pengajuan,
      message: INVALID_STATUSES[pengajuan.status_pengajuan] || 'Dokumen belum sah.',
      surat_number: pengajuan.surat_number,
      jenis_surat: pengajuan.nama_surat,
      status_label: pengajuanService.humanStatus(pengajuan.status_pengajuan),
    };
  }

  // Integritas berkas: bandingkan checksum berkas PDF saat ini dengan catatan DB.
  let integrity = { status: 'TIDAK_DIPERIKSA', message: 'Berkas tidak tersedia untuk pemeriksaan.' };
  const fileBuffer = pengajuan.pdf_path ? readPdf(pengajuan.pdf_path) : null;
  if (fileBuffer) {
    const actual = sha256(fileBuffer);
    integrity =
      actual === pengajuan.pdf_checksum
        ? { status: 'COCOK', message: 'Checksum berkas cocok dengan catatan sistem.' }
        : { status: 'TIDAK_COCOK', message: 'PERINGATAN: berkas dokumen berubah dari catatan sistem.' };
  }

  const approvals = approvalRepo
    .listBySubmission(pengajuan.id, pengajuan.version_number)
    .filter((a) => a.status_persetujuan === 'DISETUJUI' && a.urutan_hierarki >= 1)
    .sort((a, b) => a.urutan_hierarki - b.urutan_hierarki)
    .map((a) => ({
      urutan_ke: a.urutan_hierarki,
      nama: a.employee_name,
      jabatan: a.employee_position,
      waktu: formatTanggalWaktuId(a.waktu_diproses),
    }));

  const verifier = approvalRepo
    .listBySubmission(pengajuan.id, pengajuan.version_number)
    .find((a) => a.urutan_hierarki === 0 && a.status_persetujuan === 'DILANJUTKAN');

  return {
    valid: true,
    status: 'SAH',
    message: 'Dokumen terdaftar dan sah diterbitkan oleh sistem e-Office.',
    surat_number: pengajuan.surat_number,
    jenis_surat: pengajuan.nama_surat,
    kode_template: pengajuan.template_kode,
    tanggal_penerbitan: formatTanggalId(pengajuan.issued_at),
    mahasiswa: {
      nama: pengajuan.student_name,
      nim: pengajuan.student_nim,
      program_studi: pengajuan.study_program,
    },
    diverifikasi_oleh: verifier ? { nama: verifier.employee_name, waktu: formatTanggalWaktuId(verifier.waktu_diproses) } : null,
    pejabat_menyetujui: approvals,
    identitas_dokumen_sha256: pengajuan.pdf_checksum,
    integritas_berkas: integrity,
    catatan:
      'Verifikasi ini dilakukan melalui server e-Office dan bukan pengganti sertifikat tanda tangan elektronik tersertifikasi.',
  };
}

module.exports = { verifyToken };
