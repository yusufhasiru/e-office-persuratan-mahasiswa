'use strict';

const { getDb } = require('../config/database');

function log({ actorUserId = null, submissionId = null, action, oldValue = null, newValue = null, ipAddress = null }) {
  const info = getDb()
    .prepare(
      `INSERT INTO audit_logs (actor_user_id, submission_id, action, old_value_json, new_value_json, ip_address)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      actorUserId,
      submissionId,
      action,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
      ipAddress
    );
  return info.lastInsertRowid;
}

function listBySubmission(submissionId) {
  return getDb()
    .prepare(
      `SELECT a.*, u.full_name AS actor_name, u.role AS actor_role
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.submission_id = ? ORDER BY a.id`
    )
    .all(submissionId);
}

function listRecent(limit = 100) {
  return getDb()
    .prepare(
      `SELECT a.*, u.full_name AS actor_name, u.role AS actor_role
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
       ORDER BY a.id DESC LIMIT ?`
    )
    .all(limit);
}

module.exports = { log, listBySubmission, listRecent };
