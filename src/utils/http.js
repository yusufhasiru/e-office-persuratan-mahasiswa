'use strict';

/** Error HTTP yang aman ditampilkan ke pengguna (tanpa stack trace). */
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || `HTTP_${status}`;
    this.expected = true;
  }
}

const badRequest = (msg, code) => new HttpError(400, msg, code || 'BAD_REQUEST');
const unauthorized = (msg, code) => new HttpError(401, msg, code || 'UNAUTHORIZED');
const forbidden = (msg, code) => new HttpError(403, msg, code || 'FORBIDDEN');
const notFound = (msg, code) => new HttpError(404, msg, code || 'NOT_FOUND');
const conflict = (msg, code) => new HttpError(409, msg, code || 'CONFLICT');

/** Wrapper untuk handler async agar error diteruskan ke error middleware. */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict, asyncHandler };
