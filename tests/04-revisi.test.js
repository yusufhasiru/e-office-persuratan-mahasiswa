'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootstrap, loginAs, templateIdByKode, sipPayload, getDb, closeDb } = require('./helpers');

let mahasiswa;
let staf;
let dosen;
let ketua;

before(async () => {
  await bootstrap();
  mahasiswa = await loginAs('mahasiswa');
  staf = await loginAs('staf');
  dosen = await loginAs('dosen');
  ketua = await loginAs('ketua');
});

after(() => closeDb());

async function newSubmission() {
  const res = await mahasiswa.post('/api/mahasiswa/pengajuan', { template_id: templateIdByKode('SIP'), payload: sipPayload() });
  return res.body.pengajuan.id;
}

test('21. mahasiswa dapat memperbaiki dan mengirim ulang pengajuan yang meminta revisi', async () => {
  const id = await newSubmission();
  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'REVISI', catatan: 'Alamat instansi kurang lengkap, tolong perbaiki.' });

  const resubmit = await mahasiswa.put(`/api/mahasiswa/pengajuan/${id}/resubmit`, {
    payload: sipPayload({ alamat_instansi: 'Jl. Industri Raya No. 45, Kelurahan Sukamaju, Kota Contoh 40111' }),
  });

  assert.equal(resubmit.status, 200);
  assert.equal(resubmit.body.pengajuan.version_number, 2);
  assert.equal(resubmit.body.pengajuan.status_pengajuan, 'MENUNGGU_VERIFIKASI_STAF');

  const row = getDb().prepare('SELECT * FROM pengajuan_surat WHERE id = ?').get(id);
  assert.match(row.payload_isian_json, /Kelurahan Sukamaju/, 'data baru tersimpan');
  assert.equal(row.deadline_revisi, null, 'batas waktu revisi dibersihkan setelah dikirim ulang');
});

test('21b. validasi tetap dijalankan ulang saat pengiriman ulang', async () => {
  const id = await newSubmission();
  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'REVISI', catatan: 'Perbaiki judul penelitian.' });

  const res = await mahasiswa.put(`/api/mahasiswa/pengajuan/${id}/resubmit`, { payload: sipPayload({ judul_penelitian: '' }) });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.judul_penelitian);
});

test('22. mahasiswa tidak dapat mengedit pengajuan yang sedang diproses', async () => {
  const id = await newSubmission();
  const res = await mahasiswa.put(`/api/mahasiswa/pengajuan/${id}/resubmit`, { payload: sipPayload({ judul_penelitian: 'Diubah saat masih diproses' }) });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'NOT_IN_REVISION');

  const row = getDb().prepare('SELECT payload_isian_json, version_number FROM pengajuan_surat WHERE id = ?').get(id);
  assert.equal(row.version_number, 1, 'versi tidak bertambah');
  assert.ok(!row.payload_isian_json.includes('Diubah saat masih diproses'));
});

test('22b. mahasiswa hanya dapat memperbaiki pengajuan miliknya sendiri', async () => {
  const id = await newSubmission();
  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'REVISI', catatan: 'Perlu perbaikan data.' });

  const other = await loginAs('mahasiswa2');
  const res = await other.put(`/api/mahasiswa/pengajuan/${id}/resubmit`, { payload: sipPayload() });
  assert.equal(res.status, 403);
});

test('23. pengiriman ulang mengembalikan surat ke verifikasi staf', async () => {
  const id = await newSubmission();
  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'REVISI', catatan: 'Data penelitian perlu dilengkapi.' });
  await mahasiswa.put(`/api/mahasiswa/pengajuan/${id}/resubmit`, { payload: sipPayload() });

  const antrean = await staf.get('/api/staf/antrean');
  assert.ok(antrean.body.pengajuan.map((p) => p.id).includes(id), 'surat kembali ke antrean verifikasi staf');

  const pendingRow = getDb()
    .prepare("SELECT * FROM jalur_persetujuan WHERE pengajuan_id = ? AND round_number = 2 AND urutan_hierarki = 0 AND status_persetujuan = 'MENUNGGU'")
    .get(id);
  assert.ok(pendingRow, 'verifikasi ronde baru dibuka');

  const oldRow = getDb().prepare('SELECT * FROM jalur_persetujuan WHERE pengajuan_id = ? AND round_number = 1 AND urutan_hierarki = 0').get(id);
  assert.equal(oldRow.status_persetujuan, 'REVISI', 'keputusan ronde lama tetap tersimpan');
});

test('24. riwayat versi dan alasan revisi tetap tersimpan', async () => {
  const id = await newSubmission();
  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'REVISI', catatan: 'Revisi pertama: alamat instansi salah.' });
  await mahasiswa.put(`/api/mahasiswa/pengajuan/${id}/resubmit`, { payload: sipPayload({ nama_instansi: 'PT Teknologi Nusantara Cabang Kota Contoh' }) });

  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'REVISI', catatan: 'Revisi kedua: judul penelitian perlu diperjelas.' });
  await mahasiswa.put(`/api/mahasiswa/pengajuan/${id}/resubmit`, { payload: sipPayload({ judul_penelitian: 'Sistem Informasi Persuratan Berbasis Web (Studi Kasus Jurusan TI)' }) });

  const revisions = getDb().prepare('SELECT * FROM submission_revisions WHERE pengajuan_id = ? ORDER BY version_number').all(id);
  assert.equal(revisions.length, 2, 'kedua permintaan revisi tercatat');
  assert.equal(revisions[0].revision_reason, 'Revisi pertama: alamat instansi salah.');
  assert.equal(revisions[1].revision_reason, 'Revisi kedua: judul penelitian perlu diperjelas.');
  assert.ok(revisions[0].resubmitted_at);
  assert.ok(revisions[1].resubmitted_at);
  assert.ok(revisions[0].payload_snapshot_json.includes('Mengumpulkan data'), 'snapshot data versi lama disimpan');

  const row = getDb().prepare('SELECT version_number FROM pengajuan_surat WHERE id = ?').get(id);
  assert.equal(row.version_number, 3);

  const detail = await mahasiswa.get(`/api/surat/${id}`);
  assert.equal(detail.body.revisions.length, 2);
  assert.equal(detail.body.revisions[0].requested_by_name, 'Rina Administrasi');
});

test('25. persetujuan sebelumnya tetap tercatat sebagai histori setelah revisi pejabat', async () => {
  const id = await newSubmission();
  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT' });
  await dosen.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU', catatan: 'Pembimbing menyetujui versi 1' });

  const revisi = await ketua.post(`/api/pejabat/pengajuan/${id}/keputusan`, {
    decision: 'REVISI',
    catatan: 'Rentang tanggal penelitian terlalu panjang, mohon dipersingkat.',
  });
  assert.equal(revisi.status, 200);
  assert.equal(revisi.body.pengajuan.status_pengajuan, 'PERLU_REVISI');

  const pendingAfterRevision = getDb()
    .prepare("SELECT COUNT(*) AS total FROM jalur_persetujuan WHERE pengajuan_id = ? AND status_persetujuan = 'MENUNGGU'")
    .get(id);
  assert.equal(pendingAfterRevision.total, 0, 'tidak ada tahap yang dapat diproses selama revisi');

  await mahasiswa.put(`/api/mahasiswa/pengajuan/${id}/resubmit`, { payload: sipPayload({ tanggal_selesai: '2026-11-30' }) });
  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT' });

  const queueDosen = await dosen.get('/api/pejabat/antrean');
  assert.ok(queueDosen.body.pengajuan.map((p) => p.id).includes(id), 'tahap pejabat dijalankan ulang dari awal setelah revisi');

  const history = getDb()
    .prepare('SELECT * FROM jalur_persetujuan WHERE pengajuan_id = ? ORDER BY round_number, urutan_hierarki')
    .all(id);
  const round1Approval = history.find((h) => h.round_number === 1 && h.urutan_hierarki === 1);
  assert.ok(round1Approval, 'keputusan ronde pertama tidak dihapus');
  assert.equal(round1Approval.status_persetujuan, 'DISETUJUI');
  assert.equal(round1Approval.catatan, 'Pembimbing menyetujui versi 1');

  const round1Revision = history.find((h) => h.round_number === 1 && h.urutan_hierarki === 2);
  assert.equal(round1Revision.status_persetujuan, 'REVISI');
  assert.equal(round1Revision.catatan, 'Rentang tanggal penelitian terlalu panjang, mohon dipersingkat.');
});

test('25b. revisi yang melewati batas waktu menjadi kedaluwarsa', async () => {
  const id = await newSubmission();
  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'REVISI', catatan: 'Lengkapi data instansi tujuan.' });

  // Memajukan deadline ke masa lalu untuk menguji pengecekan berkala.
  getDb().prepare('UPDATE pengajuan_surat SET deadline_revisi = ? WHERE id = ?').run(new Date(Date.now() - 86400000).toISOString(), id);

  const check = await staf.post('/api/staf/expiry-check');
  assert.equal(check.status, 200);
  assert.ok(check.body.pengajuan_ids.includes(id));

  const row = getDb().prepare('SELECT * FROM pengajuan_surat WHERE id = ?').get(id);
  assert.equal(row.status_pengajuan, 'KEDALUWARSA');
  assert.equal(row.deadline_revisi, null);

  const resubmit = await mahasiswa.put(`/api/mahasiswa/pengajuan/${id}/resubmit`, { payload: sipPayload() });
  assert.equal(resubmit.status, 409, 'pengajuan kedaluwarsa tidak dapat dikirim ulang');
  assert.equal(resubmit.body.code, 'NOT_IN_REVISION');

  const audit = getDb().prepare("SELECT * FROM audit_logs WHERE submission_id = ? AND action = 'PENGAJUAN_KEDALUWARSA'").get(id);
  assert.ok(audit, 'kedaluwarsa tercatat pada audit log');

  // Pengecekan ulang harus idempoten (tidak mengubah apa pun lagi).
  const again = await staf.post('/api/staf/expiry-check');
  assert.ok(!again.body.pengajuan_ids.includes(id), 'pengecekan kedua tidak memproses pengajuan yang sudah kedaluwarsa');
});

test('25c. pengajuan yang dikirim ulang tepat waktu tidak menjadi kedaluwarsa', async () => {
  const id = await newSubmission();
  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'REVISI', catatan: 'Perbaiki keterangan tambahan.' });

  await mahasiswa.put(`/api/mahasiswa/pengajuan/${id}/resubmit`, { payload: sipPayload() });
  const check = await staf.post('/api/staf/expiry-check');
  assert.ok(!check.body.pengajuan_ids.includes(id));

  const row = getDb().prepare('SELECT status_pengajuan FROM pengajuan_surat WHERE id = ?').get(id);
  assert.equal(row.status_pengajuan, 'MENUNGGU_VERIFIKASI_STAF');
});
