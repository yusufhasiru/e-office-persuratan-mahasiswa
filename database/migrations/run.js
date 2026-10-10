'use strict';

/**
 * Runner migrasi sederhana: menjalankan seluruh file .sql di folder ini secara
 * berurutan dan mencatatnya di tabel schema_migrations (idempoten).
 *
 * Penggunaan: npm run migrate
 */
const fs = require('node:fs');
const path = require('node:path');
const { getDb, closeDb } = require('../../src/config/database');

function runMigrations() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`);

  const files = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const results = [];

  for (const file of files) {
    if (applied.has(file)) {
      results.push({ file, status: 'SKIPPED' });
      continue;
    }
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    });
    apply();
    results.push({ file, status: 'APPLIED' });
  }
  return results;
}

if (require.main === module) {
  const results = runMigrations();
  for (const r of results) console.log(`[migrate] ${r.status.padEnd(8)} ${r.file}`);
  console.log('[migrate] selesai.');
  closeDb();
}

module.exports = { runMigrations };
