'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config();

const ROOT = path.resolve(__dirname, '..', '..');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const nodeEnv = process.env.NODE_ENV || 'development';

// Session secret wajib di produksi. Di test/development dibuat acak bila kosong
// sehingga tidak ada rahasia bawaan yang ikut ter-commit.
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (nodeEnv === 'production') {
    throw new Error('SESSION_SECRET wajib diisi ketika NODE_ENV=production');
  }
  sessionSecret = crypto.randomBytes(32).toString('hex');
}

const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port: int(process.env.PORT, 3000),
  sessionSecret,
  sessionName: process.env.SESSION_NAME || 'eoffice.sid',
  sessionTtlMs: int(process.env.SESSION_TTL_HOURS, 8) * 60 * 60 * 1000,
  databasePath: process.env.DATABASE_PATH
    ? path.resolve(ROOT, process.env.DATABASE_PATH)
    : path.join(ROOT, 'database', 'e-office.sqlite'),
  storagePath: process.env.STORAGE_PATH
    ? path.resolve(ROOT, process.env.STORAGE_PATH)
    : path.join(ROOT, 'storage', 'documents'),
  baseUrl: (process.env.BASE_URL || `http://localhost:${int(process.env.PORT, 3000)}`).replace(/\/+$/, ''),
  revisionDeadlineDays: int(process.env.REVISION_DEADLINE_DAYS, 3),
  trustProxy: bool(process.env.TRUST_PROXY, false),
  institution: {
    name: process.env.INSTITUTION_NAME || 'Universitas Contoh Nusantara',
    faculty: process.env.FACULTY_NAME || 'Fakultas Teknik',
    department: process.env.DEPARTMENT_NAME || 'Jurusan Teknik Informatika',
    address: process.env.INSTITUTION_ADDRESS || 'Jl. Pendidikan No. 1, Kota Contoh 40111',
  },
  seedDemoPasswords: bool(process.env.SEED_DEMO_PASSWORDS, nodeEnv !== 'production'),
  // Batas percobaan login per alamat IP. Produksi memakai batas ketat; pada
  // development/test dilonggarkan agar pengujian otomatis tidak saling memblokir.
  loginRateLimitMax: int(process.env.LOGIN_RATE_LIMIT_MAX, nodeEnv === 'production' ? 20 : 120),
  loginRateLimitWindowMinutes: int(process.env.LOGIN_RATE_LIMIT_WINDOW_MINUTES, 10),
};

module.exports = { env, ROOT };
