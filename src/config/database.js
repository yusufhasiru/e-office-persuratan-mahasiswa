'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { env } = require('./env');

let db = null;

/**
 * Membuat / membuka koneksi SQLite tunggal (singleton) dengan foreign key aktif.
 * Gunakan getDb() di seluruh aplikasi agar tidak ada koneksi ganda.
 */
function getDb() {
  if (db) return db;

  const dbPath = env.databasePath;
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Menutup koneksi (dipakai oleh test runner). */
function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Menjalankan fungsi di dalam transaksi database.
 * Rollback otomatis bila fungsi melempar error — dipakai seluruh keputusan
 * persetujuan agar status, histori, audit log dan notifikasi konsisten.
 */
function transaction(fn) {
  return getDb().transaction(fn);
}

module.exports = { getDb, closeDb, transaction };
