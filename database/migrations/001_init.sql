-- e-Office initial schema
-- All timestamps are stored as ISO-8601 UTC strings (strftime with 'Z') so they
-- are lexicographically comparable and unambiguous.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Jabatan struktural / fungsional (Dosen Pembimbing, Ketua Jurusan, dst.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS positions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  position_name TEXT NOT NULL UNIQUE,
  description   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- Akun pengguna (Mahasiswa, Staf Administrasi, Pejabat Pemaraf)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  nim           TEXT UNIQUE,
  employee_id   TEXT UNIQUE,
  full_name     TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('MAHASISWA','STAF','PEJABAT')),
  study_program TEXT,
  position_id   INTEGER REFERENCES positions(id) ON DELETE SET NULL,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (
    (role = 'MAHASISWA' AND nim IS NOT NULL AND employee_id IS NULL)
    OR (role IN ('STAF','PEJABAT') AND employee_id IS NOT NULL AND nim IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_position ON users(position_id);

-- ---------------------------------------------------------------------------
-- Sesi (store express-session berbasis SQLite, bukan MemoryStore)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  expires INTEGER NOT NULL,
  data    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);

-- ---------------------------------------------------------------------------
-- Katalog template surat + skema form dinamis
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS template_surat (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  kode             TEXT NOT NULL UNIQUE,
  nama_surat       TEXT NOT NULL,
  deskripsi        TEXT,
  persyaratan      TEXT,
  form_schema_json TEXT NOT NULL DEFAULT '[]',
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- Rute approval template (dikelola dinamis dari database)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rute_approval_template (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id          INTEGER NOT NULL REFERENCES template_surat(id) ON DELETE CASCADE,
  urutan_ke            INTEGER NOT NULL CHECK (urutan_ke >= 1),
  position_id          INTEGER NOT NULL REFERENCES positions(id) ON DELETE RESTRICT,
  assigned_employee_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  is_required          INTEGER NOT NULL DEFAULT 1 CHECK (is_required IN (0,1)),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (template_id, urutan_ke)
);

-- ---------------------------------------------------------------------------
-- Pengajuan surat mahasiswa
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pengajuan_surat (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  public_reference       TEXT NOT NULL UNIQUE,
  student_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  template_id            INTEGER NOT NULL REFERENCES template_surat(id) ON DELETE RESTRICT,
  payload_isian_json     TEXT NOT NULL DEFAULT '{}',
  version_number         INTEGER NOT NULL DEFAULT 1,
  current_step           INTEGER NOT NULL DEFAULT 0,
  status_pengajuan       TEXT NOT NULL DEFAULT 'DRAFT'
                         CHECK (status_pengajuan IN ('DRAFT','MENUNGGU_VERIFIKASI_STAF','MENUNGGU_PERSETUJUAN',
                                'PERLU_REVISI','DITOLAK','KEDALUWARSA','SELESAI','DIBATALKAN')),
  tanggal_diajukan       TEXT,
  deadline_revisi        TEXT,
  submitted_at           TEXT,
  completed_at           TEXT,
  pdf_path               TEXT,
  pdf_checksum           TEXT,
  pdf_status             TEXT CHECK (pdf_status IN ('PENDING','READY','FAILED')),
  pdf_last_error         TEXT,
  surat_number           TEXT UNIQUE,
  issued_at              TEXT,
  verification_token_hash TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_pengajuan_student  ON pengajuan_surat(student_id, status_pengajuan);
CREATE INDEX IF NOT EXISTS idx_pengajuan_status   ON pengajuan_surat(status_pengajuan, current_step);
CREATE INDEX IF NOT EXISTS idx_pengajuan_deadline ON pengajuan_surat(status_pengajuan, deadline_revisi);
CREATE INDEX IF NOT EXISTS idx_pengajuan_token    ON pengajuan_surat(verification_token_hash);

-- ---------------------------------------------------------------------------
-- Snapshot rute persetujuan per pengajuan (beku saat pengajuan dibuat)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_routes_snapshot (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  pengajuan_id         INTEGER NOT NULL REFERENCES pengajuan_surat(id) ON DELETE CASCADE,
  urutan_ke            INTEGER NOT NULL CHECK (urutan_ke >= 1),
  position_id          INTEGER NOT NULL REFERENCES positions(id) ON DELETE RESTRICT,
  assigned_employee_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  is_required          INTEGER NOT NULL DEFAULT 1 CHECK (is_required IN (0,1)),
  position_name        TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (pengajuan_id, urutan_ke)
);

-- ---------------------------------------------------------------------------
-- Histori keputusan setiap tahap (tidak pernah dihapus)
-- round_number == version_number pengajuan saat baris dibuat, sehingga seluruh
-- percobaan persetujuan tersimpan sebagai histori.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jalur_persetujuan (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pengajuan_id     INTEGER NOT NULL REFERENCES pengajuan_surat(id) ON DELETE CASCADE,
  snapshot_step_id INTEGER REFERENCES approval_routes_snapshot(id) ON DELETE RESTRICT,
  employee_id      INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  urutan_hierarki  INTEGER NOT NULL CHECK (urutan_hierarki >= 0),
  round_number     INTEGER NOT NULL DEFAULT 1 CHECK (round_number >= 1),
  status_persetujuan TEXT NOT NULL DEFAULT 'MENUNGGU'
                     CHECK (status_persetujuan IN ('MENUNGGU','DISETUJUI','DITOLAK','REVISI','DILANJUTKAN','DIBATALKAN')),
  catatan          TEXT,
  waktu_diproses   TEXT,
  attempt_number   INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (pengajuan_id, round_number, urutan_hierarki)
);

CREATE INDEX IF NOT EXISTS idx_jalur_queue ON jalur_persetujuan(employee_id, status_persetujuan);
CREATE INDEX IF NOT EXISTS idx_jalur_sub   ON jalur_persetujuan(pengajuan_id, round_number);

-- ---------------------------------------------------------------------------
-- Riwayat versi pengajuan + catatan revisi
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS submission_revisions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  pengajuan_id         INTEGER NOT NULL REFERENCES pengajuan_surat(id) ON DELETE CASCADE,
  version_number       INTEGER NOT NULL,
  payload_snapshot_json TEXT NOT NULL,
  revision_reason      TEXT NOT NULL,
  requested_by         INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_by_role    TEXT NOT NULL,
  request_stage        TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resubmitted_at       TEXT,
  UNIQUE (pengajuan_id, version_number)
);

-- ---------------------------------------------------------------------------
-- Peristiwa dokumen (audit trail domain, dipakai juga untuk retry PDF)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pengajuan_id INTEGER NOT NULL REFERENCES pengajuan_surat(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  payload_json TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_events_sub ON document_events(pengajuan_id, created_at);

-- ---------------------------------------------------------------------------
-- Penomoran surat (counter per template per tahun, bebas duplikasi)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS surat_counters (
  template_id INTEGER NOT NULL REFERENCES template_surat(id) ON DELETE CASCADE,
  tahun       INTEGER NOT NULL,
  last_seq    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (template_id, tahun)
);

-- ---------------------------------------------------------------------------
-- Notifikasi internal aplikasi
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                 TEXT NOT NULL,
  message               TEXT NOT NULL,
  related_submission_id INTEGER REFERENCES pengajuan_surat(id) ON DELETE CASCADE,
  is_read               INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read, created_at);

-- ---------------------------------------------------------------------------
-- Audit log tindakan sensitif
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submission_id INTEGER REFERENCES pengajuan_surat(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  old_value_json TEXT,
  new_value_json TEXT,
  ip_address    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_sub  ON audit_logs(submission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(actor_user_id, created_at);
