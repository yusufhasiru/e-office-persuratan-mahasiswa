'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const verificationService = require('../services/verification.service');

const router = express.Router();

const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak permintaan verifikasi. Coba lagi sebentar lagi.' },
});

/** Endpoint publik: tidak memerlukan login, hanya menampilkan data aman. */
router.get('/:token', verifyLimiter, (req, res) => {
  const result = verificationService.verifyToken(req.params.token);
  res.status(200).json(result);
});

module.exports = router;
