'use strict';

/**
 * Helper pengujian.
 *
 * Setiap file test berjalan pada proses sendiri (node --test) sehingga
 * mendapatkan database SQLite temporer dan folder storage terpisah. Variabel
 * lingkungan WAJIB diset sebelum modul aplikasi dimuat.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const request = require('supertest');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eoffice-test-'));

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(TMP_DIR, 'test.sqlite');
process.env.STORAGE_PATH = path.join(TMP_DIR, 'documents');
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.BASE_URL = 'http://localhost:3000';
process.env.REVISION_DEADLINE_DAYS = process.env.REVISION_DEADLINE_DAYS || '3';
process.env.INSTITUTION_NAME = 'Universitas Uji Nusantara';
process.env.FACULTY_NAME = 'Fakultas Teknik Uji';
process.env.DEPARTMENT_NAME = 'Jurusan Teknik Informatika Uji';
process.env.INSTITUTION_ADDRESS = 'Jl. Pengujian No. 1';

const { runMigrations } = require('../../database/migrations/run');
const { seed, DEMO } = require('../../database/seeders/seed');
const { createApp } = require('../../src/app');
const { getDb, closeDb } = require('../../src/config/database');

let appInstance = null;
let bootPromise = null;

async function bootstrap() {
  if (appInstance) return appInstance;
  if (!bootPromise) {
    bootPromise = (async () => {
      runMigrations();
      await seed();
      appInstance = createApp();
      return appInstance;
    })();
  }
  return bootPromise;
}

function app() {
  if (!appInstance) throw new Error('Panggil bootstrap() terlebih dahulu.');
  return appInstance;
}

/** Login + mengembalikan agent yang sudah membawa cookie dan token CSRF. */
async function makeAgent(email, password) {
  const instance = await bootstrap();
  const agent = request.agent(instance);

  const csrfRes = await agent.get('/api/auth/csrf').expect(200);
  let csrf = csrfRes.body.csrfToken;

  if (email) {
    const res = await agent.post('/api/auth/login').set('x-csrf-token', csrf).send({ email, password });
    if (res.status !== 200) {
      throw new Error(`Login gagal untuk ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    csrf = res.body.csrfToken;
  }

  return {
    agent,
    csrf,
    get: (url) => agent.get(url),
    post: (url, body) => agent.post(url).set('x-csrf-token', csrf).send(body),
    put: (url, body) => agent.put(url).set('x-csrf-token', csrf).send(body),
    patch: (url, body) => agent.patch(url).set('x-csrf-token', csrf).send(body),
  };
}

const ACCOUNTS = {
  mahasiswa: { email: DEMO.mahasiswa.email, password: DEMO.mahasiswa.password },
  mahasiswa2: { email: DEMO.mahasiswa2.email, password: DEMO.mahasiswa2.password },
  staf: { email: DEMO.staf.email, password: DEMO.staf.password },
  dosen: { email: DEMO.dosen.email, password: DEMO.dosen.password },
  ketua: { email: DEMO.ketua.email, password: DEMO.ketua.password },
  wakil: { email: DEMO.wakil.email, password: DEMO.wakil.password },
  nonaktif: { email: DEMO.inactive.email, password: DEMO.inactive.password },
};

/** Login sebagai salah satu akun demo. */
async function loginAs(key) {
  const acc = ACCOUNTS[key];
  if (!acc) throw new Error(`Akun demo "${key}" tidak dikenal.`);
  return makeAgent(acc.email, acc.password);
}

/** Mencari id template berdasarkan kode. */
function templateIdByKode(kode) {
  return getDb().prepare('SELECT id FROM template_surat WHERE kode = ?').get(kode).id;
}

/** Payload valid untuk Surat Izin Penelitian (SIP). */
function sipPayload(overrides = {}) {
  return {
    judul_penelitian: 'Sistem Informasi Persuratan Berbasis Web',
    nama_instansi: 'PT Teknologi Nusantara',
    alamat_instansi: 'Jl. Industri Raya No. 45, Kota Contoh',
    tujuan_penelitian: 'Mengumpulkan data proses bisnis persuratan untuk penelitian skripsi.',
    tanggal_mulai: '2026-10-01',
    tanggal_selesai: '2026-12-31',
    nama_dosen_pembimbing: 'Dr. Andi Pratama, M.Kom.',
    keterangan_tambahan: 'Mohon dibalas melalui email.',
    ...overrides,
  };
}

/** Membuat pengajuan SIP lengkap sampai PDF final. Mengembalikan id & referensi. */
async function createCompletedSubmission({ student, staff, dosen, ketua }) {
  const created = await student.post('/api/mahasiswa/pengajuan', {
    template_id: templateIdByKode('SIP'),
    payload: sipPayload(),
  });
  if (created.status !== 201) throw new Error(`gagal membuat pengajuan: ${created.status} ${JSON.stringify(created.body)}`);
  const id = created.body.pengajuan.id;

  const verified = await staff.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT', catatan: 'Berkas lengkap' });
  if (verified.status !== 200) throw new Error(`gagal verifikasi staf: ${JSON.stringify(verified.body)}`);

  const first = await dosen.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU', catatan: 'Disetujui pembimbing' });
  if (first.status !== 200) throw new Error(`gagal approve dosen: ${JSON.stringify(first.body)}`);

  const second = await ketua.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU', catatan: 'Disetujui ketua jurusan' });
  if (second.status !== 200) throw new Error(`gagal approve ketua: ${JSON.stringify(second.body)}`);

  return { id, created: created.body, final: second.body };
}

function resetDb() {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${process.env.DATABASE_PATH}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

module.exports = {
  TMP_DIR,
  bootstrap,
  app,
  makeAgent,
  loginAs,
  ACCOUNTS,
  DEMO,
  templateIdByKode,
  sipPayload,
  createCompletedSubmission,
  getDb,
  closeDb,
  resetDb,
};
