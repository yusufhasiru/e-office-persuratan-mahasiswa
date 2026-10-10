'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootstrap, makeAgent, loginAs, ACCOUNTS, closeDb } = require('./helpers');

before(async () => {
  await bootstrap();
});

after(() => closeDb());

test('1. login dengan akun valid berhasil dan tidak mengirim hash password', async () => {
  const client = await makeAgent();
  const res = await client.post('/api/auth/login', ACCOUNTS.mahasiswa);

  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, 'MAHASISWA');
  assert.equal(res.body.user.email, ACCOUNTS.mahasiswa.email);
  assert.ok(res.body.csrfToken, 'token CSRF baru diberikan setelah login');
  assert.equal(res.body.user.password_hash, undefined, 'hash password tidak boleh terkirim');

  const me = await client.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.authenticated, true);
  assert.equal(me.body.user.password_hash, undefined);
});

test('2. login dengan password salah ditolak tanpa membocorkan penyebab', async () => {
  const client = await makeAgent();
  const res = await client.post('/api/auth/login', { email: ACCOUNTS.mahasiswa.email, password: 'password-salah' });

  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'INVALID_CREDENTIALS');
});

test('2b. login dengan email tidak terdaftar memberi pesan error yang sama', async () => {
  const client = await makeAgent();
  const res = await client.post('/api/auth/login', { email: 'tidak-ada@demo.eoffice.test', password: 'apa-saja' });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'INVALID_CREDENTIALS');
});

test('3. logout menghapus session', async () => {
  const client = await makeAgent(ACCOUNTS.mahasiswa.email, ACCOUNTS.mahasiswa.password);
  const before = await client.get('/api/auth/me');
  assert.equal(before.body.authenticated, true);

  const out = await client.post('/api/auth/logout', {});
  assert.equal(out.status, 200);

  const after = await client.get('/api/auth/me');
  assert.equal(after.body.authenticated, false);
});

test('4. registrasi mahasiswa baru berhasil dan dapat login', async () => {
  const client = await makeAgent();
  const email = `mhs-${Date.now()}@demo.eoffice.test`;
  const res = await client.post('/api/auth/register', {
    fullName: 'Mahasiswa Baru',
    nim: `2026${String(Date.now()).slice(-6)}`,
    email,
    password: 'Rahasia#2026',
    studyProgram: 'Teknik Informatika',
  });

  assert.equal(res.status, 201);

  const login = await client.post('/api/auth/login', { email, password: 'Rahasia#2026' });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'MAHASISWA', 'registrasi publik hanya menghasilkan role MAHASISWA');
});

test('4b. registrasi menolak email/NIM duplikat dan password lemah', async () => {
  const client = await makeAgent();
  const dup = await client.post('/api/auth/register', {
    fullName: 'Duplikat',
    nim: '2021999999',
    email: ACCOUNTS.mahasiswa.email,
    password: 'Rahasia#2026',
    studyProgram: 'Teknik Informatika',
  });
  assert.equal(dup.status, 409);

  const weak = await client.post('/api/auth/register', {
    fullName: 'Password Lemah',
    nim: '2021888888',
    email: `lemah-${Date.now()}@demo.eoffice.test`,
    password: '1234567',
    studyProgram: 'Teknik Informatika',
  });
  assert.equal(weak.status, 400);
});

test('5. mahasiswa tidak dapat mengakses endpoint staf dan pejabat', async () => {
  const mahasiswa = await loginAs('mahasiswa');
  const stafApi = await mahasiswa.get('/api/staf/dashboard');
  const pejabatApi = await mahasiswa.get('/api/pejabat/antrean');

  assert.equal(stafApi.status, 403);
  assert.equal(pejabatApi.status, 403);

  const page = await mahasiswa.get('/staf/dashboard');
  assert.equal(page.status, 403, 'halaman staf juga ditolak di backend');
});

test('5b. staf tidak dapat memakai endpoint pejabat dan sebaliknya', async () => {
  const staf = await loginAs('staf');
  const pejabat = await loginAs('dosen');

  assert.equal((await staf.get('/api/pejabat/antrean')).status, 403);
  assert.equal((await pejabat.get('/api/staf/antrean')).status, 403);
  assert.equal((await pejabat.get('/api/mahasiswa/dashboard')).status, 403);
});

test('5c. request tanpa login ditolak pada endpoint terproteksi', async () => {
  const client = await makeAgent();
  const res = await client.get('/api/mahasiswa/pengajuan');
  assert.equal(res.status, 401);

  const page = await client.agent.get('/mahasiswa/dashboard');
  assert.equal(page.status, 302, 'halaman terproteksi mengarahkan ke login');
  assert.match(page.headers.location, /^\/login/);
});

test('6. akun nonaktif tidak dapat login', async () => {
  const client = await makeAgent();
  const res = await client.post('/api/auth/login', ACCOUNTS.nonaktif);
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'ACCOUNT_INACTIVE');
});

test('6b. akun yang dinonaktifkan kehilangan session aktifnya', async () => {
  const client = await makeAgent(ACCOUNTS.mahasiswa2.email, ACCOUNTS.mahasiswa2.password);
  assert.equal((await client.get('/api/auth/me')).body.authenticated, true);

  const staf = await loginAs('staf');
  const users = await staf.get('/api/admin/users?role=MAHASISWA');
  const target = users.body.users.find((u) => u.email === ACCOUNTS.mahasiswa2.email);
  const patch = await staf.patch(`/api/admin/users/${target.id}/status`, { is_active: false });
  assert.equal(patch.status, 200);

  const after = await client.get('/api/auth/me');
  assert.equal(after.body.authenticated, false, 'session akun nonaktif langsung tidak berlaku');

  await staf.patch(`/api/admin/users/${target.id}/status`, { is_active: true });
});

test('7. proteksi CSRF menolak POST tanpa token yang sah', async () => {
  const client = await makeAgent(ACCOUNTS.mahasiswa.email, ACCOUNTS.mahasiswa.password);
  const res = await client.agent
    .post('/api/mahasiswa/pengajuan')
    .send({ template_id: 1, payload: {} });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'CSRF_INVALID');
});
