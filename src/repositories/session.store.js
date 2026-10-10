'use strict';

const session = require('express-session');
const { getDb } = require('../config/database');

/**
 * Store session berbasis SQLite (menggantikan MemoryStore agar session tidak
 * hilang saat restart dan tidak bocor di lingkungan multi-proses sederhana).
 */
class SqliteSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = getDb().prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row) return callback(null, null);
      if (row.expires <= Date.now()) {
        getDb().prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.data));
    } catch (err) {
      return callback(err);
    }
  }

  set(sid, sess, callback) {
    try {
      const maxAge = sess?.cookie?.maxAge ?? 8 * 60 * 60 * 1000;
      const expires = Date.now() + maxAge;
      getDb()
        .prepare(
          `INSERT INTO sessions (sid, expires, data) VALUES (?, ?, ?)
           ON CONFLICT(sid) DO UPDATE SET expires = excluded.expires, data = excluded.data`
        )
        .run(sid, expires, JSON.stringify(sess));
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      getDb().prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  }

  touch(sid, sess, callback) {
    try {
      const maxAge = sess?.cookie?.maxAge ?? 8 * 60 * 60 * 1000;
      getDb().prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(Date.now() + maxAge, sid);
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  }

  clear(callback) {
    try {
      getDb().prepare('DELETE FROM sessions').run();
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  }

  length(callback) {
    try {
      callback(null, getDb().prepare('SELECT COUNT(*) AS total FROM sessions').get().total);
    } catch (err) {
      callback(err);
    }
  }

  /** Menghapus session kedaluwarsa (dipanggil oleh scheduler berkala). */
  purgeExpired() {
    return getDb().prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now()).changes;
  }
}

module.exports = { SqliteSessionStore };
