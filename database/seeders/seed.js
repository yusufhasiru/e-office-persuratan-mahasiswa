'use strict';

/**
 * Seeder data awal e-Office.
 *
 * Aman dijalankan berulang kali: seluruh penulisan memakai pola "hanya buat
 * bila belum ada" sehingga TIDAK menimpa akun atau data yang sudah ada.
 *
 * Penggunaan: npm run seed
 * Di NODE_ENV=production seeder menolak berjalan kecuali dipaksa: npm run seed -- --force
 */
const bcrypt = require('bcryptjs');
const { env } = require('../../src/config/env');
const { getDb, closeDb } = require('../../src/config/database');
const { runMigrations } = require('../migrations/run');

const DEMO = {
  mahasiswa: { nim: '2021010001', email: 'mahasiswa@demo.eoffice.test', fullName: 'Budi Santoso', studyProgram: 'Teknik Informatika', password: 'Mahasiswa#2026' },
  mahasiswa2: { nim: '2021010002', email: 'mahasiswa2@demo.eoffice.test', fullName: 'Sari Wulandari', studyProgram: 'Teknik Informatika', password: 'Mahasiswa#2026' },
  staf: { employeeId: 'STF-0001', email: 'staf@demo.eoffice.test', fullName: 'Rina Administrasi', password: 'Staf#2026' },
  dosen: { employeeId: 'NIDN-1001', email: 'dosen@demo.eoffice.test', fullName: 'Dr. Andi Pratama, M.Kom.', password: 'Pejabat#2026' },
  ketua: { employeeId: 'NIDN-1002', email: 'ketua@demo.eoffice.test', fullName: 'Prof. Dewi Kartika, Ph.D.', password: 'Pejabat#2026' },
  wakil: { employeeId: 'NIDN-1003', email: 'wakil@demo.eoffice.test', fullName: 'Dr. Eng. Rudi Hartono, M.T.', password: 'Pejabat#2026' },
  inactive: { employeeId: 'NIDN-1004', email: 'nonaktif@demo.eoffice.test', fullName: 'Dosen Non Aktif, M.Kom.', password: 'Pejabat#2026' },
};

const POSITIONS = [
  { position_name: 'Staf Administrasi', description: 'Petugas administrasi persuratan jurusan' },
  { position_name: 'Dosen Pembimbing', description: 'Dosen pembimbing akademik / penelitian mahasiswa' },
  { position_name: 'Ketua Jurusan', description: 'Pimpinan jurusan sebagai pemaraf akhir surat' },
  { position_name: 'Wakil Dekan', description: 'Pemaraf pada level fakultas' },
];

const TEMPLATES = [
  {
    kode: 'SIP',
    nama_surat: 'Surat Izin Penelitian',
    deskripsi: 'Permohonan izin pelaksanaan penelitian pada instansi di luar kampus.',
    persyaratan: [
      'Sudah menyelesaikan proposal penelitian',
      'Nama dan alamat instansi tujuan jelas',
      'Rentang tanggal penelitian telah disetujui dosen pembimbing',
    ].join('\n'),
    form_schema: [
      { name: 'judul_penelitian', label: 'Judul Penelitian', type: 'text', placeholder: 'Contoh: Sistem Informasi Persuratan Berbasis Web', required: true, minLength: 5, order: 1 },
      { name: 'nama_instansi', label: 'Nama Instansi Tujuan', type: 'text', placeholder: 'Contoh: PT Teknologi Nusantara', required: true, minLength: 3, order: 2 },
      { name: 'alamat_instansi', label: 'Alamat Instansi', type: 'textarea', placeholder: 'Alamat lengkap instansi tujuan', required: true, minLength: 10, order: 3 },
      { name: 'tujuan_penelitian', label: 'Tujuan Penelitian', type: 'textarea', placeholder: 'Jelaskan tujuan pengambilan data/penelitian', required: true, minLength: 10, order: 4 },
      { name: 'tanggal_mulai', label: 'Tanggal Mulai Penelitian', type: 'date', required: true, order: 5 },
      { name: 'tanggal_selesai', label: 'Tanggal Selesai Penelitian', type: 'date', required: true, order: 6 },
      { name: 'nama_dosen_pembimbing', label: 'Nama Dosen Pembimbing', type: 'text', required: true, minLength: 3, order: 7 },
      { name: 'keterangan_tambahan', label: 'Keterangan Tambahan', type: 'textarea', required: false, order: 8 },
    ],
    routes: ['Dosen Pembimbing', 'Ketua Jurusan'],
  },
  {
    kode: 'SKAK',
    nama_surat: 'Surat Keterangan Aktif Kuliah',
    deskripsi: 'Keterangan resmi bahwa mahasiswa masih aktif menempuh studi.',
    persyaratan: [
      'Mahasiswa terdaftar pada semester berjalan',
      'Tidak sedang menjalani cuti akademik',
    ].join('\n'),
    form_schema: [
      { name: 'semester', label: 'Semester', type: 'number', required: true, min: 1, max: 14, order: 1 },
      { name: 'tahun_akademik', label: 'Tahun Akademik', type: 'text', placeholder: 'Contoh: 2026/2027', required: true, order: 2 },
      {
        name: 'keperluan',
        label: 'Keperluan',
        type: 'select',
        required: true,
        order: 3,
        options: [
          { value: 'Beasiswa', label: 'Pengajuan Beasiswa' },
          { value: 'Tunjangan Orang Tua', label: 'Tunjangan Orang Tua' },
          { value: 'Administrasi Bank', label: 'Administrasi Bank' },
          { value: 'Lainnya', label: 'Lainnya' },
        ],
      },
      { name: 'keterangan', label: 'Keterangan Tambahan', type: 'textarea', required: false, order: 4 },
    ],
    routes: ['Ketua Jurusan'],
  },
  {
    kode: 'PKL',
    nama_surat: 'Surat Pengantar PKL',
    deskripsi: 'Surat pengantar pelaksanaan Praktik Kerja Lapangan / magang.',
    persyaratan: ['Sudah mengambil mata kuliah PKL', 'Instansi tujuan telah menyatakan bersedia'].join('\n'),
    form_schema: [
      { name: 'nama_instansi', label: 'Nama Instansi', type: 'text', required: true, minLength: 3, order: 1 },
      { name: 'alamat_instansi', label: 'Alamat Instansi', type: 'textarea', required: true, minLength: 10, order: 2 },
      { name: 'bidang_pkl', label: 'Bidang PKL', type: 'text', required: true, order: 3 },
      { name: 'tanggal_mulai', label: 'Tanggal Mulai PKL', type: 'date', required: true, order: 4 },
      { name: 'tanggal_selesai', label: 'Tanggal Selesai PKL', type: 'date', required: true, order: 5 },
      { name: 'nama_dosen_pembimbing', label: 'Dosen Pembimbing PKL', type: 'text', required: true, order: 6 },
    ],
    routes: ['Dosen Pembimbing', 'Ketua Jurusan'],
  },
  {
    kode: 'PData',
    nama_surat: 'Surat Permohonan Data',
    deskripsi: 'Permohonan pengambilan data untuk keperluan akademik atau penelitian.',
    persyaratan: ['Data yang diminta dijelaskan secara rinci', 'Sudah mendapat izin dosen pembimbing'].join('\n'),
    form_schema: [
      { name: 'instansi_tujuan', label: 'Instansi Tujuan', type: 'text', required: true, order: 1 },
      { name: 'alamat_instansi', label: 'Alamat Instansi', type: 'textarea', required: true, minLength: 10, order: 2 },
      { name: 'data_dibutuhkan', label: 'Data yang Dibutuhkan', type: 'textarea', required: true, minLength: 10, order: 3 },
      { name: 'keperluan', label: 'Keperluan', type: 'text', required: true, order: 4 },
      { name: 'tanggal_dibutuhkan', label: 'Tanggal Dibutuhkan', type: 'date', required: true, order: 5 },
    ],
    routes: ['Ketua Jurusan'],
  },
  {
    kode: 'TA',
    nama_surat: 'Surat Pengantar Tugas Akhir',
    deskripsi: 'Pengantar pengajuan judul/pelaksanaan tugas akhir kepada instansi terkait.',
    persyaratan: ['Judul tugas akhir telah disetujui dosen pembimbing', 'Lulus mata kuliah prasyarat tugas akhir'].join('\n'),
    form_schema: [
      { name: 'judul_ta', label: 'Judul Tugas Akhir', type: 'text', required: true, minLength: 5, order: 1 },
      { name: 'dosen_pembimbing', label: 'Dosen Pembimbing', type: 'text', required: true, order: 2 },
      { name: 'instansi_tujuan', label: 'Instansi Tujuan', type: 'text', required: true, order: 3 },
      { name: 'alamat_instansi', label: 'Alamat Instansi', type: 'textarea', required: true, minLength: 10, order: 4 },
      { name: 'tanggal_mulai', label: 'Tanggal Mulai', type: 'date', required: true, order: 5 },
      { name: 'tanggal_selesai', label: 'Tanggal Selesai', type: 'date', required: true, order: 6 },
    ],
    routes: ['Dosen Pembimbing', 'Ketua Jurusan'],
  },
];

function seedPositions(db) {
  const insert = db.prepare('INSERT OR IGNORE INTO positions (position_name, description) VALUES (?, ?)');
  for (const p of POSITIONS) insert.run(p.position_name, p.description);
  return Object.fromEntries(db.prepare('SELECT id, position_name FROM positions').all().map((r) => [r.position_name, r.id]));
}

async function seedUsers(db, positions) {
  const byEmail = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)');
  const results = { created: [], existing: [], credentials: [] };

  const accounts = [
    { ...DEMO.mahasiswa, role: 'MAHASISWA', nim: DEMO.mahasiswa.nim, group: 'mahasiswa' },
    { ...DEMO.mahasiswa2, role: 'MAHASISWA', nim: DEMO.mahasiswa2.nim, group: 'mahasiswa' },
    { ...DEMO.staf, role: 'STAF', position: 'Staf Administrasi', group: 'staf' },
    { ...DEMO.dosen, role: 'PEJABAT', position: 'Dosen Pembimbing', group: 'pejabat' },
    { ...DEMO.ketua, role: 'PEJABAT', position: 'Ketua Jurusan', group: 'pejabat' },
    { ...DEMO.wakil, role: 'PEJABAT', position: 'Wakil Dekan', group: 'pejabat' },
    { ...DEMO.inactive, role: 'PEJABAT', position: 'Dosen Pembimbing', active: false, group: 'pejabat' },
  ];

  for (const acc of accounts) {
    const existing = byEmail.get(acc.email);
    if (existing) {
      results.existing.push(acc.email);
      continue;
    }
    const passwordHash = await bcrypt.hash(acc.password, 10);
    db.prepare(
      `INSERT INTO users (nim, employee_id, full_name, email, password_hash, role, study_program, position_id, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      acc.nim || null,
      acc.employeeId || null,
      acc.fullName,
      acc.email,
      passwordHash,
      acc.role,
      acc.studyProgram || null,
      acc.position ? positions[acc.position] : null,
      acc.active === false ? 0 : 1
    );
    results.created.push(acc.email);
    results.credentials.push({ email: acc.email, role: acc.role, password: acc.password, active: acc.active !== false });
  }
  return results;
}

function seedTemplates(db, positions) {
  const byCode = db.prepare('SELECT * FROM template_surat WHERE kode = ?');
  const created = [];
  const existing = [];

  for (const t of TEMPLATES) {
    if (byCode.get(t.kode)) {
      existing.push(t.kode);
      continue;
    }
    const info = db
      .prepare(
        `INSERT INTO template_surat (kode, nama_surat, deskripsi, persyaratan, form_schema_json, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`
      )
      .run(t.kode, t.nama_surat, t.deskripsi, t.persyaratan, JSON.stringify(t.form_schema));

    const insertRoute = db.prepare(
      `INSERT INTO rute_approval_template (template_id, urutan_ke, position_id, assigned_employee_id, is_required)
       VALUES (?, ?, ?, NULL, 1)`
    );
    t.routes.forEach((positionName, index) => {
      const positionId = positions[positionName];
      if (!positionId) throw new Error(`Jabatan "${positionName}" tidak ditemukan saat membuat rute ${t.kode}`);
      insertRoute.run(info.lastInsertRowid, index + 1, positionId);
    });
    created.push(t.kode);
  }
  return { created, existing };
}

async function seed({ force = false } = {}) {
  if (env.isProduction && !force) {
    throw new Error('Seeder menolak berjalan pada NODE_ENV=production tanpa flag --force.');
  }
  runMigrations();
  const db = getDb();
  const positions = seedPositions(db);
  const users = await seedUsers(db, positions);
  const templates = seedTemplates(db, positions);
  return { positions: Object.keys(positions), users, templates };
}

if (require.main === module) {
  seed({ force: process.argv.includes('--force') })
    .then((result) => {
      console.log('[seed] jabatan       :', result.positions.join(', '));
      console.log('[seed] template baru :', result.templates.created.join(', ') || '-');
      console.log('[seed] template ada  :', result.templates.existing.join(', ') || '-');
      console.log('[seed] akun baru     :', result.users.created.join(', ') || '-');
      console.log('[seed] akun ada      :', result.users.existing.join(', ') || '-');
      if (result.users.credentials.length) {
        console.log('\n[seed] KREDENSIAL DEMO (hanya untuk development):');
        for (const c of result.users.credentials) {
          console.log(`       ${c.role.padEnd(9)} ${c.email.padEnd(34)} ${c.password}${c.active ? '' : '  (akun NONAKTIF untuk pengujian)'}`);
        }
        console.log('       Ubah kredensial ini sebelum dipakai di lingkungan nyata.\n');
      }
      closeDb();
    })
    .catch((error) => {
      console.error('[seed] gagal:', error.message);
      closeDb();
      process.exit(1);
    });
}

module.exports = { seed, DEMO, TEMPLATES };
