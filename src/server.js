'use strict';

const { env } = require('./config/env');
const { createApp, sessionStore } = require('./app');
const { getDb, closeDb } = require('./config/database');
const approvalService = require('./services/approval.service');

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`[e-Office] server berjalan di ${env.baseUrl} (${env.nodeEnv})`);
  console.log(`[e-Office] database  : ${env.databasePath}`);
  console.log(`[e-Office] storage   : ${env.storagePath}`);
});

/** Job berkala: pengecekan kedaluwarsa revisi & pembersihan session kedaluwarsa. */
const HOUR_MS = 60 * 60 * 1000;
const scheduler = setInterval(
  () => {
    try {
      const expired = approvalService.runExpiryCheck();
      if (expired.length) console.log(`[job] ${expired.length} pengajuan ditandai KEDALUWARSA`);
      sessionStore.purgeExpired();
    } catch (error) {
      console.error('[job] gagal menjalankan pemeriksaan berkala:', error.message);
    }
  },
  env.isTest ? 24 * HOUR_MS : HOUR_MS
);
scheduler.unref?.();

function shutdown(signal) {
  console.log(`[e-Office] menerima ${signal}, menutup server...`);
  clearInterval(scheduler);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Menutup database bila server gagal start (mis. port dipakai).
process.on('uncaughtException', (error) => {
  console.error('[fatal]', error.message);
  closeDb();
  process.exit(1);
});

module.exports = { app, server, getDb };
