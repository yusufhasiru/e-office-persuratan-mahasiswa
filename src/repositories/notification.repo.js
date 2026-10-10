'use strict';

const { getDb } = require('../config/database');

function create(userId, title, message, relatedSubmissionId = null) {
  const info = getDb()
    .prepare(
      `INSERT INTO notifications (user_id, title, message, related_submission_id)
       VALUES (?, ?, ?, ?)`
    )
    .run(userId, title, message, relatedSubmissionId);
  return getDb().prepare('SELECT * FROM notifications WHERE id = ?').get(info.lastInsertRowid);
}

function listForUser(userId, limit = 50) {
  return getDb()
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(userId, limit);
}

function countUnread(userId) {
  return getDb().prepare('SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND is_read = 0').get(userId).total;
}

function markRead(id, userId) {
  return getDb()
    .prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
    .run(id, userId).changes;
}

function markAllRead(userId) {
  return getDb().prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(userId).changes;
}

module.exports = { create, listForUser, countUnread, markRead, markAllRead };
