const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase, listMatches, listSeats, reserveSeat, reservationForRequest } = require('./db');
const { connectCache, getOrLoad, invalidateAvailability, MATCHES_KEY, seatsKey, TTL_SECONDS } = require('./cache');
const { createBookingRateLimiter } = require('./rate-limiter');
const holdService = require('./holds');
const confirmation = require('./idempotency');

const db = openDatabase();
const publicDir = path.join(__dirname, 'public');
let cache = null;

function sendJson(res, status, body, cacheStatus, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(cacheStatus ? { 'X-Cache': cacheStatus, 'X-Cache-TTL-Seconds': String(TTL_SECONDS) } : {}), ...extraHeaders });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 10_000) { tooLarge = true; return; }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('Request is too large.'), { status: 413 }));
      try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

function createBookingServer({ database = db, getCache = () => cache, rateLimiter = createBookingRateLimiter(), holdLimiter = createBookingRateLimiter({ limit: 10, scope: 'hold' }), holds = holdService } = {}) {
return http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/matches') {
      const result = await getOrLoad(getCache(), MATCHES_KEY, () => listMatches(database));
      return sendJson(res, 200, { matches: result.value }, result.cache);
    }
    const seatsRoute = url.pathname.match(/^\/api\/matches\/(\d+)\/seats$/);
    if (req.method === 'GET' && seatsRoute) {
      const matchId = Number(seatsRoute[1]);
      const result = await getOrLoad(getCache(), seatsKey(matchId), () => listSeats(database, matchId));
      if (!result.value) return sendJson(res, 404, { error: 'Match not found.' }, result.cache);
      const decorated = await holds.decorateSeatsWithHolds(getCache(), matchId, result.value);
      return decorated.status === 200
        ? sendJson(res, 200, { seats: decorated.seats, holdsAvailable: decorated.holdsAvailable }, result.cache)
        : sendJson(res, decorated.status, { error: decorated.error }, result.cache);
    }
    if (url.pathname === '/api/holds' && req.method === 'POST') {
      const attempt = await holdLimiter.consume(getCache(), req.socket.remoteAddress || 'unknown');
      if (attempt.unavailable) return sendJson(res, 503, { error: 'Seat holds are temporarily unavailable.' });
      if (!attempt.allowed) {
        req.resume();
        return sendJson(res, 429, { error: `Too many seat selections. Try again in ${attempt.retryAfter} seconds.` }, undefined,
          { 'Retry-After': String(attempt.retryAfter) });
      }
      if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Send JSON.' });
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Number.isSafeInteger(body.matchId) || body.matchId < 1 || !Number.isSafeInteger(body.seatId) || body.seatId < 1) {
        return sendJson(res, 400, { error: 'Enter a valid match and seat.' });
      }
      const result = await holds.acquireHold(getCache(), database, body.matchId, body.seatId);
      return sendJson(res, result.status, result.hold ? { hold: result.hold } : { error: result.error });
    }
    if (url.pathname === '/api/holds' && req.method === 'DELETE') {
      if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Send JSON.' });
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Number.isSafeInteger(body.matchId) || body.matchId < 1 || !Number.isSafeInteger(body.seatId) || body.seatId < 1 || typeof body.token !== 'string' || !body.token || body.token.length > 128) {
        return sendJson(res, 400, { error: 'Enter a valid hold.' });
      }
      const result = await holds.releaseHold(getCache(), body.matchId, body.seatId, body.token);
      if (result.status === 204) { res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end(); }
      return sendJson(res, result.status, { error: result.error });
    }
    if (url.pathname === '/api/holds/check' && req.method === 'POST') {
      if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Send JSON.' });
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Number.isSafeInteger(body.matchId) || body.matchId < 1 || !Number.isSafeInteger(body.seatId) || body.seatId < 1 || typeof body.token !== 'string' || !body.token || body.token.length > 128) {
        return sendJson(res, 400, { error: 'Enter a valid hold.' });
      }
      const result = await holds.inspectHold(getCache(), body.matchId, body.seatId, body.token);
      return sendJson(res, result.status, result.hold ? { hold: result.hold } : { error: result.error });
    }
    if (req.method === 'POST' && url.pathname === '/api/reservations/status') {
      if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Send JSON.' });
      const body = await readJson(req);
      const requestId = typeof body?.requestId === 'string' ? body.requestId.toLowerCase() : '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) return sendJson(res, 400, { error: 'Enter a valid request ID.' });
      const reservation = reservationForRequest(database, requestId);
      return reservation
        ? sendJson(res, 200, { reservation: { id: reservation.id, section: reservation.section, row_label: reservation.row_label, seat_number: reservation.seat_number } })
        : sendJson(res, 404, { error: 'No completed reservation for this request ID.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/reservations') {
      if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Send JSON.' });
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'Enter a valid seat, name, and email.' });
      const { matchId, seatId } = body;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const holdToken = body.holdToken;
      const requestId = typeof body.requestId === 'string' ? body.requestId.toLowerCase() : body.requestId;
      const validRequestId = typeof requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId);
      if (validRequestId) {
        const previous = reservationForRequest(database, requestId);
        if (previous) return previous.match_id === matchId && previous.seat_id === seatId && previous.customer_name === name && previous.customer_email === email
          ? sendJson(res, 200, { reservation: previous, replayed: true })
          : sendJson(res, 409, { error: 'This request ID was already used for a different booking.' });
      }
      // Use the socket address; untrusted X-Forwarded-For would allow bypass.
      const attempt = await rateLimiter.consume(getCache(), req.socket.remoteAddress || 'unknown');
      if (attempt.unavailable) return sendJson(res, 503, { error: 'Booking attempts are temporarily unavailable.' });
      const rateHeaders = {
        'X-RateLimit-Limit': String(attempt.limit),
        'X-RateLimit-Remaining': String(attempt.remaining),
        'X-RateLimit-Source': attempt.source
      };
      if (!attempt.allowed) return sendJson(res, 429, { error: `Too many booking attempts. Try again in ${attempt.retryAfter} seconds.` }, undefined,
        { ...rateHeaders, 'Retry-After': String(attempt.retryAfter) });
      if (!Number.isSafeInteger(matchId) || matchId < 1 || !Number.isSafeInteger(seatId) || seatId < 1 || !name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof holdToken !== 'string' || !holdToken || holdToken.length > 128 || !validRequestId) {
        return sendJson(res, 400, { error: 'Enter a valid seat, name, email, hold token, and request ID.' }, undefined, rateHeaders);
      }
      const claim = await confirmation.claim(getCache(), requestId);
      if (claim.status !== 200) return sendJson(res, claim.status, { error: claim.error, code: claim.status === 409 ? 'PROCESSING' : undefined }, undefined,
        claim.status === 409 ? { ...rateHeaders, 'Retry-After': '1' } : rateHeaders);
      try {
        // Another request may have completed after the first SQLite lookup.
        const previous = reservationForRequest(database, requestId);
        if (previous) return previous.match_id === matchId && previous.seat_id === seatId && previous.customer_name === name && previous.customer_email === email
          ? sendJson(res, 200, { reservation: previous, replayed: true }, undefined, rateHeaders)
          : sendJson(res, 409, { error: 'This request ID was already used for a different booking.' }, undefined, rateHeaders);
        const holdCheck = await holds.verifyHoldForConfirmation(getCache(), matchId, seatId, holdToken);
        if (holdCheck.status !== 200) return sendJson(res, holdCheck.status, { error: holdCheck.error, code: holdCheck.status === 409 ? 'HOLD_EXPIRED' : undefined }, undefined, rateHeaders);
        const result = reserveSeat(database, { matchId, seatId, name, email, requestId });
        if (result.status === 201 || result.status === 409) await holds.releaseHold(getCache(), matchId, seatId, holdToken);
        if (result.status === 201) await invalidateAvailability(getCache(), matchId);
        if (result.status === 409) {
          const winner = reservationForRequest(database, requestId);
          if (winner) return winner.match_id === matchId && winner.seat_id === seatId && winner.customer_name === name && winner.customer_email === email
            ? sendJson(res, 200, { reservation: winner, replayed: true }, undefined, rateHeaders)
            : sendJson(res, 409, { error: 'This request ID was already used for a different booking.', code: 'REQUEST_CONFLICT' }, undefined, rateHeaders);
        }
        return sendJson(res, result.status, result.reservation ? { reservation: result.reservation, replayed: false } : { error: result.error, code: result.status === 409 ? 'SEAT_RESERVED' : undefined }, undefined, rateHeaders);
      } finally {
        await confirmation.release(getCache(), requestId, claim.token);
      }
    }
    if (req.method === 'GET' && ['/', '/app.js', '/styles.css', '/cache.css'].includes(url.pathname)) {
      const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const types = { 'index.html': 'text/html', 'app.js': 'text/javascript', 'styles.css': 'text/css', 'cache.css': 'text/css' };
      res.writeHead(200, { 'Content-Type': `${types[filename]}; charset=utf-8` });
      return fs.createReadStream(path.join(publicDir, filename)).pipe(res);
    }
    return sendJson(res, 404, { error: 'Not found.' });
  } catch (error) {
    if (error.message === 'Invalid JSON.' || error.status === 413) return sendJson(res, error.status || 400, { error: error.message });
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: 'Server error.' });
  }
});
}

const server = createBookingServer();

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  connectCache().then(client => {
    cache = client;
    server.listen(port, () => console.log(`Open http://localhost:${port}`));
  }).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { server, createBookingServer };
