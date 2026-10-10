'use strict';

const express = require('express');
const notifRepo = require('../repositories/notification.repo');
const { requireAuth } = require('../middleware/auth');
const { badRequest } = require('../utils/http');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const notifications = notifRepo.listForUser(req.user.id, 100).map((n) => ({
    id: n.id,
    title: n.title,
    message: n.message,
    related_submission_id: n.related_submission_id,
    is_read: !!n.is_read,
    created_at: n.created_at,
  }));
  res.json({ notifications, belum_dibaca: notifRepo.countUnread(req.user.id) });
});

router.post('/:id/read', (req, res) => {
  const changed = notifRepo.markRead(Number(req.params.id), req.user.id);
  if (!changed) throw badRequest('Notifikasi tidak ditemukan.');
  res.json({ message: 'Notifikasi ditandai sudah dibaca.', belum_dibaca: notifRepo.countUnread(req.user.id) });
});

router.post('/read-all', (req, res) => {
  const changed = notifRepo.markAllRead(req.user.id);
  res.json({ message: `${changed} notifikasi ditandai sudah dibaca.`, belum_dibaca: 0 });
});

module.exports = router;
