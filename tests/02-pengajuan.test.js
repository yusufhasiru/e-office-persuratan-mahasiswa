'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootstrap, loginAs, templateIdByKode, sipPayload, getDb, closeDb } = require('./helpers');

before(async () => {
  await bootstrap();
});

after(() => closeDb());

test('7. mahasiswa dapat mengajukan surat dengan data valid', async () => {
  const mahasiswa = await loginAs('mahasiswa');
  const res = await mahasiswa.post('/api/mahasiswa/pengajuan', {
    template_id: templateIdByKode('SIP'),
    payload: sipPayload(),
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.pengajuan.status_pengajuan, 'MENUNGGU_VERIFIKASI_STAF');
  assert.match(res.body.pengajuan.public_reference, /^SRT-\d{4}-\d{6}$/);
  assert.equal(res.body.pengajuan.version_number, 1);

  const row = getDb().prepare('SELECT * FROM pengajuan_surat WHERE id = ?').get(res.body.pengajuan.id);
  assert.equal(row.status_pengajuan, 'MENUNGGU_VERIFIKASI_STAF', 'status tersimpan di database, bukan hanya di respons');
  assert.ok(row.submitted_at, 'waktu pengajuan tercatat');
});

test('8. form menolak data wajib yang kosong beserta detail field', async () => {
  const mahasiswa = await loginAs('mahasiswa');
  const res = await mahasiswa.post('/api/mahasiswa/pengajuan', {
    template_id: templateIdByKode('SIP'),
    payload: { judul_penelitian: '', nama_instansi: 'PT ABC' },
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'FORM_INVALID');
  assert.ok(res.body.details.judul_penelitian, 'error per field dikembalikan');
  assert.ok(res.body.details.alamat_instansi);
  assert.ok(!res.body.details.nama_instansi, 'field yang valid tidak diberi error');
});

test('8b. validasi tanggal selesai tidak boleh lebih awal dari tanggal mulai', async () => {
  const mahasiswa = await loginAs('mahasiswa');
  const res = await mahasiswa.post('/api/mahasiswa/pengajuan', {
    template_id: templateIdByKode('SIP'),
    payload: sipPayload({ tanggal_mulai: '2026-12-01', tanggal_selesai: '2026-11-01' }),
  });

  assert.equal(res.status, 400);
  assert.match(res.body.details.tanggal_selesai, /lebih awal/i);
});

test('8c. template nonaktif tidak dapat diajukan', async () => {
  const staf = await loginAs('staf');
  const mahasiswa = await loginAs('mahasiswa');
  const id = templateIdByKode('PData');

  await staf.put(`/api/staf/templates/${id}`, { is_active: false });
  const res = await mahasiswa.post('/api/mahasiswa/pengajuan', {
    template_id: id,
    payload: { instansi_tujuan: 'Dinas Pendidikan', alamat_instansi: 'Jl. Merdeka 10', data_dibutuhkan: 'Data siswa tahun 2025', keperluan: 'Penelitian', tanggal_dibutuhkan: '2026-11-01' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'TEMPLATE_INACTIVE');

  await staf.put(`/api/staf/templates/${id}`, { is_active: true });
});

test('8d. field di luar skema template diabaikan (whitelist)', async () => {
  const mahasiswa = await loginAs('mahasiswa');
  const res = await mahasiswa.post('/api/mahasiswa/pengajuan', {
    template_id: templateIdByKode('SKAK'),
    payload: {
      semester: '5',
      tahun_akademik: '2026/2027',
      keperluan: 'Beasiswa',
      keterangan: 'Untuk beasiswa prestasi',
      field_liar: 'nilai yang tidak seharusnya masuk',
      role: 'STAF',
    },
  });

  assert.equal(res.status, 201);
  const row = getDb().prepare('SELECT payload_isian_json FROM pengajuan_surat WHERE id = ?').get(res.body.pengajuan.id);
  const payload = JSON.parse(row.payload_isian_json);
  assert.equal(payload.field_liar, undefined, 'field di luar skema tidak tersimpan');
  assert.equal(payload.role, undefined);
  assert.equal(payload.semester, 5, 'tipe number dikonversi sesuai skema');
});

test('8e. input berbahaya disimpan sebagai teks biasa, bukan markup', async () => {
  const mahasiswa = await loginAs('mahasiswa');
  const injection = '<script>alert("xss")</script> OR 1=1 --';
  const res = await mahasiswa.post('/api/mahasiswa/pengajuan', {
    template_id: templateIdByKode('SKAK'),
    payload: { semester: '3', tahun_akademik: '2026/2027', keperluan: 'Lainnya', keterangan: injection },
  });

  assert.equal(res.status, 201);
  const detail = await mahasiswa.get(`/api/surat/${res.body.pengajuan.id}`);
  assert.equal(detail.body.pengajuan.payload_isian.keterangan, injection, 'nilai tersimpan apa adanya sebagai teks JSON');
  assert.ok(!detail.body.pengajuan.payload_isian.keterangan.includes('&#'), 'tidak di-render menjadi entitas HTML');
});

test('9. mahasiswa tidak dapat melihat pengajuan milik mahasiswa lain', async () => {
  const owner = await loginAs('mahasiswa');
  const other = await loginAs('mahasiswa2');

  const created = await owner.post('/api/mahasiswa/pengajuan', {
    template_id: templateIdByKode('SIP'),
    payload: sipPayload(),
  });
  const id = created.body.pengajuan.id;

  const asOther = await other.get(`/api/surat/${id}`);
  assert.equal(asOther.status, 404, 'dikembalikan 404 agar keberadaan dokumen tidak bocor');

  const ownList = await other.get('/api/mahasiswa/pengajuan');
  const ids = ownList.body.pengajuan.map((p) => p.id);
  assert.ok(!ids.includes(id), 'daftar pengajuan hanya memuat milik sendiri');
});

test('9b. mahasiswa tidak dapat mengirim ulang atau membatalkan pengajuan orang lain', async () => {
  const owner = await loginAs('mahasiswa');
  const other = await loginAs('mahasiswa2');

  const created = await owner.post('/api/mahasiswa/pengajuan', {
    template_id: templateIdByKode('SIP'),
    payload: sipPayload(),
  });
  const id = created.body.pengajuan.id;

  const resubmit = await other.put(`/api/mahasiswa/pengajuan/${id}/resubmit`, { payload: sipPayload() });
  assert.equal(resubmit.status, 403);

  const cancel = await other.post(`/api/mahasiswa/pengajuan/${id}/cancel`, { alasan: 'mencoba membatalkan milik orang lain' });
  assert.equal(cancel.status, 403);
});

test('10. pengajuan menyimpan snapshot rute yang benar pada saat dibuat', async () => {
  const mahasiswa = await loginAs('mahasiswa');
  const created = await mahasiswa.post('/api/mahasiswa/pengajuan', {
    template_id: templateIdByKode('SIP'),
    payload: sipPayload(),
  });
  const id = created.body.pengajuan.id;

  const snapshot = getDb()
    .prepare(
      `SELECT sn.urutan_ke, sn.position_name, sn.is_required, u.full_name AS assigned, u.role
       FROM approval_routes_snapshot sn LEFT JOIN users u ON u.id = sn.assigned_employee_id
       WHERE sn.pengajuan_id = ? ORDER BY sn.urutan_ke`
    )
    .all(id);

  assert.equal(snapshot.length, 2);
  assert.equal(snapshot[0].position_name, 'Dosen Pembimbing');
  assert.equal(snapshot[1].position_name, 'Ketua Jurusan');
  assert.equal(snapshot[0].is_required, 1);
  assert.ok(snapshot[0].assigned, 'pejabat penanggung jawab tersimpan di snapshot');
  assert.equal(snapshot[0].role, 'PEJABAT');

  const ketua = getDb().prepare("SELECT id FROM users WHERE email = 'ketua@demo.eoffice.test'").get();
  assert.equal(snapshot[1].assigned, 'Prof. Dewi Kartika, Ph.D.');
  assert.ok(ketua.id > 0);
});

test('10b. riwayat antrean staf tercatat sebagai tahap verifikasi', async () => {
  const mahasiswa = await loginAs('mahasiswa');
  const created = await mahasiswa.post('/api/mahasiswa/pengajuan', {
    template_id: templateIdByKode('SIP'),
    payload: sipPayload(),
  });
  const row = getDb()
    .prepare("SELECT * FROM jalur_persetujuan WHERE pengajuan_id = ? AND urutan_hierarki = 0 AND status_persetujuan = 'MENUNGGU'")
    .get(created.body.pengajuan.id);
  assert.ok(row, 'baris verifikasi staf dibuat saat pengajuan masuk');
  assert.equal(row.round_number, 1);
  assert.equal(row.employee_id, null, 'belum diklaim staf mana pun');
});
