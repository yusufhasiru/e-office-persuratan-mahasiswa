'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootstrap, loginAs, templateIdByKode, sipPayload, getDb, closeDb } = require('./helpers');

let mahasiswa;
let staf;
let dosen;
let ketua;
let wakil;

before(async () => {
  await bootstrap();
  mahasiswa = await loginAs('mahasiswa');
  staf = await loginAs('staf');
  dosen = await loginAs('dosen');
  ketua = await loginAs('ketua');
  wakil = await loginAs('wakil');
});

after(() => closeDb());

async function newSubmission() {
  const res = await mahasiswa.post('/api/mahasiswa/pengajuan', {
    template_id: templateIdByKode('SIP'),
    payload: sipPayload(),
  });
  assert.equal(res.status, 201);
  return res.body.pengajuan.id;
}

test('11. staf melihat antrean verifikasi sesuai kewenangannya', async () => {
  const id = await newSubmission();
  const antrean = await staf.get('/api/staf/antrean');
  assert.equal(antrean.status, 200);
  const ids = antrean.body.pengajuan.map((p) => p.id);
  assert.ok(ids.includes(id), 'pengajuan baru muncul di antrean verifikasi staf');

  const dashboard = await staf.get('/api/staf/dashboard');
  assert.ok(dashboard.body.ringkasan.antrean_verifikasi >= 1, 'angka dashboard dihitung dari database');
});

test('12. staf meminta revisi wajib menyertakan alasan', async () => {
  const id = await newSubmission();

  const tanpaAlasan = await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'REVISI', catatan: '' });
  assert.equal(tanpaAlasan.status, 400);
  assert.equal(tanpaAlasan.body.code, 'REASON_REQUIRED');

  const denganAlasan = await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, {
    decision: 'REVISI',
    catatan: 'Alamat instansi belum lengkap, mohon diperbaiki.',
  });
  assert.equal(denganAlasan.status, 200);

  const row = getDb().prepare('SELECT * FROM pengajuan_surat WHERE id = ?').get(id);
  assert.equal(row.status_pengajuan, 'PERLU_REVISI');
  assert.ok(row.deadline_revisi, 'batas waktu revisi dihitung otomatis');

  const revision = getDb().prepare('SELECT * FROM submission_revisions WHERE pengajuan_id = ?').get(id);
  assert.equal(revision.revision_reason, 'Alamat instansi belum lengkap, mohon diperbaiki.');
  assert.equal(revision.version_number, 1);
  assert.ok(revision.payload_snapshot_json.includes('judul_penelitian'), 'snapshot data versi lama disimpan');
});

test('13. staf meneruskan surat yang lolos verifikasi ke tahap pertama', async () => {
  const id = await newSubmission();
  const res = await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT', catatan: 'Berkas lengkap' });

  assert.equal(res.status, 200);
  assert.equal(res.body.pengajuan.status_pengajuan, 'MENUNGGU_PERSETUJUAN');
  assert.equal(res.body.pengajuan.current_step, 1);

  const queue = await dosen.get('/api/pejabat/antrean');
  assert.ok(queue.body.pengajuan.map((p) => p.id).includes(id), 'surat masuk antrean pejabat tahap 1');
});

test('14. pejabat tahap kedua tidak dapat menyetujui sebelum tahap pertama selesai', async () => {
  const id = await newSubmission();
  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT' });

  const ketuaQueue = await ketua.get('/api/pejabat/antrean');
  assert.ok(!ketuaQueue.body.pengajuan.map((p) => p.id).includes(id), 'surat belum terlihat oleh tahap 2');

  const res = await ketua.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU', catatan: 'Coba lompat tahap' });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'NOT_ASSIGNED');
});

test('15. pejabat yang tidak ditugaskan tidak dapat menyetujui surat', async () => {
  const id = await newSubmission();
  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT' });

  const res = await wakil.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU', catatan: 'Mencoba ikut menyetujui' });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'NOT_ASSIGNED');

  const detail = await wakil.get(`/api/surat/${id}`);
  assert.equal(detail.status, 403, 'pejabat lain tidak boleh membuka detail');

  const queue = await wakil.get('/api/pejabat/antrean');
  assert.equal(queue.body.pengajuan.length, 0, 'antrean pejabat lain kosong');
});

test('16. pejabat tahap pertama menyetujui dan tahap kedua menjadi aktif', async () => {
  const id = await newSubmission();
  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT' });

  const res = await dosen.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU', catatan: 'Disetujui pembimbing' });
  assert.equal(res.status, 200);
  assert.equal(res.body.pengajuan.current_step, 2);
  assert.equal(res.body.pengajuan.status_pengajuan, 'MENUNGGU_PERSETUJUAN');
  assert.equal(res.body.pengajuan.pdf_status, null, 'finalisasi belum dimulai karena masih ada tahap berikutnya');
  assert.equal(res.body.pengajuan.surat_number, null, 'nomor surat baru dibuat saat finalisasi');

  const ketuaQueue = await ketua.get('/api/pejabat/antrean');
  assert.ok(ketuaQueue.body.pengajuan.map((p) => p.id).includes(id), 'surat kini di antrean tahap 2');

  const row = getDb().prepare("SELECT * FROM jalur_persetujuan WHERE pengajuan_id = ? AND urutan_hierarki = 1").get(id);
  assert.equal(row.status_persetujuan, 'DISETUJUI');
  assert.ok(row.waktu_diproses, 'waktu keputusan tercatat');
});

test('17. pejabat terakhir menyetujui dan sistem membuat PDF final', async () => {
  const id = await newSubmission();
  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT' });
  await dosen.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU' });
  const res = await ketua.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU', catatan: 'Disetujui ketua jurusan' });

  assert.equal(res.status, 200);
  assert.equal(res.body.pengajuan.status_pengajuan, 'SELESAI');
  assert.equal(res.body.pengajuan.pdf_status, 'READY');
  assert.match(res.body.pengajuan.surat_number, /^\d{3}\/E-Office\/SIP\/\d{4}$/);

  const row = getDb().prepare('SELECT * FROM pengajuan_surat WHERE id = ?').get(id);
  assert.ok(row.pdf_path, 'path PDF tersimpan');
  assert.ok(row.pdf_checksum, 'checksum PDF tersimpan');
  assert.ok(row.verification_token_hash, 'token verifikasi disimpan dalam bentuk hash');
  assert.equal(row.verification_token_hash.length, 64);
  assert.ok(row.completed_at);
});

test('17b. template dengan rute satu tahap (SKAK) juga selesai sampai PDF final', async () => {
  const created = await mahasiswa.post('/api/mahasiswa/pengajuan', {
    template_id: templateIdByKode('SKAK'),
    payload: { semester: '9', tahun_akademik: '2026/2027', keperluan: 'Beasiswa', keterangan: 'Untuk beasiswa prestasi akademik.' },
  });
  assert.equal(created.status, 201);
  const id = created.body.pengajuan.id;

  // Rute SKAK hanya satu tahap: Ketua Jurusan.
  const snapshot = getDb().prepare('SELECT position_name FROM approval_routes_snapshot WHERE pengajuan_id = ? ORDER BY urutan_ke').all(id);
  assert.deepEqual(snapshot.map((s) => s.position_name), ['Ketua Jurusan']);

  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT' });

  const dosenTries = await dosen.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU' });
  assert.equal(dosenTries.status, 403, 'dosen pembimbing tidak berwenang pada rute SKAK');

  const res = await ketua.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU', catatan: 'Disetujui ketua jurusan.' });
  assert.equal(res.status, 200);
  assert.equal(res.body.pengajuan.status_pengajuan, 'SELESAI');
  assert.match(res.body.pengajuan.surat_number, /\/E-Office\/SKAK\//);

  const download = await mahasiswa.get(`/api/surat/${id}/pdf`);
  assert.equal(download.status, 200);
  assert.equal(download.body.subarray(0, 5).toString(), '%PDF-');
});

test('18. request persetujuan ganda tidak menghasilkan keputusan ganda', async () => {
  const id = await newSubmission();
  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT' });

  const [first, second] = await Promise.all([
    dosen.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU', catatan: 'Keputusan pertama' }),
    dosen.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU', catatan: 'Keputusan kedua' }),
  ]);

  const statuses = [first.status, second.status].sort();
  assert.equal(statuses[0], 200, 'satu keputusan berhasil diproses');
  assert.ok([403, 409].includes(statuses[1]), `permintaan ganda ditolak, diterima status ${statuses[1]}`);

  const decisions = getDb()
    .prepare('SELECT * FROM jalur_persetujuan WHERE pengajuan_id = ? AND urutan_hierarki = 1 AND status_persetujuan = ?')
    .all(id, 'DISETUJUI');
  assert.equal(decisions.length, 1, 'tidak ada keputusan ganda tersimpan');

  const row = getDb().prepare('SELECT current_step, version_number FROM pengajuan_surat WHERE id = ?').get(id);
  assert.equal(row.current_step, 2, 'tahap berikutnya hanya aktif satu kali');

  const activeStageRows = getDb()
    .prepare("SELECT COUNT(*) AS total FROM jalur_persetujuan WHERE pengajuan_id = ? AND round_number = ? AND urutan_hierarki = 2 AND status_persetujuan = 'MENUNGGU'")
    .get(id, row.version_number);
  assert.equal(activeStageRows.total, 1, 'tidak ada tahap aktif ganda');
});

test('18b. verifikasi staf ganda juga ditolak', async () => {
  const id = await newSubmission();
  const [a, b] = await Promise.all([
    staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT' }),
    staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
});

test('19. penolakan permanen wajib menyertakan alasan dan tidak dapat dilanjutkan', async () => {
  const id = await newSubmission();
  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT' });

  const tanpaAlasan = await dosen.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'TOLAK', catatan: 'x' });
  assert.equal(tanpaAlasan.status, 400);
  assert.equal(tanpaAlasan.body.code, 'REASON_REQUIRED');

  const res = await dosen.post(`/api/pejabat/pengajuan/${id}/keputusan`, {
    decision: 'TOLAK',
    catatan: 'Topik penelitian tidak sesuai dengan bidang jurusan.',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.pengajuan.status_pengajuan, 'DITOLAK');

  const row = getDb().prepare('SELECT * FROM pengajuan_surat WHERE id = ?').get(id);
  assert.equal(row.pdf_path, null, 'tidak ada PDF untuk pengajuan yang ditolak');

  const ketuaQueue = await ketua.get('/api/pejabat/antrean');
  assert.ok(!ketuaQueue.body.pengajuan.map((p) => p.id).includes(id), 'alur berhenti, tahap berikutnya tidak diaktifkan');

  const pending = getDb().prepare("SELECT COUNT(*) AS total FROM jalur_persetujuan WHERE pengajuan_id = ? AND status_persetujuan = 'MENUNGGU'").get(id);
  assert.equal(pending.total, 0, 'tidak ada tahap menggantung setelah penolakan');

  const rejection = getDb().prepare("SELECT * FROM jalur_persetujuan WHERE pengajuan_id = ? AND status_persetujuan = 'DITOLAK'").get(id);
  assert.equal(rejection.catatan, 'Topik penelitian tidak sesuai dengan bidang jurusan.');
  assert.ok(rejection.waktu_diproses, 'keputusan penolakan tersimpan sebagai audit');

  const resubmit = await mahasiswa.put(`/api/mahasiswa/pengajuan/${id}/resubmit`, { payload: sipPayload() });
  assert.equal(resubmit.status, 409, 'pengajuan ditolak tidak dapat dikirim ulang secara normal');
});

test('19b. mahasiswa dapat melihat alasan penolakan pada detail pengajuannya', async () => {
  const id = await newSubmission();
  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT' });
  await dosen.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'TOLAK', catatan: 'Data instansi tidak valid untuk penelitian.' });

  const detail = await mahasiswa.get(`/api/surat/${id}`);
  const rejection = detail.body.approvals.find((a) => a.status_persetujuan === 'DITOLAK');
  assert.ok(rejection);
  assert.equal(rejection.catatan, 'Data instansi tidak valid untuk penelitian.');
});

test('20. kegagalan membuat PDF tidak membuat surat berstatus selesai dan dapat di-retry', async () => {
  const id = await newSubmission();
  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT' });
  await dosen.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU' });

  // Simulasi kegagalan penyimpanan berkas (mis. penyimpanan penuh / izin ditolak).
  const pdfService = require('../src/services/pdf.service');
  const original = pdfService.storePdf;
  pdfService.storePdf = () => {
    throw new Error('simulasi penyimpanan berkas gagal');
  };

  let res;
  try {
    res = await ketua.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU' });
  } finally {
    pdfService.storePdf = original;
  }

  assert.equal(res.status, 200);
  assert.equal(res.body.pengajuan.status_pengajuan, 'MENUNGGU_PERSETUJUAN', 'status TIDAK menjadi SELESAI saat PDF gagal');
  assert.equal(res.body.pengajuan.pdf_status, 'FAILED');
  assert.equal(res.body.finalisasi.berhasil, false);

  const row = getDb().prepare('SELECT * FROM pengajuan_surat WHERE id = ?').get(id);
  assert.equal(row.pdf_path, null);
  assert.ok(row.pdf_last_error);

  const download = await mahasiswa.get(`/api/surat/${id}/pdf`);
  assert.equal(download.status, 409, 'dokumen belum dapat diunduh');

  const approvals = getDb()
    .prepare("SELECT COUNT(*) AS total FROM jalur_persetujuan WHERE pengajuan_id = ? AND status_persetujuan = 'DISETUJUI'")
    .get(id);
  assert.equal(approvals.total, 2, 'persetujuan tetap tersimpan dan tidak perlu diulang');

  // Retry oleh staf tanpa mengulang persetujuan.
  const retry = await staf.post(`/api/staf/pengajuan/${id}/retry-pdf`);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.pengajuan.status_pengajuan, 'SELESAI');

  const countAfter = getDb()
    .prepare("SELECT COUNT(*) AS total FROM jalur_persetujuan WHERE pengajuan_id = ? AND status_persetujuan = 'DISETUJUI'")
    .get(id);
  assert.equal(countAfter.total, 2, 'retry tidak menambah atau mengulang keputusan');
});

test('20b. endorsement wajib lengkap sebelum finalisasi dapat dijalankan', async () => {
  const id = await newSubmission();
  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT' });

  const retry = await staf.post(`/api/staf/pengajuan/${id}/retry-pdf`);
  assert.equal(retry.status, 409, 'belum semua tahap disetujui');

  const row = getDb().prepare('SELECT status_pengajuan FROM pengajuan_surat WHERE id = ?').get(id);
  assert.equal(row.status_pengajuan, 'MENUNGGU_PERSETUJUAN');
});
