'use strict';

/**
 * Membuat contoh pengajuan pada berbagai status melalui API aplikasi yang
 * sedang berjalan. Berguna untuk menelusuri antarmuka dashboard.
 *
 * Penggunaan (server harus aktif):
 *   npm start            (terminal lain)
 *   node database/seeders/demo-workflows.js
 *
 * Idempoten secara praktis: setiap kali dijalankan akan membuat satu set
 * pengajuan baru (data dummy), bukan menimpa data yang sudah ada.
 */
const BASE = process.env.BASE_URL || 'http://localhost:3000';

const ACCOUNTS = {
  mahasiswa: { email: 'mahasiswa@demo.eoffice.test', password: 'Mahasiswa#2026' },
  mahasiswa2: { email: 'mahasiswa2@demo.eoffice.test', password: 'Mahasiswa#2026' },
  staf: { email: 'staf@demo.eoffice.test', password: 'Staf#2026' },
  dosen: { email: 'dosen@demo.eoffice.test', password: 'Pejabat#2026' },
  ketua: { email: 'ketua@demo.eoffice.test', password: 'Pejabat#2026' },
};

async function login(key) {
  const jar = {};
  const csrfRes = await fetch(`${BASE}/api/csrf`);
  const { csrfToken } = await csrfRes.json();
  for (const cookie of csrfRes.headers.getSetCookie()) {
    const [pair] = cookie.split(';');
    jar[pair.split('=')[0]] = pair.slice(pair.indexOf('=') + 1);
  }

  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken, cookie: cookieString(jar) },
    body: JSON.stringify(ACCOUNTS[key]),
  });
  for (const cookie of res.headers.getSetCookie()) {
    const [pair] = cookie.split(';');
    jar[pair.split('=')[0]] = pair.slice(pair.indexOf('=') + 1);
  }
  if (!res.ok) throw new Error(`Login ${key} gagal: ${res.status}`);
  const body = await res.json();

  return {
    csrf: body.csrfToken,
    async request(method, url, payload) {
      const headers = { cookie: cookieString(jar), accept: 'application/json' };
      if (payload !== undefined) {
        headers['content-type'] = 'application/json';
        headers['x-csrf-token'] = body.csrfToken;
      }
      const r = await fetch(`${BASE}${url}`, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
      const text = await r.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      return { status: r.status, body: data };
    },
  };
}

function cookieString(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

function sipPayload(overrides = {}) {
  return {
    judul_penelitian: 'Sistem Informasi Persuratan Berbasis Web',
    nama_instansi: 'PT Teknologi Nusantara',
    alamat_instansi: 'Jl. Industri Raya No. 45, Kota Contoh 40111',
    tujuan_penelitian: 'Mengumpulkan data proses bisnis persuratan untuk keperluan skripsi.',
    tanggal_mulai: '2026-11-01',
    tanggal_selesai: '2027-01-31',
    nama_dosen_pembimbing: 'Dr. Andi Pratama, M.Kom.',
    keterangan_tambahan: 'Mohon konfirmasi melalui email jurusan.',
    ...overrides,
  };
}

async function main() {
  const [mahasiswa, mahasiswa2, staf, dosen, ketua] = await Promise.all([
    login('mahasiswa'),
    login('mahasiswa2'),
    login('staf'),
    login('dosen'),
    login('ketua'),
  ]);

  const templates = await mahasiswa.request('GET', '/api/mahasiswa/templates');
  const sip = templates.body.templates.find((t) => t.kode === 'SIP');
  const skak = templates.body.templates.find((t) => t.kode === 'SKAK');
  if (!sip || !skak) throw new Error('Template demo tidak ditemukan. Jalankan `npm run seed` lebih dulu.');

  const results = [];

  // 1) Menunggu verifikasi staf
  const a = await mahasiswa.request('POST', '/api/mahasiswa/pengajuan', { template_id: sip.id, payload: sipPayload() });
  results.push(['MENUNGGU_VERIFIKASI_STAF', a]);

  // 2) Perlu revisi (staf meminta perbaikan)
  const b = await mahasiswa.request('POST', '/api/mahasiswa/pengajuan', { template_id: sip.id, payload: sipPayload({ nama_instansi: 'PT Contoh Sejahtera' }) });
  await staf.request('POST', `/api/staf/pengajuan/${b.body.pengajuan.id}/verifikasi`, {
    decision: 'REVISI',
    catatan: 'Alamat instansi belum lengkap. Mohon cantumkan kelurahan dan kode pos.',
  });
  results.push(['PERLU_REVISI', b]);

  // 3) Menunggu keputusan Dosen Pembimbing
  const c = await mahasiswa2.request('POST', '/api/mahasiswa/pengajuan', { template_id: sip.id, payload: sipPayload({ judul_penelitian: 'Analisis Kepuasan Layanan Akademik' }) });
  await staf.request('POST', `/api/staf/pengajuan/${c.body.pengajuan.id}/verifikasi`, { decision: 'LANJUT', catatan: 'Berkas lengkap.' });
  results.push(['MENUNGGU_PERSETUJUAN (tahap 1)', c]);

  // 4) Menunggu keputusan Ketua Jurusan (tahap 2)
  const d = await mahasiswa.request('POST', '/api/mahasiswa/pengajuan', { template_id: sip.id, payload: sipPayload({ judul_penelitian: 'Optimasi Basis Data Akademik' }) });
  await staf.request('POST', `/api/staf/pengajuan/${d.body.pengajuan.id}/verifikasi`, { decision: 'LANJUT' });
  await dosen.request('POST', `/api/pejabat/pengajuan/${d.body.pengajuan.id}/keputusan`, { decision: 'SETUJU', catatan: 'Disetujui pembimbing.' });
  results.push(['MENUNGGU_PERSETUJUAN (tahap 2)', d]);

  // 5) Selesai dengan PDF final
  const e = await mahasiswa.request('POST', '/api/mahasiswa/pengajuan', { template_id: sip.id, payload: sipPayload({ judul_penelitian: 'Rancang Bangun Portal Data Jurusan' }) });
  await staf.request('POST', `/api/staf/pengajuan/${e.body.pengajuan.id}/verifikasi`, { decision: 'LANJUT' });
  await dosen.request('POST', `/api/pejabat/pengajuan/${e.body.pengajuan.id}/keputusan`, { decision: 'SETUJU', catatan: 'Disetujui pembimbing.' });
  const selesai = await ketua.request('POST', `/api/pejabat/pengajuan/${e.body.pengajuan.id}/keputusan`, { decision: 'SETUJU', catatan: 'Disetujui ketua jurusan.' });
  results.push(['SELESAI', { status: selesai.status, body: { pengajuan: selesai.body.pengajuan, surat_number: selesai.body.pengajuan?.surat_number } }]);

  // 6) Ditolak oleh pejabat
  const f = await mahasiswa2.request('POST', '/api/mahasiswa/pengajuan', { template_id: skak.id, payload: { semester: '6', tahun_akademik: '2026/2027', keperluan: 'Beasiswa', keterangan: 'Untuk pendaftaran beasiswa prestasi.' } });
  await staf.request('POST', `/api/staf/pengajuan/${f.body.pengajuan.id}/verifikasi`, { decision: 'LANJUT' });
  await ketua.request('POST', `/api/pejabat/pengajuan/${f.body.pengajuan.id}/keputusan`, { decision: 'TOLAK', catatan: 'Keperluan beasiswa harus dilengkapi surat rekomendasi pembimbing.' });
  results.push(['DITOLAK', f]);

  console.log('Contoh pengajuan berhasil dibuat:');
  for (const [status, res] of results) {
    console.log(`  - ${status.padEnd(32)} ${res.body?.pengajuan?.public_reference || '-'} (HTTP ${res.status})`);
  }
  console.log('\nMasuk sebagai staf/pejabat untuk melihat antrean pada masing-masing dashboard.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[demo-workflows] gagal:', error.message);
    process.exit(1);
  });
}

module.exports = { main };
