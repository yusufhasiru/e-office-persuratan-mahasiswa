'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { bootstrap, loginAs, templateIdByKode, sipPayload, getDb, closeDb, makeAgent } = require('./helpers');
const pdfService = require('../src/services/pdf.service');

let mahasiswa;
let mahasiswa2;
let staf;
let dosen;
let ketua;
let captured = null;

before(async () => {
  await bootstrap();
  mahasiswa = await loginAs('mahasiswa');
  mahasiswa2 = await loginAs('mahasiswa2');
  staf = await loginAs('staf');
  dosen = await loginAs('dosen');
  ketua = await loginAs('ketua');
});

after(() => closeDb());

/**
 * Membaca teks yang benar-benar tertanam di dalam berkas PDF: seluruh stream
 * didekompresi, lalu string heksadesimal (bentuk keluaran pdfkit) diterjemahkan
 * kembali menjadi teks. Dipakai untuk membuktikan isi dokumen nyata.
 */
function extractPdfText(buffer) {
  const parts = [];
  let index = 0;
  while ((index = buffer.indexOf('stream', index)) !== -1) {
    let start = index + 6;
    if (buffer[start] === 13) start += 1;
    if (buffer[start] === 10) start += 1;
    const end = buffer.indexOf('endstream', start);
    if (end === -1) break;
    try {
      parts.push(zlib.inflateSync(buffer.subarray(start, end)).toString('latin1'));
    } catch {
      /* stream bukan Flate (mis. data gambar) */
    }
    index = end + 9;
  }
  const raw = parts.join('\n');
  return (raw.match(/<([0-9a-fA-F]{2,})>/g) || [])
    .map((hex) => Buffer.from(hex.slice(1, -1), 'hex').toString('latin1'))
    .join('');
}

/** Menjalankan alur sampai SELESAI sambil menangkap URL verifikasi (isi QR Code). */
async function completedSubmission() {
  const created = await mahasiswa.post('/api/mahasiswa/pengajuan', { template_id: templateIdByKode('SIP'), payload: sipPayload() });
  const id = created.body.pengajuan.id;

  const original = pdfService.buildPdfBuffer;
  captured = null;
  pdfService.buildPdfBuffer = async (args) => {
    captured = args;
    return original(args);
  };
  try {
    await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT' });
    await dosen.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU', catatan: 'Disetujui pembimbing' });
    await ketua.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU', catatan: 'Disetujui ketua jurusan' });
  } finally {
    pdfService.buildPdfBuffer = original;
  }
  return { id, url: captured.verificationUrl, approvers: captured.approvers };
}

test('26. PDF hanya dibuat setelah seluruh persetujuan wajib selesai', async () => {
  const created = await mahasiswa.post('/api/mahasiswa/pengajuan', { template_id: templateIdByKode('SIP'), payload: sipPayload() });
  const id = created.body.pengajuan.id;

  assert.equal((await mahasiswa.get(`/api/surat/${id}/pdf`)).status, 409, 'belum boleh diunduh saat masih menunggu verifikasi');

  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT' });
  assert.equal((await mahasiswa.get(`/api/surat/${id}/pdf`)).status, 409, 'belum boleh diunduh saat menunggu pejabat');

  await dosen.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU' });
  const row = getDb().prepare('SELECT * FROM pengajuan_surat WHERE id = ?').get(id);
  assert.equal(row.status_pengajuan, 'MENUNGGU_PERSETUJUAN');
  assert.equal(row.pdf_path, null, 'PDF belum dibuat sebelum pejabat terakhir menyetujui');

  await ketua.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU' });
  const after = getDb().prepare('SELECT * FROM pengajuan_surat WHERE id = ?').get(id);
  assert.equal(after.status_pengajuan, 'SELESAI');
  assert.ok(fs.existsSync(path.resolve(__dirname, '..', after.pdf_path)), 'berkas PDF benar-benar ada di storage');
});

test('27. mahasiswa pemilik dapat mengunduh PDF final dengan isi yang sah', async () => {
  const { id } = await completedSubmission();
  const res = await mahasiswa.get(`/api/surat/${id}/pdf`);

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'], /attachment/);
  const buffer = res.body;
  assert.ok(buffer.length > 5000, 'berkas PDF tidak kosong');
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-', 'berkas diawali header PDF');
  assert.ok(buffer.includes(Buffer.from('%%EOF')), 'berkas PDF lengkap');
  assert.ok(buffer.includes(Buffer.from('/Subtype /Image')), 'QR Code tertanam sebagai gambar pada PDF');

  const row = getDb().prepare('SELECT pdf_checksum, pdf_path, surat_number FROM pengajuan_surat WHERE id = ?').get(id);
  const fileBuffer = fs.readFileSync(path.resolve(__dirname, '..', row.pdf_path));
  const { sha256 } = require('../src/utils/crypto');
  assert.equal(sha256(fileBuffer), row.pdf_checksum, 'checksum tersimpan sama dengan berkas fisik');
  assert.match(row.surat_number, /^\d{3}\/E-Office\/SIP\/\d{4}$/);
});

test('28. mahasiswa lain tidak dapat mengunduh atau membuka dokumen tersebut', async () => {
  const { id } = await completedSubmission();

  assert.equal((await mahasiswa2.get(`/api/surat/${id}/pdf`)).status, 403, 'pengunduhan ditolak');
  assert.equal((await mahasiswa2.get(`/api/surat/${id}`)).status, 404, 'detail dokumen tidak dapat dibuka pihak lain');
});

test('28b. staf dapat mengunduh untuk keperluan administrasi, pengguna tanpa login ditolak', async () => {
  const { id } = await completedSubmission();
  assert.equal((await staf.get(`/api/surat/${id}/pdf`)).status, 200);

  const anonymous = await makeAgent();
  assert.equal((await anonymous.get(`/api/surat/${id}/pdf`)).status, 401);
});

test('29. QR Code mengarah ke halaman verifikasi yang benar', async () => {
  const { url, approvers } = await completedSubmission();

  assert.ok(url, 'URL verifikasi dikirim ke generator PDF');
  assert.match(url, /^http:\/\/localhost:3000\/verify\/[a-f0-9]{64}$/, 'token acak berentropi tinggi, bukan id berurutan');
  assert.equal(approvers.length, 2, 'daftar pejabat di PDF diambil dari catatan persetujuan database');
  assert.deepEqual(
    approvers.map((a) => a.employee_name),
    ['Dr. Andi Pratama, M.Kom.', 'Prof. Dewi Kartika, Ph.D.']
  );
  assert.ok(approvers.every((a) => a.waktu_diproses), 'waktu persetujuan tercantum');

  const token = url.split('/').pop();
  const halaman = await mahasiswa.agent.get(`/verify/${token}`);
  assert.equal(halaman.status, 200, 'halaman verifikasi publik dapat dibuka tanpa login');

  const api = await (await makeAgent()).get(`/api/verify/${token}`);
  assert.equal(api.status, 200);
  assert.equal(api.body.valid, true);
  assert.equal(api.body.status, 'SAH');
  assert.equal(api.body.jenis_surat, 'Surat Izin Penelitian');
  assert.equal(api.body.pejabat_menyetujui.length, 2);
  assert.equal(api.body.mahasiswa.nama, 'Budi Santoso');
  assert.equal(api.body.integritas_berkas.status, 'COCOK');
  assert.ok(!JSON.stringify(api.body).includes('@'), 'tidak ada data kontak/sensitif pada halaman publik');
});

test('29b. token yang benar-benar tertanam pada berkas PDF dapat diverifikasi', async () => {
  const { id, url, approvers } = await completedSubmission();
  const row = getDb().prepare('SELECT pdf_path, surat_number FROM pengajuan_surat WHERE id = ?').get(id);
  const buffer = fs.readFileSync(path.resolve(__dirname, '..', row.pdf_path));

  const text = extractPdfText(buffer);
  const match = text.match(/https?:\/\/[^\s]*\/verify\/([a-f0-9]{64})/);
  assert.ok(match, 'URL verifikasi tercetak di dalam berkas PDF');
  assert.equal(`http://localhost:3000/verify/${match[1]}`, url, 'token pada berkas sama dengan yang dipakai generator QR');
  assert.ok(text.includes(row.surat_number), 'nomor surat tercetak pada dokumen');
  assert.ok(text.includes(approvers[0].employee_name), 'nama pejabat penyetuju tercetak pada dokumen');
  assert.ok(text.includes('SHA-256'), 'identitas dokumen tercantum pada dokumen');

  // Verifikasi memakai token yang diekstrak dari berkas nyata.
  const verified = await (await makeAgent()).get(`/api/verify/${match[1]}`);
  assert.equal(verified.body.valid, true);
  assert.equal(verified.body.surat_number, row.surat_number);
  assert.equal(verified.body.mahasiswa.nim, '2021010001');
  assert.deepEqual(
    verified.body.pejabat_menyetujui.map((p) => p.nama),
    approvers.map((a) => a.employee_name)
  );
});

test('30. token tidak valid ditolak', async () => {
  const client = await makeAgent();
  const acak = 'a'.repeat(64);

  const tidakDikenal = await client.get(`/api/verify/${acak}`);
  assert.equal(tidakDikenal.body.valid, false);
  assert.equal(tidakDikenal.body.status, 'TIDAK_DITEMUKAN');

  const pendek = await client.get('/api/verify/123');
  assert.equal(pendek.body.valid, false);

  const karakterAneh = await client.get('/api/verify/%3Cscript%3Ealert(1)%3C%2Fscript%3E');
  assert.equal(karakterAneh.body.valid, false);
});

test('31. dokumen yang ditolak atau dibatalkan tidak dinyatakan sah', async () => {
  const { id, url } = await completedSubmission();
  const token = url.split('/').pop();

  // Kondisi di mana dokumen pernah terbit namun statusnya berubah (mis. dicabut /
  // dibatalkan oleh jurusan). Verifikasi harus membaca status terkini di database.
  const db = getDb();
  db.prepare("UPDATE pengajuan_surat SET status_pengajuan = 'DIBATALKAN' WHERE id = ?").run(id);
  const dibatalkan = await (await makeAgent()).get(`/api/verify/${token}`);
  assert.equal(dibatalkan.body.valid, false);
  assert.equal(dibatalkan.body.status, 'DIBATALKAN');
  assert.match(dibatalkan.body.message, /tidak sah/i);

  db.prepare("UPDATE pengajuan_surat SET status_pengajuan = 'DITOLAK' WHERE id = ?").run(id);
  const ditolak = await (await makeAgent()).get(`/api/verify/${token}`);
  assert.equal(ditolak.body.valid, false);

  db.prepare("UPDATE pengajuan_surat SET status_pengajuan = 'MENUNGGU_PERSETUJUAN' WHERE id = ?").run(id);
  const diproses = await (await makeAgent()).get(`/api/verify/${token}`);
  assert.equal(diproses.body.valid, false);
  assert.match(diproses.body.message, /menunggu persetujuan/i);
});

test('32. ketidaksesuaian checksum berkas terdeteksi', async () => {
  const { id, url } = await completedSubmission();
  const token = url.split('/').pop();
  const row = getDb().prepare('SELECT pdf_path FROM pengajuan_surat WHERE id = ?').get(id);
  const file = path.resolve(__dirname, '..', row.pdf_path);

  const bersih = await (await makeAgent()).get(`/api/verify/${token}`);
  assert.equal(bersih.body.integritas_berkas.status, 'COCOK');

  fs.appendFileSync(file, '\n% berkas diubah setelah diterbitkan\n');

  const rusak = await (await makeAgent()).get(`/api/verify/${token}`);
  assert.equal(rusak.body.integritas_berkas.status, 'TIDAK_COCOK');
  assert.match(rusak.body.integritas_berkas.message, /berubah/i);
});

test('32b. berkas PDF tidak dapat diakses langsung sebagai file statis', async () => {
  const { id } = await completedSubmission();
  const row = getDb().prepare('SELECT pdf_path FROM pengajuan_surat WHERE id = ?').get(id);
  const relative = row.pdf_path.replace(/\\/g, '/');

  const viaStorage = await mahasiswa.agent.get(`/${relative}`);
  assert.equal(viaStorage.status, 404, 'storage tidak disajikan sebagai direktori statis');

  const viaDokumen = await mahasiswa.agent.get(`/documents/${path.basename(relative)}`);
  assert.equal(viaDokumen.status, 404);
});
