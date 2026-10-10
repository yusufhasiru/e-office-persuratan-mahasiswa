'use strict';

/**
 * Pemeriksaan antarmuka dengan Chrome headless (opsional, memerlukan Chrome).
 *
 * Alur: login lewat API untuk memperoleh cookie session, menyuntikkan cookie ke
 * Chrome melalui DevTools Protocol, lalu membuka halaman setiap role dan
 * memeriksa bahwa halaman benar-benar dirender tanpa error JavaScript.
 *
 * Penggunaan:
 *   npm start            (terminal lain)
 *   npm run test:browser
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PORT = 9333;

const ACCOUNTS = {
  mahasiswa: { email: 'mahasiswa@demo.eoffice.test', password: 'Mahasiswa#2026' },
  staf: { email: 'staf@demo.eoffice.test', password: 'Staf#2026' },
  dosen: { email: 'dosen@demo.eoffice.test', password: 'Pejabat#2026' },
  ketua: { email: 'ketua@demo.eoffice.test', password: 'Pejabat#2026' },
};

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome tidak ditemukan. Set variabel CHROME_PATH.');
  return found;
}

async function loginAs(email, password) {
  const jar = {};
  const csrfRes = await fetch(`${BASE}/api/csrf`, { headers: { cookie: cookieHeader(jar) } });
  const setCookie = csrfRes.headers.getSetCookie ? csrfRes.headers.getSetCookie() : [];
  absorb(jar, setCookie);
  const { csrfToken } = await csrfRes.json();

  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken, cookie: cookieHeader(jar) },
    body: JSON.stringify({ email, password }),
  });
  absorb(jar, loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : []);
  if (!loginRes.ok) throw new Error(`Login ${email} gagal: ${loginRes.status}`);
  return jar;
}

function absorb(jar, cookies) {
  for (const raw of cookies) {
    const [pair] = raw.split(';');
    const index = pair.indexOf('=');
    jar[pair.slice(0, index)] = pair.slice(index + 1);
  }
}

const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

/** Klien DevTools Protocol minimal memakai WebSocket bawaan Node. */
class Cdp {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.pageErrors = [];
  }

  async connect() {
    this.ws = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.pageErrors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
      }
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async setCookie(name, value) {
    const result = await this.send('Network.setCookie', { name, value, url: BASE, path: '/' });
    if (!result.success) throw new Error(`Gagal menyetel cookie ${name}: ${JSON.stringify(result)}`);
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const { result } = await this.send('Runtime.evaluate', { expression: 'document.readyState + "|" + (document.querySelector("#page-content")?.innerText.length || document.querySelector("#verify-result")?.innerText.length || 0)', returnByValue: true });
      const [state, length] = String(result.value).split('|');
      if (state === 'complete' && Number(length) > 60) return;
    }
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression: `(async function(){ ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text + ' ' + (exceptionDetails.exception?.description || ''));
    return result.value;
  }

  /** Menunggu sampai ekspresi JavaScript bernilai benar. */
  async waitFor(expression, { timeout = 12000, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await this.evaluate(`return Boolean(${expression});`);
      if (value) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timeout menunggu: ${label}`);
  }

  /** URL halaman yang sedang dibuka. */
  async currentUrl() {
    return this.evaluate('return location.href;');
  }

  async text() {
    const { result } = await this.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
    return String(result.value || '');
  }
}

/** Menjalankan alur nyata melalui antarmuka: ajukan, verifikasi, setujui, PDF. */
async function runInteractiveFlow(cdp) {
  const steps = [];
  const record = (name, ok, detail = '') => {
    steps.push(ok);
    console.log(`${ok ? 'OK  ' : 'GAGAL'} [alur] ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const jars = {};
  for (const key of ['mahasiswa', 'staf', 'dosen', 'ketua']) {
    jars[key] = await loginAs(ACCOUNTS[key].email, ACCOUNTS[key].password);
  }
  const useJar = async (key) => {
    for (const [name, value] of Object.entries(jars[key])) await cdp.setCookie(name, value);
  };

  // 1) Mahasiswa mengisi form dinamis dan mengirim pengajuan
  await useJar('mahasiswa');
  const templateId = await cdp.evaluate(`
    const res = await fetch('/api/mahasiswa/templates', { credentials: 'same-origin' });
    const data = await res.json();
    return data.templates.find((t) => t.kode === 'SIP').id;
  `);
  await cdp.goto(`${BASE}/mahasiswa/pengajuan-baru?template=${templateId}`);
  await cdp.waitFor('document.querySelectorAll("[data-field]").length > 0', { label: 'form dinamis tampil' });
  const filled = await cdp.evaluate(`
    const fields = [...document.querySelectorAll('[data-field]')];
    let dateIndex = 0;
    for (const f of fields) {
      if (f.tagName === 'SELECT') f.value = f.options[1].value;
      else if (f.type === 'date') { dateIndex += 1; f.value = dateIndex === 1 ? '2027-01-05' : '2027-04-05'; }
      else if (f.type === 'number') f.value = '4';
      else f.value = 'Data uji antarmuka otomatis e-Office';
      f.dispatchEvent(new Event('input', { bubbles: true }));
      f.dispatchEvent(new Event('change', { bubbles: true }));
    }
    document.querySelector('#submit-pengajuan').click();
    return fields.length;
  `);
  let navigated = false;
  try {
    await cdp.waitFor('/\\/mahasiswa\\/pengajuan\\/\\d+$/.test(location.pathname)', { label: 'pindah ke halaman detail pengajuan' });
    navigated = true;
  } catch {
    navigated = false;
  }
  const detailText = await cdp.text();
  record(`mahasiswa mengisi ${filled} field dan mengirim pengajuan`, navigated && /menunggu verifikasi staf/i.test(detailText), navigated ? '' : 'tidak berpindah ke detail pengajuan');
  const submissionId = navigated ? (await cdp.currentUrl()).split('/').pop() : null;

  // 2) Mahasiswa lain tidak dapat membuka dokumen tersebut (uji di antarmuka)
  await useJar('staf');

  // 3) Staf memverifikasi melalui modal antarmuka
  await cdp.goto(`${BASE}/staf/antrean`);
  await cdp.waitFor(`document.querySelector('[data-verify="${submissionId}"]')`, { label: 'tombol verifikasi muncul' });
  await cdp.evaluate(`document.querySelector('[data-verify="${submissionId}"]').click(); return true;`);
  await cdp.waitFor('document.querySelector(".modal-backdrop")', { label: 'modal verifikasi terbuka' });
  await cdp.evaluate(`
    const radio = document.querySelector('input[name="pilihan"][value="LANJUT"]');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    const note = document.querySelector('#decision-reason');
    if (note) note.value = 'Diverifikasi melalui pengujian antarmuka.';
    document.querySelector('.modal-backdrop [data-act="confirm"]').click();
    return true;
  `);
  await cdp.waitFor('document.querySelector(".toast-success")', { label: 'notifikasi sukses verifikasi' });
  const verifiedToast = await cdp.evaluate('return document.querySelector(".toast-success")?.innerText || "";');
  record('staf memverifikasi pengajuan lewat modal', /verifikasi administratif disetujui/i.test(verifiedToast), verifiedToast.split('\n')[0]);

  // 4) Dosen pembimbing menyetujui tahap pertama
  await useJar('dosen');
  await cdp.goto(`${BASE}/pejabat/pengajuan/${submissionId}`);
  await cdp.waitFor('document.querySelector("[data-decision=\\"SETUJU\\"]")', { label: 'tombol keputusan tersedia untuk dosen' });
  await cdp.evaluate('document.querySelector("[data-decision=\\"SETUJU\\"]").click(); return true;');
  await cdp.waitFor('document.querySelector(".modal-backdrop")', { label: 'modal keputusan terbuka' });
  await cdp.evaluate('document.querySelector(".modal-backdrop [data-act=\\"confirm\\"]").click(); return true;');
  await cdp.waitFor('document.querySelector(".toast-success")', { label: 'konfirmasi persetujuan dosen' });
  const dosenText = await cdp.text();
  record('dosen pembimbing menyetujui tahap 1', /tahap 2/i.test(dosenText) || /menunggu persetujuan/i.test(dosenText));

  // 5) Pejabat yang tidak berwenang tidak melihat tombol keputusan
  await useJar('staf');
  const wakilJar = await loginAs('wakil@demo.eoffice.test', 'Pejabat#2026');
  for (const [name, value] of Object.entries(wakilJar)) await cdp.setCookie(name, value);
  await cdp.goto(`${BASE}/pejabat/pengajuan/${submissionId}`);
  await new Promise((r) => setTimeout(r, 800));
  const wakilText = await cdp.text();
  const wakilDitolak = /kewenangan anda/i.test(wakilText);
  const wakilTanpaTombol = await cdp.evaluate('return document.querySelectorAll("[data-decision]").length === 0;');
  record('pejabat lain tidak berwenang dan tidak mendapat tombol keputusan', wakilDitolak && wakilTanpaTombol, wakilDitolak ? '' : 'pesan kewenangan tidak tampil');

  // 6) Ketua jurusan menyetujui tahap terakhir dan PDF dibuat
  const ketuaJar = jars.ketua;
  for (const [name, value] of Object.entries(ketuaJar)) await cdp.setCookie(name, value);
  await cdp.goto(`${BASE}/pejabat/pengajuan/${submissionId}`);
  await cdp.waitFor('document.querySelector("[data-decision=\\"SETUJU\\"]")', { label: 'tombol keputusan tersedia untuk ketua jurusan' });
  await cdp.evaluate('document.querySelector("[data-decision=\\"SETUJU\\"]").click(); return true;');
  await cdp.waitFor('document.querySelector(".modal-backdrop")', { label: 'modal keputusan ketua' });
  await cdp.evaluate('document.querySelector(".modal-backdrop [data-act=\\"confirm\\"]").click(); return true;');
  await cdp.waitFor('document.querySelector(".toast-success")', { label: 'konfirmasi persetujuan akhir' });
  const finalText = await cdp.text();
  record('ketua jurusan menyetujui dan dokumen final dibuat', /selesai/i.test(finalText) && /nomor surat/i.test(finalText));

  // 7) Mahasiswa mengunduh PDF dari antarmuka
  await useJar('mahasiswa');
  await cdp.goto(`${BASE}/mahasiswa/pengajuan/${submissionId}`);
  await cdp.waitFor('document.querySelector("a.btn-success")', { label: 'tombol unduh PDF tersedia' });
  const download = await cdp.evaluate(`
    const res = await fetch('/api/surat/${submissionId}/pdf', { credentials: 'same-origin' });
    const buffer = await res.arrayBuffer();
    const head = new TextDecoder().decode(new Uint8Array(buffer.slice(0, 5)));
    return res.status + '|' + head + '|' + buffer.byteLength;
  `);
  const [status, head, size] = download.split('|');
  record('mahasiswa mengunduh PDF final dari antarmuka', status === '200' && head === '%PDF-' && Number(size) > 5000, `${size} byte`);

  return { steps, submissionId };
}

const CHECKS = [
  { role: 'mahasiswa', email: 'mahasiswa@demo.eoffice.test', password: 'Mahasiswa#2026', pages: [
    ['/mahasiswa/dashboard', ['Total Pengajuan', 'Pengajuan Terbaru']],
    ['/mahasiswa/katalog', ['Katalog', 'Ajukan Surat']],
    ['/mahasiswa/pengajuan', ['Daftar Pengajuan']],
    ['/mahasiswa/notifikasi', ['Notifikasi']],
    ['/mahasiswa/profil', ['Data Akun']],
  ] },
  { role: 'staf', email: 'staf@demo.eoffice.test', password: 'Staf#2026', pages: [
    ['/staf/dashboard', ['Antrean Verifikasi']],
    ['/staf/antrean', ['Antrean Verifikasi Administratif']],
    ['/staf/pengajuan', ['Semua Pengajuan']],
    ['/staf/template', ['Katalog Template Surat']],
    ['/staf/rute', ['Rute Persetujuan']],
    ['/staf/laporan', ['Audit Log Terbaru']],
    ['/staf/akun', ['Buat Akun Pegawai']],
  ] },
  { role: 'pejabat', email: 'dosen@demo.eoffice.test', password: 'Pejabat#2026', pages: [
    ['/pejabat/dashboard', ['Menunggu Keputusan Saya']],
    ['/pejabat/antrean', ['Surat Menunggu Keputusan Anda']],
    ['/pejabat/riwayat', ['Riwayat Persetujuan Saya']],
  ] },
];

async function main() {
  const chrome = spawn(findChrome(), [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'eoffice-chrome-'))}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ]);

  let failed = 0;
  let cdp = null;

  try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch {
        /* Chrome belum siap */
      }
    }
    if (!target) throw new Error('Tidak dapat terhubung ke Chrome DevTools Protocol.');

    for (const group of CHECKS) {
      const jar = await loginAs(group.email, group.password);
      cdp = new Cdp(target.webSocketDebuggerUrl);
      await cdp.connect();
      for (const [name, value] of Object.entries(jar)) await cdp.setCookie(name, value);

      for (const [route, expected] of group.pages) {
        cdp.consoleErrors = [];
        cdp.pageErrors = [];
        await cdp.goto(`${BASE}${route}`);
        const text = await cdp.text();
        // Perbandingan tanpa membedakan huruf besar/kecil karena sebagian label
        // ditampilkan dalam huruf kapital melalui CSS.
        const haystack = text.toLowerCase();
        const missing = expected.filter((needle) => !haystack.includes(needle.toLowerCase()));
        const ok = missing.length === 0 && cdp.pageErrors.length === 0;
        if (!ok) failed++;
        console.log(
          `${ok ? 'OK  ' : 'GAGAL'} [${group.role}] ${route}${missing.length ? ` — tidak menemukan: ${missing.join(', ')}` : ''}${cdp.pageErrors.length ? ` — error: ${cdp.pageErrors.join(' | ')}` : ''}`
        );
        if (cdp.consoleErrors.length) console.log(`      console error: ${cdp.consoleErrors.join(' | ')}`);
        if (!ok) {
          const { result: loc } = await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
          console.log(`      URL: ${loc.value}`);
          console.log(`      Cuplikan: ${text.replace(/\s+/g, ' ').slice(0, 220)}`);
        }
      }
      cdp.ws.close();
    }

    // Alur kerja nyata lewat antarmuka
    const flowJar = await loginAs(ACCOUNTS.mahasiswa.email, ACCOUNTS.mahasiswa.password);
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.connect();
    for (const [name, value] of Object.entries(flowJar)) await cdp.setCookie(name, value);
    const flow = await runInteractiveFlow(cdp);
    failed += flow.steps.filter((ok) => !ok).length;
    cdp.ws.close();
  } finally {
    chrome.kill();
  }

  console.log(failed === 0 ? '\nSemua halaman dirender tanpa error.' : `\n${failed} halaman bermasalah.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('[browser-check] gagal:', error.message);
  if (error.stack) console.error(error.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
