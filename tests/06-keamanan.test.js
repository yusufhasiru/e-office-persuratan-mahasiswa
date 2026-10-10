'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootstrap, loginAs, makeAgent, templateIdByKode, sipPayload, getDb, closeDb } = require('./helpers');

let mahasiswa;
let staf;
let dosen;

before(async () => {
  await bootstrap();
  mahasiswa = await loginAs('mahasiswa');
  staf = await loginAs('staf');
  dosen = await loginAs('dosen');
});

after(() => closeDb());

async function newSubmission(user = mahasiswa) {
  const res = await user.post('/api/mahasiswa/pengajuan', { template_id: templateIdByKode('SIP'), payload: sipPayload() });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.pengajuan.id;
}

test('33. foreign key SQLite aktif dan menolak referensi tidak sah', () => {
  const db = getDb();
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'pragma foreign_keys menyala');

  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO users (employee_id, full_name, email, password_hash, role, position_id)
           VALUES ('X-1','Test','x@test.test','hash','PEJABAT', 999999)`
        )
        .run(),
    /FOREIGN KEY/i,
    'position_id yang tidak ada ditolak'
  );

  assert.throws(
    () => db.prepare('INSERT INTO rute_approval_template (template_id, urutan_ke, position_id) VALUES (999999, 1, 1)').run(),
    /FOREIGN KEY/i,
    'template_id yang tidak ada ditolak'
  );

  // ON DELETE RESTRICT: jabatan yang masih dipakai rute tidak boleh dihapus.
  assert.throws(() => db.prepare('DELETE FROM positions WHERE position_name = ?').run('Dosen Pembimbing'), /FOREIGN KEY|CONSTRAINT/i);

  // UNIQUE pada urutan tahap dalam satu template.
  const templateId = templateIdByKode('SIP');
  assert.throws(() => db.prepare('INSERT INTO rute_approval_template (template_id, urutan_ke, position_id) VALUES (?, 1, 1)').run(templateId), /UNIQUE/i);

  // CHECK constraint status pengajuan (status di luar daftar yang diizinkan ditolak).
  const student = db.prepare("SELECT id FROM users WHERE role = 'MAHASISWA' LIMIT 1").get();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO pengajuan_surat (public_reference, student_id, template_id, payload_isian_json, status_pengajuan)
           VALUES ('UJI-CHECK', ?, ?, '{}', 'STATUS_NGAWUR')`
        )
        .run(student.id, templateIdByKode('SIP')),
    /CHECK/i
  );

  // CHECK constraint role pengguna.
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO users (nim, full_name, email, password_hash, role) VALUES ('999', 'Uji', 'uji@test.test', 'hash', 'ADMIN')")
        .run(),
    /CHECK/i
  );
});

test('34. transaksi di-rollback ketika tahap persetujuan gagal diaktifkan', async () => {
  const id = await newSubmission();

  // Pejabat pada tahap pertama dinonaktifkan sebelum verifikasi diteruskan.
  const users = await staf.get('/api/admin/users?role=PEJABAT');
  const dosenUser = users.body.users.find((u) => u.email === 'dosen@demo.eoffice.test');
  await staf.patch(`/api/admin/users/${dosenUser.id}/status`, { is_active: false });

  const res = await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT', catatan: 'Coba teruskan' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ASSIGNEE_INACTIVE');

  const row = getDb().prepare('SELECT * FROM pengajuan_surat WHERE id = ?').get(id);
  assert.equal(row.status_pengajuan, 'MENUNGGU_VERIFIKASI_STAF', 'status tidak berubah setelah transaksi gagal');
  assert.equal(row.current_step, 0);

  const staffRow = getDb().prepare('SELECT * FROM jalur_persetujuan WHERE pengajuan_id = ? AND urutan_hierarki = 0').get(id);
  assert.equal(staffRow.status_persetujuan, 'MENUNGGU', 'keputusan staf ikut di-rollback');
  assert.equal(staffRow.waktu_diproses, null);
  assert.equal(staffRow.employee_id, null);

  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS total FROM jalur_persetujuan WHERE pengajuan_id = ? AND urutan_hierarki = 1').get(id).total,
    0,
    'tahap pejabat tidak dibuat'
  );
  assert.equal(
    getDb().prepare("SELECT COUNT(*) AS total FROM audit_logs WHERE submission_id = ? AND action = 'VERIFIKASI_STAF_DISETUJUI'").get(id).total,
    0,
    'audit log tidak mencatat keputusan yang gagal'
  );
  assert.equal(
    getDb().prepare("SELECT COUNT(*) AS total FROM document_events WHERE pengajuan_id = ? AND event_type = 'TAHAP_DIAKTIFKAN'").get(id).total,
    0,
    'peristiwa dokumen ikut di-rollback'
  );

  // Setelah pejabat diaktifkan kembali, alur berjalan normal.
  await staf.patch(`/api/admin/users/${dosenUser.id}/status`, { is_active: true });
  const retry = await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT', catatan: 'Pejabat aktif kembali' });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.pengajuan.status_pengajuan, 'MENUNGGU_PERSETUJUAN');

  // Kembalikan agar test berikutnya tidak terpengaruh (database terpisah per file).
  await dosen.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU' });
});

test('35. input berbahaya tidak menyebabkan SQL injection', async () => {
  const anonymous = await makeAgent();
  const injections = ["' OR '1'='1", "admin'--", "'; DROP TABLE users; --", '") OR 1=1 --'];

  for (const payload of injections) {
    const login = await anonymous.post('/api/auth/login', { email: payload, password: payload });
    assert.equal(login.status, 401, `login menolak payload: ${payload}`);
  }

  const search = await staf.get(`/api/staf/pengajuan?q=${encodeURIComponent("' OR 1=1 --")}`);
  assert.equal(search.status, 200);
  assert.equal(search.body.pengajuan.length, 0, 'pencarian diperlakukan sebagai teks biasa');

  const verify = await anonymous.get(`/api/verify/${encodeURIComponent("' OR 1=1 --")}`);
  assert.equal(verify.body.valid, false);

  assert.ok(getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get(), 'tabel users masih ada');

  const injected = await newSubmission();
  const detail = await mahasiswa.get(`/api/surat/${injected}`);
  assert.equal(detail.status, 200);
});

test('35b. parameterized query menyimpan nilai berbahaya apa adanya tanpa eksekusi', async () => {
  const res = await mahasiswa.post('/api/mahasiswa/pengajuan', {
    template_id: templateIdByKode('SKAK'),
    payload: { semester: '2', tahun_akademik: "2026/2027'; DROP TABLE users; --", keperluan: 'Lainnya' },
  });
  assert.equal(res.status, 201);

  const row = getDb().prepare('SELECT payload_isian_json FROM pengajuan_surat WHERE id = ?').get(res.body.pengajuan.id);
  assert.match(row.payload_isian_json, /DROP TABLE users/);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS total FROM users').get().total > 0, true);
});

test('36. seluruh request tanpa otorisasi ditolak', async () => {
  const anonymous = await makeAgent();
  const endpoints = [
    ['get', '/api/mahasiswa/pengajuan'],
    ['get', '/api/staf/antrean'],
    ['get', '/api/pejabat/antrean'],
    ['get', '/api/admin/users'],
    ['get', '/api/surat/1'],
    ['get', '/api/notifications'],
  ];
  for (const [method, url] of endpoints) {
    const res = await anonymous.agent[method](url);
    assert.equal(res.status, 401, `${url} harus menolak pengguna tanpa login`);
  }

  const pages = ['/mahasiswa/dashboard', '/staf/dashboard', '/pejabat/dashboard', '/staf/template'];
  for (const url of pages) {
    const res = await anonymous.agent.get(url);
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /^\/login/);
  }
});

test('36b. role yang salah tidak dapat memakai API role lain walaupun tahu id-nya', async () => {
  const id = await newSubmission();

  assert.equal((await mahasiswa.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT' })).status, 403);
  assert.equal((await mahasiswa.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU' })).status, 403);
  assert.equal((await mahasiswa.post(`/api/admin/users`, { full_name: 'Hacker', email: 'h@h.test', employee_id: 'X-9', password: 'password123', role: 'STAF' })).status, 403);
  assert.equal((await dosen.post(`/api/staf/pengajuan/${id}/retry-pdf`)).status, 403);
  assert.equal((await staf.post(`/api/pejabat/pengajuan/${id}/keputusan`, { decision: 'SETUJU' })).status, 403);
  void dosen;
});

test('37. perubahan rute template tidak mengubah snapshot pengajuan yang sedang berjalan', async () => {
  const id = await newSubmission();

  const before = getDb().prepare('SELECT urutan_ke, position_name FROM approval_routes_snapshot WHERE pengajuan_id = ? ORDER BY urutan_ke').all(id);
  assert.deepEqual(before.map((s) => s.position_name), ['Dosen Pembimbing', 'Ketua Jurusan']);

  // Staf mengubah rute template SIP menjadi hanya satu tahap (Ketua Jurusan).
  const positions = await staf.get('/api/staf/positions');
  const ketuaPosition = positions.body.positions.find((p) => p.position_name === 'Ketua Jurusan');
  const update = await staf.put(`/api/staf/templates/${templateIdByKode('SIP')}`, {
    routes: [{ position_id: ketuaPosition.id, assigned_employee_id: null, is_required: 1 }],
  });
  assert.equal(update.status, 200);

  // Pengajuan lama tetap memakai snapshot 2 tahap.
  const afterSnapshot = getDb().prepare('SELECT urutan_ke, position_name FROM approval_routes_snapshot WHERE pengajuan_id = ? ORDER BY urutan_ke').all(id);
  assert.deepEqual(afterSnapshot, before, 'snapshot pengajuan lama tidak berubah');

  const ruteTemplateBaru = await staf.get('/api/staf/templates');
  const sip = ruteTemplateBaru.body.templates.find((t) => t.kode === 'SIP');
  assert.equal(sip.rute.length, 1, 'rute template memang berubah untuk pengajuan baru');

  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT' });
  const row = getDb().prepare('SELECT current_step, status_pengajuan FROM pengajuan_surat WHERE id = ?').get(id);
  assert.equal(row.current_step, 1, 'alur pengajuan lama tetap dimulai dari dosen pembimbing sesuai snapshot');

  const queue = await getDb()
    .prepare("SELECT u.full_name FROM jalur_persetujuan j JOIN users u ON u.id = j.employee_id WHERE j.pengajuan_id = ? AND j.status_persetujuan = 'MENUNGGU'")
    .all(id);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].full_name, 'Dr. Andi Pratama, M.Kom.', 'pejabat aktif mengikuti snapshot, bukan rute template terbaru');

  // Pulihkan rute semula untuk kebersihan data uji.
  const dosenPosition = positions.body.positions.find((p) => p.position_name === 'Dosen Pembimbing');
  await staf.put(`/api/staf/templates/${templateIdByKode('SIP')}`, {
    routes: [
      { position_id: dosenPosition.id, assigned_employee_id: null, is_required: 1 },
      { position_id: ketuaPosition.id, assigned_employee_id: null, is_required: 1 },
    ],
  });
});

test('37b. notifikasi dan audit log tercatat pada aksi penting', async () => {
  const id = await newSubmission();

  const staffNotifs = await staf.get('/api/notifications');
  assert.ok(
    staffNotifs.body.notifications.some((n) => n.related_submission_id === id && /menunggu verifikasi/i.test(n.title)),
    'staf menerima notifikasi pengajuan baru'
  );

  await staf.post(`/api/staf/pengajuan/${id}/verifikasi`, { decision: 'LANJUT' });

  const studentNotifs = await mahasiswa.get('/api/notifications');
  assert.ok(
    studentNotifs.body.notifications.some((n) => n.related_submission_id === id && /lolos verifikasi|progres/i.test(n.title)),
    'mahasiswa menerima notifikasi progres'
  );

  const dosenNotifs = await dosen.get('/api/notifications');
  assert.ok(
    dosenNotifs.body.notifications.some((n) => n.related_submission_id === id && /persetujuan/i.test(n.title)),
    'pejabat menerima notifikasi surat menunggu keputusannya'
  );

  const audit = getDb().prepare('SELECT action FROM audit_logs WHERE submission_id = ?').all(id).map((a) => a.action);
  assert.ok(audit.includes('PENGAJUAN_DIBUAT'));
  assert.ok(audit.includes('VERIFIKASI_STAF_DISETUJUI'));

  const notifRead = await mahasiswa.post(`/api/notifications/${studentNotifs.body.notifications[0].id}/read`);
  assert.equal(notifRead.status, 200);

  const other = await loginAs('mahasiswa2');
  const markForeign = await other.post(`/api/notifications/${studentNotifs.body.notifications[0].id}/read`);
  assert.equal(markForeign.status, 400, 'tidak dapat menandai notifikasi milik pengguna lain');
});
