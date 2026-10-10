# Sistem Informasi Layanan Persuratan Mahasiswa (e-Office)

Aplikasi web **full-stack** untuk mendigitalisasi pengajuan dan pengesahan surat mahasiswa di
tingkat jurusan perguruan tinggi. Sistem menggantikan alur manual (surat dibawa ke staf, lalu ke
dosen pembimbing, lalu ke ketua jurusan) dengan **alur persetujuan berjenjang berurutan
(_multi-level sequential approval_)** yang rutenya dikonfigurasi dari database, dilengkapi
pembuatan **PDF final ber-QR Code**, **verifikasi publik dokumen**, **audit log**, dan
**notifikasi internal**.

Bukan mockup dan bukan dashboard statis: seluruh proses bisnis divalidasi backend, data tersimpan
persisten pada SQLite, dan setiap keputusan persetujuan diproses dalam transaksi database.

---

## Daftar Isi

1. [Fitur Utama](#fitur-utama)
2. [Teknologi](#teknologi)
3. [Struktur Folder](#struktur-folder)
4. [Persyaratan Instalasi](#persyaratan-instalasi)
5. [Instalasi](#instalasi)
6. [Konfigurasi Environment](#konfigurasi-environment)
7. [Migrasi Database](#migrasi-database)
8. [Seeder dan Data Dummy](#seeder-dan-data-dummy)
9. [Menjalankan Aplikasi](#menjalankan-aplikasi)
10. [Kredensial Demo (Development)](#kredensial-demo-development)
11. [Alur Persetujuan](#alur-persetujuan)
12. [Role dan Hak Akses](#role-dan-hak-akses)
13. [Skema Form Dinamis](#skema-form-dinamis)
14. [Status Pengajuan](#status-pengajuan)
15. [Revisi](#revisi)
16. [Penolakan dan Kedaluwarsa](#penolakan-dan-kedaluwarsa)
17. [PDF Final, QR Code, dan Verifikasi Publik](#pdf-final-qr-code-dan-verifikasi-publik)
18. [Struktur Database](#struktur-database)
19. [Keamanan](#keamanan)
20. [Pengujian](#pengujian)
21. [Endpoint API](#endpoint-api)
22. [Batasan yang Belum Diimplementasikan](#batasan-yang-belum-diimplementasikan)

---

## Fitur Utama

**Mahasiswa**
- Registrasi akun mahasiswa (hanya role mahasiswa yang dapat dibuat via registrasi publik).
- Katalog template surat beserta deskripsi dan persyaratan.
- Form pengajuan **dinamis** yang dibangun dari skema template di database.
- Daftar dan detail pengajuan sendiri, lengkap dengan riwayat status.
- Memperbaiki dan mengirim ulang pengajuan yang meminta revisi.
- Mengunduh PDF final setelah surat selesai.
- Notifikasi internal dan pembaruan profil.

**Staf Administrasi**
- Dashboard antrean verifikasi, pengajuan perlu revisi, menunggu pejabat, dan statistik.
- Verifikasi administratif: meneruskan surat atau meminta revisi (alasan wajib).
- Pemantauan seluruh pengajuan, riwayat proses, dan audit log.
- Pengelolaan katalog template surat beserta skema form dinamis.
- Pengelolaan rute persetujuan per jenis surat.
- Pengelolaan akun pegawai (staf/pejabat) — akun pegawai tidak dapat dibuat dari registrasi publik.
- Laporan administratif dan pembuatan ulang (retry) dokumen final.

**Pejabat Pemaraf** (Dosen Pembimbing, Ketua Jurusan, Wakil Dekan)
- Hanya melihat surat yang menunggu keputusan pada tahap kewenangannya.
- Menyetujui, meminta revisi, atau menolak permanen (alasan wajib untuk revisi/penolakan).
- Riwayat keputusan yang pernah diberikan (histori permanen).

**Sistem**
- Alur persetujuan berjenjang dengan **snapshot rute** per pengajuan.
- Penomoran surat otomatis dan unik (`001/E-Office/SIP/2026`).
- PDF final dengan kop institusi, data pengajuan, daftar pejabat penyetuju, QR Code, dan footer verifikasi.
- Halaman verifikasi publik `/verify/{token}` dengan pemeriksaan checksum berkas.
- Notifikasi internal, audit log, dan peristiwa dokumen.
- Pengecekan kedaluwarsa revisi otomatis (job berkala) dan manual.
- Rate limiting, proteksi CSRF, session berbasis SQLite, Helmet security headers.

---

## Teknologi

| Bagian | Teknologi |
| --- | --- |
| Runtime | Node.js >= 20 (diuji pada Node.js 24.21) |
| Backend | Express 4 |
| Database | SQLite melalui `better-sqlite3` (foreign key, WAL, transaksi) |
| Autentikasi | `express-session` + store session SQLite + `bcryptjs` |
| PDF | `pdfkit` |
| QR Code | `qrcode` |
| Keamanan HTTP | `helmet`, `express-rate-limit`, proteksi CSRF berbasis token per session |
| Konfigurasi | `dotenv` |
| Frontend | HTML5, CSS3, JavaScript vanilla (tanpa framework) |
| Pengujian | `node:test` + `supertest` (+ Chrome DevTools Protocol untuk uji antarmuka) |
| Version control | Git |

SQLite adalah satu-satunya database utama. Tidak ada MySQL, dan tidak ada file JSON sebagai
database. File JSON hanya dipakai untuk konfigurasi/skema form di dalam kolom database.

---

## Struktur Folder

```
e-office/
├── public/                      # Aset statis (disajikan langsung)
│   ├── css/styles.css           # Design system (navy #152352, blue #2F6FED)
│   └── js/
│       ├── app.js               # Runtime bersama: API client + CSRF, layout, toast, modal
│       ├── auth.js              # Halaman login & registrasi
│       ├── mahasiswa.js         # Halaman mahasiswa
│       ├── staf.js              # Halaman staf administrasi
│       ├── pejabat.js           # Halaman pejabat pemaraf
│       └── verify.js            # Halaman verifikasi publik
├── src/
│   ├── config/
│   │   ├── database.js          # Koneksi SQLite + helper transaksi
│   │   └── env.js               # Pembacaan & validasi environment
│   ├── middleware/
│   │   ├── auth.js              # Session → req.user, pemeriksaan role
│   │   ├── authorization.js     # Pemuatan pengajuan + pembatasan kepemilikan
│   │   ├── csrf.js              # Proteksi CSRF (double submit token per session)
│   │   └── validation.js        # Validasi body request (whitelist)
│   ├── routes/
│   │   ├── auth.routes.js       # Login, registrasi, logout, CSRF, profil
│   │   ├── mahasiswa.routes.js  # Katalog, pengajuan, revisi, pembatalan, dashboard
│   │   ├── staf.routes.js       # Antrean, verifikasi, template, rute, laporan
│   │   ├── pejabat.routes.js    # Antrean kewenangan, keputusan, riwayat
│   │   ├── admin.routes.js      # Pengelolaan akun pegawai
│   │   ├── surat.routes.js      # Detail pengajuan + unduhan PDF terproteksi
│   │   └── verification.routes.js # API verifikasi publik
│   ├── services/
│   │   ├── auth.service.js      # Kredensial, hashing, registrasi
│   │   ├── surat.service.js     # Siklus hidup pengajuan, snapshot rute, revisi
│   │   ├── approval.service.js  # Mesin persetujuan berjenjang + finalisasi
│   │   ├── pdf.service.js       # Generator PDF + QR Code + penyimpanan privat
│   │   ├── verification.service.js # Verifikasi token & integritas dokumen
│   │   └── notification.service.js # Notifikasi internal
│   ├── repositories/            # Akses data (prepared statement)
│   │   ├── user.repo.js
│   │   ├── template.repo.js
│   │   ├── pengajuan.repo.js
│   │   ├── approval.repo.js
│   │   ├── notification.repo.js
│   │   ├── audit.repo.js
│   │   └── session.store.js     # Store express-session berbasis SQLite
│   ├── validators/
│   │   ├── form-validator.js    # Validasi form dinamis per skema template
│   │   └── template-validator.js# Validasi skema form & rute approval
│   ├── utils/                   # Tanggal Indonesia, token/checksum, error HTTP
│   ├── app.js                   # Perakitan Express (security, session, route, halaman)
│   └── server.js                # Entry point + job berkala
├── views/                       # Halaman HTML (dilindungi per role)
│   ├── auth/                    # login, register, akses-ditolak, sesi-berakhir
│   ├── mahasiswa/  staf/  pejabat/
│   ├── partials/layout.html     # Kerangka aplikasi (sidebar + topbar)
│   └── public/                  # verify.html, 404.html
├── database/
│   ├── migrations/              # 001_init.sql + runner (npm run migrate)
│   ├── seeders/                 # seed.js (data awal) + demo-workflows.js
│   └── .gitkeep
├── storage/                     # Dokumen PDF privat (TIDAK disajikan statis)
├── tests/                       # 62 pengujian otomatis (node:test + supertest)
├── tools/browser-check.js       # Uji antarmuka via Chrome headless (opsional)
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

---

## Persyaratan Instalasi

- Node.js **20 atau lebih baru** (disarankan 22/24) dan npm.
- Build tools untuk `better-sqlite3`: pada umumnya biner siap pakai tersedia. Bila kompilasi
  diperlukan: Linux `build-essential` + `python3`; macOS `xcode-select --install`.
- Windows + Node 24: `better-sqlite3` menyediakan prebuild; bila gagal, jalankan lewat WSL.
- Opsional untuk uji antarmuka: Google Chrome/Chromium terpasang.

---

## Instalasi

```bash
# 1. Masuk ke folder project
cd e-office

# 2. Pasang dependency
npm install

# 3. Siapkan environment
cp .env.example .env
#    Lalu isi SESSION_SECRET dengan nilai acak:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# 4. Jalankan migrasi + seeder
npm run setup        # setara: npm run migrate && npm run seed
```

---

## Konfigurasi Environment

Seluruh variabel dibaca dari `.env` (lihat `.env.example`):

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `PORT` | `3000` | Port server |
| `NODE_ENV` | `development` | `production` mengaktifkan cookie `secure` dan batas rate limit ketat |
| `BASE_URL` | `http://localhost:3000` | Basis URL untuk tautan verifikasi pada QR Code |
| `SESSION_SECRET` | (wajib di produksi) | Rahasia penandatanganan cookie session. Produksi menolak start bila kosong |
| `SESSION_NAME` | `eoffice.sid` | Nama cookie session |
| `SESSION_TTL_HOURS` | `8` | Umur session (jam) |
| `TRUST_PROXY` | `false` | Set `true` bila berada di belakang reverse proxy |
| `DATABASE_PATH` | `database/e-office.sqlite` | Lokasi file SQLite |
| `STORAGE_PATH` | `storage/documents` | Folder privat penyimpanan PDF |
| `REVISION_DEADLINE_DAYS` | `3` | Batas waktu revisi dalam **hari kalender** |
| `LOGIN_RATE_LIMIT_MAX` | 20 (produksi) / 120 (dev) | Maksimum kegagalan login per IP per jendela waktu |
| `LOGIN_RATE_LIMIT_WINDOW_MINUTES` | `10` | Panjang jendela rate limit login |
| `SEED_DEMO_PASSWORDS` | `true` (non-produksi) | Menampilkan kredensial demo saat seeding |
| `INSTITUTION_NAME`, `FACULTY_NAME`, `DEPARTMENT_NAME`, `INSTITUTION_ADDRESS` | contoh | Identitas pada kop surat PDF |

Tidak ada nilai rahasia produksi pada `.env.example`. File `.env` dan database SQLite lokal sudah
masuk `.gitignore`.

---

## Migrasi Database

```bash
npm run migrate
```

Runner membaca seluruh `database/migrations/*.sql` secara berurutan dan mencatatnya pada tabel
`schema_migrations`, sehingga aman dijalankan berulang kali (idempoten).

---

## Seeder dan Data Dummy

```bash
npm run seed
```

Seeder bersifat idempoten: akun/template yang sudah ada **tidak ditimpa**, hanya data yang belum
ada yang dibuat. Data yang dihasilkan:

- Jabatan: Staf Administrasi, Dosen Pembimbing, Ketua Jurusan, Wakil Dekan.
- Akun: 2 mahasiswa, 1 staf administrasi, 3 pejabat aktif, 1 pejabat **nonaktif** (untuk menguji
  penolakan login akun nonaktif).
- 5 template surat: Surat Izin Penelitian, Surat Keterangan Aktif Kuliah, Surat Pengantar PKL,
  Surat Permohonan Data, Surat Pengantar Tugas Akhir.
- Rute persetujuan: Surat Izin Penelitian memakai 2 tahap (Dosen Pembimbing → Ketua Jurusan);
  template lain memakai rute yang berbeda (1 atau 2 tahap).

Pada `NODE_ENV=production` seeder menolak berjalan kecuali dipaksa dengan `npm run seed -- --force`.

### Contoh pengajuan untuk menelusuri antarmuka (opsional)

```bash
npm start                                       # terminal 1
node database/seeders/demo-workflows.js         # terminal 2
```

Skrip ini membuat 6 contoh pengajuan melalui API nyata pada berbagai status: menunggu verifikasi
staf, perlu revisi, menunggu tahap 1, menunggu tahap 2, selesai (dengan PDF), dan ditolak.

---

## Menjalankan Aplikasi

```bash
npm start          # mode produksi-ish
npm run dev        # mode pengembangan dengan --watch
```

Akses `http://localhost:3000`. Root akan mengarahkan ke dashboard sesuai role pengguna.

---

## Kredensial Demo (Development)

Dibuat oleh `npm run seed`. **Hanya untuk lingkungan development** — jangan dipakai di produksi.

| Role | Login | Password |
| --- | --- | --- |
| Mahasiswa | `mahasiswa@demo.eoffice.test` | `Mahasiswa#2026` |
| Mahasiswa (pembanding) | `mahasiswa2@demo.eoffice.test` | `Mahasiswa#2026` |
| Staf Administrasi | `staf@demo.eoffice.test` | `Staf#2026` |
| Dosen Pembimbing | `dosen@demo.eoffice.test` | `Pejabat#2026` |
| Ketua Jurusan | `ketua@demo.eoffice.test` | `Pejabat#2026` |
| Wakil Dekan | `wakil@demo.eoffice.test` | `Pejabat#2026` |
| Pejabat nonaktif (uji tolak login) | `nonaktif@demo.eoffice.test` | `Pejabat#2026` |

Login juga dapat memakai NIM, mis. `2021010001`.

---

## Alur Persetujuan

Alur bersifat **berurutan dan dinamis** (diambil dari tabel `rute_approval_template`):

```
Mahasiswa mengajukan
        │
        ▼
MENUNGGU_VERIFIKASI_STAF ──(minta revisi)──► PERLU_REVISI ──► dikirim ulang ──► kembali ke verifikasi
        │
        │ disetujui (staf)
        ▼
MENUNGGU_PERSETUJUAN (tahap 1 = Dosen Pembimbing)
        │ disetujui
        ▼
MENUNGGU_PERSETUJUAN (tahap 2 = Ketua Jurusan)
        │ disetujui (tahap terakhir)
        ▼
finalisasi: nomor surat + token QR + PDF final
        │
        ▼
      SELESAI ──► mahasiswa mengunduh PDF ──► QR diverifikasi publik di /verify/{token}
```

Aturan yang ditegakkan backend:

1. Tahap hanya dapat diproses bila status pengajuan `MENUNGGU_PERSETUJUAN`, tahap tersebut aktif,
   dan **pejabat yang login adalah pejabat yang ditugaskan pada tahap itu**.
2. Pejabat berikutnya tidak dapat melihat/memproses surat sebelum tahap sebelumnya disetujui
   (antrean dibangun dari baris `jalur_persetujuan` yang memang menunggu pegawai tersebut).
3. Satu tahap tidak dapat diputuskan dua kali. Keputusan memakai `UPDATE ... WHERE id = ? AND
   status_persetujuan = 'MENUNGGU'`; bila tidak ada baris yang berubah, request ditolak `409`.
4. Seluruh keputusan berjalan di dalam transaksi database; kegagalan (mis. pejabat tidak aktif)
   akan me-rollback keputusan, riwayat, audit log, dan notifikasi sekaligus.
5. **Snapshot rute** dibuat saat pengajuan dibuat (`approval_routes_snapshot`). Perubahan rute
   template hanya berlaku untuk pengajuan baru; pengajuan yang sedang berjalan tidak terpengaruh.
6. Penugasan pejabat divalidasi backend: tahap dapat menunjuk pegawai tertentu (`assigned_employee_id`)
   atau sistem memilih pejabat aktif pertama yang memegang jabatan tersebut, dan pilihan itu
   disimpan pada snapshot sehingga tidak dapat dimanipulasi dari request.
7. Kegagalan membuat PDF **tidak** membuat status menjadi `SELESAI`. Status tetap
   `MENUNGGU_PERSETUJUAN` dengan `pdf_status = FAILED`, dan staf dapat menekan **Buat Ulang PDF**
   (`POST /api/staf/pengajuan/:id/retry-pdf`) tanpa mengulang persetujuan.

---

## Role dan Hak Akses

| Kemampuan | Mahasiswa | Staf | Pejabat |
| --- | :-: | :-: | :-: |
| Mengajukan surat | ✅ | ❌ | ❌ |
| Melihat pengajuan milik sendiri | ✅ | – | – |
| Melihat seluruh pengajuan | ❌ | ✅ | ❌ |
| Melihat pengajuan pada kewenangannya | ❌ | ✅ | ✅ |
| Verifikasi administratif | ❌ | ✅ | ❌ |
| Keputusan persetujuan | ❌ | ❌ | ✅ |
| Mengunduh PDF | hanya miliknya | ✅ | ❌ |
| Mengelola template & rute | ❌ | ✅ | ❌ |
| Mengelola akun pegawai | ❌ | ✅ | ❌ |
| Verifikasi publik (tanpa login) | ✅ (halaman `/verify/{token}`) | ✅ | ✅ |

Hak akses diperiksa di backend (`src/middleware/auth.js`, `src/middleware/authorization.js`,
`src/app.js` untuk halaman). Menyembunyikan tombol di antarmuka bukan mekanisme keamanan.

---

## Skema Form Dinamis

Setiap template menyimpan `form_schema_json`: array field dengan kunci `name`, `label`, `type`,
`placeholder`, `required`, `minLength`, `maxLength`, `min`, `max`, `pattern`, `options`, `order`.
Tipe yang didukung: `text`, `textarea`, `date`, `email`, `tel`, `number`, `select`.

Contoh (Surat Izin Penelitian):

```json
[
  { "name": "judul_penelitian", "label": "Judul Penelitian", "type": "text", "required": true, "minLength": 5, "order": 1 },
  { "name": "nama_instansi", "label": "Nama Instansi Tujuan", "type": "text", "required": true, "order": 2 },
  { "name": "alamat_instansi", "label": "Alamat Instansi", "type": "textarea", "required": true, "minLength": 10, "order": 3 },
  { "name": "tujuan_penelitian", "label": "Tujuan Penelitian", "type": "textarea", "required": true, "order": 4 },
  { "name": "tanggal_mulai", "label": "Tanggal Mulai Penelitian", "type": "date", "required": true, "order": 5 },
  { "name": "tanggal_selesai", "label": "Tanggal Selesai Penelitian", "type": "date", "required": true, "order": 6 },
  { "name": "nama_dosen_pembimbing", "label": "Nama Dosen Pembimbing", "type": "text", "required": true, "order": 7 },
  { "name": "keterangan_tambahan", "label": "Keterangan Tambahan", "type": "textarea", "required": false, "order": 8 }
]
```

Data isian disimpan sebagai JSON pada kolom `payload_isian_json`, tetapi **selalu divalidasi
terhadap skema di server**. Field di luar skema diabaikan. Konfigurasi JavaScript/HTML arbitrer
tidak pernah diterima: skema dibersihkan menjadi whitelist kunci (`src/validators/template-validator.js`).

---

## Status Pengajuan

| Status | Arti |
| --- | --- |
| `DRAFT` | Disiapkan (reserved; alur normal langsung mengirim) |
| `MENUNGGU_VERIFIKASI_STAF` | Menunggu verifikasi administratif |
| `MENUNGGU_PERSETUJUAN` | Menunggu keputusan pejabat pada tahap aktif |
| `PERLU_REVISI` | Dikembalikan ke mahasiswa dengan catatan revisi |
| `DITOLAK` | Ditolak permanen oleh pejabat |
| `KEDALUWARSA` | Melewati batas waktu revisi |
| `SELESAI` | Seluruh tahap wajib disetujui dan PDF final berhasil dibuat |
| `DIBATALKAN` | Dibatalkan oleh mahasiswa |

Tahap aktif disimpan terpisah pada `pengajuan_surat.current_step` + baris `jalur_persetujuan`
berstatus `MENUNGGU`, sehingga sistem selalu tahu pejabat yang harus memproses.

---

## Revisi

1. Staf atau pejabat meminta revisi **wajib disertai alasan** (minimal 5 karakter).
2. Permintaan dicatat pada `submission_revisions` bersama identitas peminta, peran, tahap, dan
   waktu, plus snapshot data versi lama.
3. Status menjadi `PERLU_REVISI` dengan `deadline_revisi` = sekarang + `REVISION_DEADLINE_DAYS`
   **hari kalender**.
4. Selama revisi, semua tahap yang menunggu dibatalkan (`DIBATALKAN`) sehingga tidak ada tahap
   menggantung yang dapat diproses.
5. Mahasiswa hanya dapat mengedit pengajuan **miliknya yang berstatus `PERLU_REVISI`**.
6. Setelah dikirim ulang: validasi dijalankan ulang, nomor versi bertambah, ronde persetujuan
   baru dibuka, dan status kembali `MENUNGGU_VERIFIKASI_STAF`.
7. Riwayat tetap utuh: keputusan ronde lama tidak pernah dihapus, hanya bertambah baris baru
   (`round_number` = nomor versi). Untuk versi pertama ini, **seluruh persetujuan pejabat wajib
   dilakukan kembali** setelah revisi, sementara keputusan lama tetap tersimpan sebagai histori.

---

## Penolakan dan Kedaluwarsa

- **Penolakan**: alasan wajib, status akhir `DITOLAK`, tidak dapat dilanjutkan secara normal,
  alasan terlihat oleh mahasiswa, dan tercatat pada audit log (tidak pernah dihapus).
- **Kedaluwarsa**: berlaku bila pengajuan menunggu revisi melewati batas waktu. Batas waktu
  dihitung dalam **hari kalender** (`REVISION_DEADLINE_DAYS`, default 3). Pengecekan berjalan:
  - otomatis setiap jam oleh job pada `src/server.js`,
  - saat mahasiswa mencoba mengirim ulang setelah lewat batas,
  - manual oleh staf melalui `POST /api/staf/expiry-check`.
  Pengecekan bersifat idempoten dan tidak mengubah pengajuan yang sudah dikirim ulang tepat waktu
  atau sudah berada pada status akhir.

---

## PDF Final, QR Code, dan Verifikasi Publik

**Isi PDF final**
- Kop: nama institusi, fakultas, jurusan, alamat (dapat dikonfigurasi via environment).
- Nomor surat unik dari backend, mis. `001/E-Office/SIP/2026` (counter per template per tahun,
  dengan constraint `UNIQUE` sebagai pengaman terakhir).
- Tanggal penerbitan berformat Indonesia (`11 Oktober 2026`).
- Judul surat, identitas mahasiswa, dan seluruh data pengajuan.
- Daftar pejabat yang menyetujui beserta jabatan dan waktu persetujuan (diambil dari catatan
  persetujuan sah di database, bukan data masukan pengguna).
- QR Code, URL verifikasi, dan identitas dokumen (SHA-256 dari konten dokumen).
- Footer yang menjelaskan verifikasi digital.

Tidak ada gambar tanda tangan palsu, dan QR Code **bukan** sertifikat tanda tangan elektronik
tersertifikasi — hal ini juga dinyatakan pada footer dokumen dan halaman verifikasi.

**Verifikasi via QR Code**
1. Pindai QR Code pada PDF (atau buka tautan `BASE_URL/verify/{token}`).
2. Halaman publik memanggil server, mencari hash token, dan memeriksa status **terkini** di database:
   - `SELESAI` → dokumen sah, menampilkan nomor surat, jenis surat, tanggal terbit, nama/NIM/prodi,
     daftar pejabat penyetuju, dan hasil pemeriksaan integritas berkas.
   - `DITOLAK`, `DIBATALKAN`, `KEDALUWARSA`, atau masih diproses → dokumen **tidak** dinyatakan sah.
3. Checksum berkas PDF yang sedang tersimpan dibandingkan dengan `pdf_checksum` di database;
   perubahan berkas akan terdeteksi (`checksum tidak cocok`).

Token adalah 32 byte acak (64 karakter heksadesimal) dan **disimpan dalam bentuk hash** di
database. Halaman verifikasi tidak menampilkan password, session, data sensitif pengajuan, catatan
revisi, atau informasi internal.

**Akses berkas PDF**
- PDF disimpan di `storage/documents/...` yang **tidak** disajikan sebagai direktori statis.
- Unduhan hanya melalui `GET /api/surat/:id/pdf` dengan pemeriksaan: login → kepemilikan/kewenangan
  → status `SELESAI` → keberadaan berkas.

---

## Struktur Database

Semua timestamp disimpan sebagai string ISO-8601 UTC. Foreign key aktif (`PRAGMA foreign_keys = ON`),
mode WAL, dan `busy_timeout`.

| Tabel | Isi |
| --- | --- |
| `users` | Akun (nim, employee_id, email, password_hash, role, study_program, position_id, is_active). Constraint: NIM hanya untuk mahasiswa, employee_id hanya untuk staf/pejabat; email & NIM/employee_id unik |
| `positions` | Jabatan (Dosen Pembimbing, Ketua Jurusan, Wakil Dekan, Staf Administrasi) |
| `sessions` | Store session express-session (sid, expires, data) |
| `template_surat` | Katalog surat: kode, nama, deskripsi, persyaratan, `form_schema_json`, `is_active` |
| `rute_approval_template` | Rute persetujuan per template: `urutan_ke`, `position_id`, `assigned_employee_id`, `is_required`. `UNIQUE(template_id, urutan_ke)` |
| `pengajuan_surat` | Pengajuan: `public_reference`, student_id, template_id, `payload_isian_json`, `version_number`, `current_step`, `status_pengajuan`, tanggal, `deadline_revisi`, `pdf_path`, `pdf_checksum`, `pdf_status`, `surat_number`, `verification_token_hash` |
| `approval_routes_snapshot` | Snapshot rute saat pengajuan dibuat |
| `jalur_persetujuan` | Histori keputusan: snapshot_step_id, employee_id, `urutan_hierarki`, `round_number`, `status_persetujuan`, catatan, `waktu_diproses`. `UNIQUE(pengajuan_id, round_number, urutan_hierarki)` |
| `submission_revisions` | Riwayat versi + alasan revisi, peminta, waktu, `resubmitted_at` |
| `document_events` | Peristiwa dokumen (pembuatan, aktivasi tahap, finalisasi, unduhan, kegagalan PDF) |
| `surat_counters` | Penomoran surat per template per tahun |
| `notifications` | Notifikasi internal per pengguna |
| `audit_logs` | Audit tindakan sensitif (aktor, pengajuan, aksi, nilai lama/baru, IP) |

Indeks disediakan untuk query antrean (`idx_pengajuan_status`, `idx_jalur_queue`, `idx_notif_user`,
`idx_pengajuan_deadline`, `idx_pengajuan_token`, dan lainnya).

---

## Keamanan

- **RBAC** di backend untuk setiap endpoint dan halaman.
- **Kepemilikan data**: mahasiswa hanya melihat/mengubah pengajuannya sendiri (pihak lain menerima `404`).
- **Validasi transisi status** di backend; status/tahap/role dari request tidak pernah dipercaya.
- **Prepared statement** (`better-sqlite3`) untuk semua query.
- **Proteksi CSRF**: token per session, wajib pada header `X-CSRF-Token` untuk semua request
  yang mengubah data; perbandingan konstan-waktu.
- **Session**: cookie `httpOnly`, `sameSite=lax`, `secure` pada produksi, regenerasi session setelah
  login (anti session fixation), session dihapus saat logout, store SQLite (bukan MemoryStore).
- **Rate limiting**: login dan registrasi.
- **Helmet** dengan Content Security Policy, `frame-ancestors 'none'`, referrer policy `no-referrer`.
- **Error handling**: pengguna tidak pernah menerima stack trace; detail internal hanya di log server.
- **Audit log** untuk tindakan sensitif (login, pembuatan pengajuan, verifikasi, keputusan,
  finalisasi, kegagalan PDF, kedaluwarsa) — tidak ada password, session secret, atau token yang dicatat.
- **Transaksi database** untuk setiap keputusan persetujuan dan perubahan status penting.

---

## Pengujian

```bash
npm test                 # 62 pengujian otomatis (node:test + supertest)
npm run test:watch       # mode watch
npm run test:browser     # uji antarmuka via Chrome headless (server harus berjalan)
```

Setiap file uji berjalan pada proses terpisah dengan database SQLite temporer sendiri
(`tests/helpers/index.js`), sehingga tidak saling mengganggu dan tidak menyentuh database
pengembangan.

### Hasil pengujian terakhir (Node.js 24.21.0, macOS)

```
npm test → tests 63 | pass 63 | fail 0 | duration ≈ 9 s
```

| Kelompok | Cakupan | Hasil |
| --- | --- | --- |
| `01-auth.test.js` (11) | login valid/salah, email tidak dikenal, logout, registrasi, penolakan role, akun nonaktif, pencabutan session, CSRF | ✅ 11/11 |
| `02-pengajuan.test.js` (10) | pengajuan valid, field wajib, urutan tanggal, template nonaktif, whitelist skema, input berbahaya, kepemilikan, snapshot rute | ✅ 10/10 |
| `03-approval.test.js` (14) | antrean staf, revisi wajib alasan, penerusan, larangan lompat tahap, pejabat tidak ditugaskan, aktivasi tahap berikutnya, PDF setelah tahap terakhir, rute satu tahap (SKAK) sampai PDF, request ganda, penolakan, kegagalan PDF + retry | ✅ 14/14 |
| `04-revisi.test.js` (9) | perbaikan & kirim ulang, validasi ulang, larangan edit saat diproses, kembali ke verifikasi staf, riwayat versi, histori persetujuan lama, kedaluwarsa (idempoten) | ✅ 9/9 |
| `05-dokumen.test.js` (10) | PDF hanya setelah semua approval, unduhan pemilik, penolakan pihak lain, URL/QR, token pada berkas PDF nyata, token tidak valid, dokumen ditolak/dibatalkan, checksum berubah, akses statis ditolak | ✅ 10/10 |
| `06-keamanan.test.js` (8) | foreign key & CHECK, rollback transaksi, SQL injection, request tanpa otorisasi, role salah, snapshot tidak terpengaruh perubahan template, notifikasi & audit | ✅ 8/8 |

### Uji antarmuka (Chrome headless)

`npm run test:browser` memverifikasi **15 halaman** pada tiga role (dashboard mahasiswa/staf/pejabat,
katalog, pengajuan, revisi, template, rute, laporan, akun, riwayat) dan menjalankan **alur nyata
lewat antarmuka**:

```
OK [mahasiswa] /mahasiswa/dashboard … /mahasiswa/profil        (5 halaman)
OK [staf]      /staf/dashboard … /staf/akun                    (7 halaman)
OK [pejabat]   /pejabat/dashboard … /pejabat/riwayat           (3 halaman)
OK [alur] mahasiswa mengisi 8 field dan mengirim pengajuan
OK [alur] staf memverifikasi pengajuan lewat modal
OK [alur] dosen pembimbing menyetujui tahap 1
OK [alur] pejabat lain tidak berwenang dan tidak mendapat tombol keputusan
OK [alur] ketua jurusan menyetujui dan dokumen final dibuat
OK [alur] mahasiswa mengunduh PDF final dari antarmuka (≈10,9 KB, diawali %PDF-)
```

### Catatan pengujian yang belum dapat dijalankan

- Uji beban/konkurensi multi-proses tidak dijalankan (SQLite + `better-sqlite3` bersifat sinkron
  dalam satu proses; pengamanan keputusan ganda diuji secara logis melalui request paralel).
- Pengiriman email tidak diuji karena layanan email tidak dikonfigurasi (tidak diklaim berfungsi).
- Uji aksesibilitas otomatis dan pembacaan PDF oleh pustaka eksternal tidak disertakan.

---

## Endpoint API

**Publik**

| Method | Endpoint | Keterangan |
| --- | --- | --- |
| GET | `/api/health` | Status aplikasi |
| GET | `/api/csrf` , `/api/auth/csrf` | Token CSRF sesi |
| POST | `/api/auth/login` , `/api/auth/register` , `/api/auth/logout` | Autentikasi |
| GET | `/api/auth/me` , `/api/auth/profile` | Identitas sesi |
| GET | `/api/verify/:token` | Verifikasi dokumen publik |
| GET | `/verify/:token` | Halaman verifikasi publik |

**Mahasiswa** (`role = MAHASISWA`)

| Method | Endpoint |
| --- | --- |
| GET | `/api/mahasiswa/dashboard` |
| GET | `/api/mahasiswa/templates` , `/api/mahasiswa/templates/:id` |
| GET | `/api/mahasiswa/pengajuan` , `/api/mahasiswa/pengajuan/:id` |
| POST | `/api/mahasiswa/pengajuan` |
| PUT | `/api/mahasiswa/pengajuan/:id/resubmit` |
| POST | `/api/mahasiswa/pengajuan/:id/cancel` |
| PUT | `/api/mahasiswa/profile` |

**Staf** (`role = STAF`)

| Method | Endpoint |
| --- | --- |
| GET | `/api/staf/dashboard` , `/antrean` , `/revisi` , `/proses` , `/pengajuan` , `/laporan` , `/audit` , `/positions` , `/templates` |
| POST | `/api/staf/pengajuan/:id/verifikasi` (decision: `LANJUT` / `REVISI`) |
| POST | `/api/staf/pengajuan/:id/retry-pdf` , `/api/staf/expiry-check` |
| POST/PUT | `/api/staf/templates` , `/api/staf/templates/:id` (termasuk `routes`) |
| GET | `/api/admin/users` , `/api/admin/audit-logs` |
| POST/PATCH | `/api/admin/users` , `/api/admin/users/:id/status` |

**Pejabat** (`role = PEJABAT`)

| Method | Endpoint |
| --- | --- |
| GET | `/api/pejabat/dashboard` , `/antrean` , `/riwayat` |
| POST | `/api/pejabat/pengajuan/:id/keputusan` (decision: `SETUJU` / `REVISI` / `TOLAK`) |

**Bersama** (semua role yang terautentikasi)

| Method | Endpoint |
| --- | --- |
| GET | `/api/surat/:id` (detail dengan penyaringan sesuai kewenangan) |
| GET | `/api/surat/:id/pdf` (unduhan PDF terproteksi) |
| GET | `/api/notifications` , POST `/api/notifications/:id/read` , `/api/notifications/read-all` |

---

## Batasan yang Belum Diimplementasikan

1. **Notifikasi email/WhatsApp tidak ada.** Hanya notifikasi internal dalam aplikasi. Tidak ada
   klaim bahwa email terkirim.
2. **Tanda tangan elektronik tersertifikasi tidak ada.** QR Code memverifikasi dokumen melalui
   server, bukan pengganti sertifikat tanda tangan digital (PSrE).
3. **Lampiran/berkas unggahan belum ada.** Belum ada fitur unggah dokumen persyaratan; persyaratan
   hanya ditampilkan sebagai daftar.
4. **Isi/kalimat surat untuk template selain Surat Izin Penelitian belum dibedakan.** Kelima
   template memiliki skema form dan rute persetujuan serta dapat diajukan sampai PDF final (rute
   satu tahap SKAK diuji pada `tests/03-approval.test.js`, rute dua tahap SIP diuji pada beberapa
   berkas uji), tetapi kerangka isi PDF masih sama untuk semua jenis surat: identitas pemohon +
   data pengajuan + daftar pejabat penyetuju, tanpa paragraf naratif khas per jenis surat.
5. **Status `DRAFT` belum dipakai pada alur UI.** Pengajuan langsung dikirim saat disimpan
   (tidak ada tombol "simpan sebagai draft").
6. **Setelah revisi, seluruh persetujuan pejabat diulang dari awal** (kebijakan versi pertama),
   meskipun histori keputusan lama tetap tersimpan.
7. **Belum ada panel super-admin terpisah.** Pengelolaan akun pegawai melekat pada role `STAF`.
8. **Belum ada pengaturan format nomor surat dari UI.** Format nomor mengikuti pola
   `{urut}/E-Office/{kode template}/{tahun}`.
9. **Pencarian & paginasi masih sederhana** (filter status + pencarian teks pada daftar pengajuan).
10. **Pembersihan berkas PDF lama yang tidak terpakai** belum otomatis (mis. PDF versi lama setelah
    dokumen dibuat ulang).

---

## Lisensi

MIT — lihat `package.json`. Data institusi pada `.env.example` hanya contoh dan bukan data nyata.
