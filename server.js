const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase, listMatches, listSeats, reserveSeat, reservationForRequest, listReservationsForUser } = require('./db');
const { connectCache, getOrLoad, invalidateAvailability, MATCHES_KEY, seatsKey, TTL_SECONDS } = require('./cache');
const { createBookingRateLimiter } = require('./rate-limiter');
const holdService = require('./holds');
const confirmation = require('./idempotency');
const auth = require('./auth');

const db = openDatabase();
const publicDir = path.join(__dirname, 'public');
let cache = null;

function sendJson(res, status, body, cacheStatus, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...(cacheStatus ? { 'X-Cache': cacheStatus, 'X-Cache-TTL-Seconds': String(TTL_SECONDS) } : {}), ...extraHeaders });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 10_000) { tooLarge = true; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('Request is too large.'), { status: 413 }));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

function createBookingServer({
  database = db, getCache = () => cache,
  rateLimiter = createBookingRateLimiter(), holdLimiter = createBookingRateLimiter({ limit: 10, scope: 'hold' }),
  bookingUserLimiter = createBookingRateLimiter({ scope: 'booking-user' }),
  holdUserLimiter = createBookingRateLimiter({ limit: 10, scope: 'hold-user' }),
  loginIpLimiter = createBookingRateLimiter({ scope: 'login-ip' }),
  loginEmailLimiter = createBookingRateLimiter({ scope: 'login-email' }),
  signupLimiter = createBookingRateLimiter({ scope: 'signup-ip' }),
  holds = holdService
} = {}) {
return http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const redis = getCache();
    const ip = req.socket.remoteAddress || 'unknown';
    if (['POST', 'DELETE', 'PUT', 'PATCH'].includes(req.method) && req.headers.origin) {
      const expectedHost = req.headers.host;
      let origin;
      try { origin = new URL(req.headers.origin); } catch { return sendJson(res, 403, { error: 'Request origin is not allowed.' }); }
      if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== expectedHost) return sendJson(res, 403, { error: 'Request origin is not allowed.' });
    }
    async function requireUser() {
      const session = await auth.currentUser(redis, database, req);
      if (session.status !== 200) sendJson(res, session.status, { error: session.status === 401 ? 'Sign in to continue.' : 'Account sessions are temporarily unavailable.' });
      return session.status === 200 ? session : null;
    }
    if (req.method === 'POST' && (url.pathname === '/api/auth/register' || url.pathname === '/api/auth/login')) {
      if (!redis?.isReady) return sendJson(res, 503, { error: 'Account sign-in requires Redis.' });
      if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Send JSON.' });
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'Enter valid account details.' });
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const password = body.password;
      const registering = url.pathname.endsWith('/register');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof password !== 'string' || password.length < 8 || password.length > 128 || (registering && (!name || name.length > 100))) {
        return sendJson(res, 400, { error: 'Enter a valid name, email, and password of 8–128 characters.' });
      }
      const ipAttempt = await (registering ? signupLimiter : loginIpLimiter).consume(redis, ip);
      if (ipAttempt.unavailable) return sendJson(res, 503, { error: 'Account sign-in is temporarily unavailable.' });
      if (!ipAttempt.allowed) return sendJson(res, 429, { error: 'Too many account attempts. Try again shortly.' }, undefined, { 'Retry-After': String(ipAttempt.retryAfter) });
      if (!registering) {
        const accountAttempt = await loginEmailLimiter.consume(redis, email);
        if (accountAttempt.unavailable) return sendJson(res, 503, { error: 'Account sign-in is temporarily unavailable.' });
        if (!accountAttempt.allowed) return sendJson(res, 429, { error: 'Too many account attempts. Try again shortly.' }, undefined, { 'Retry-After': String(accountAttempt.retryAfter) });
      }
      const user = registering ? await auth.createUser(database, { name, email, password }) : await auth.verifyUser(database, email, password);
      if (!user) return sendJson(res, registering ? 409 : 401, { error: registering ? 'An account with this email already exists.' : 'Invalid email or password.' });
      const token = await auth.createSession(redis, user.id);
      if (!token) return sendJson(res, 503, registering
        ? { error: 'Your account was created, but sign-in is temporarily unavailable. Sign in with this account when Redis is available.', accountCreated: true }
        : { error: 'Could not create a session. Try again.' });
      return sendJson(res, registering ? 201 : 200, { user }, undefined, { 'Set-Cookie': auth.cookieHeader(token, process.env.COOKIE_SECURE === '1' || Boolean(req.socket.encrypted)) });
    }
    if (req.method === 'GET' && url.pathname === '/api/me') {
      const session = await requireUser();
      return session && sendJson(res, 200, { user: session.user });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const session = await requireUser();
      if (!session) return;
      if (!(await auth.deleteSession(redis, session.token))) return sendJson(res, 503, { error: 'Could not sign out. Try again.' });
      return sendJson(res, 200, { signedOut: true }, undefined, { 'Set-Cookie': auth.clearCookieHeader(process.env.COOKIE_SECURE === '1' || Boolean(req.socket.encrypted)) });
    }
    if (req.method === 'GET' && url.pathname === '/api/me/reservations') {
      const session = await requireUser();
      return session && sendJson(res, 200, { reservations: listReservationsForUser(database, session.user.id) });
    }
    if (req.method === 'GET' && url.pathname === '/api/matches') {
      const result = await getOrLoad(getCache(), MATCHES_KEY, () => listMatches(database));
      return sendJson(res, 200, { matches: result.value }, result.cache);
    }
    const seatsRoute = url.pathname.match(/^\/api\/matches\/(\d+)\/seats$/);
    if (req.method === 'GET' && seatsRoute) {
      const matchId = Number(seatsRoute[1]);
      if (!Number.isSafeInteger(matchId) || matchId < 1) return sendJson(res, 400, { error: 'Enter a valid match ID.' });
      const result = await getOrLoad(getCache(), seatsKey(matchId), () => listSeats(database, matchId));
      if (!result.value) return sendJson(res, 404, { error: 'Match not found.' }, result.cache);
      const decorated = await holds.decorateSeatsWithHolds(getCache(), matchId, result.value);
      return decorated.status === 200
        ? sendJson(res, 200, { seats: decorated.seats, holdsAvailable: decorated.holdsAvailable }, result.cache)
        : sendJson(res, decorated.status, { error: decorated.error }, result.cache);
    }
    if (url.pathname === '/api/holds' && req.method === 'POST') {
      const session = await requireUser();
      if (!session) return;
      const attempt = await holdLimiter.consume(redis, ip);
      if (attempt.unavailable) return sendJson(res, 503, { error: 'Seat holds are temporarily unavailable.' });
      if (!attempt.allowed) {
        req.resume();
        return sendJson(res, 429, { error: `Too many seat selections. Try again in ${attempt.retryAfter} seconds.` }, undefined,
          { 'Retry-After': String(attempt.retryAfter) });
      }
      const userAttempt = await holdUserLimiter.consume(redis, String(session.user.id));
      if (userAttempt.unavailable) return sendJson(res, 503, { error: 'Seat holds are temporarily unavailable.' });
      if (!userAttempt.allowed) return sendJson(res, 429, { error: `Too many seat selections for this account. Try again in ${userAttempt.retryAfter} seconds.` }, undefined, { 'Retry-After': String(userAttempt.retryAfter) });
      if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Send JSON.' });
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Number.isSafeInteger(body.matchId) || body.matchId < 1 || !Number.isSafeInteger(body.seatId) || body.seatId < 1) {
        return sendJson(res, 400, { error: 'Enter a valid match and seat.' });
      }
      const result = await holds.acquireHold(redis, database, body.matchId, body.seatId, session.user.id);
      return sendJson(res, result.status, result.hold ? { hold: result.hold } : { error: result.error });
    }
    if (url.pathname === '/api/holds' && req.method === 'DELETE') {
      const session = await requireUser();
      if (!session) return;
      if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Send JSON.' });
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Number.isSafeInteger(body.matchId) || body.matchId < 1 || !Number.isSafeInteger(body.seatId) || body.seatId < 1 || typeof body.token !== 'string' || !body.token || body.token.length > 128) {
        return sendJson(res, 400, { error: 'Enter a valid hold.' });
      }
      const result = await holds.releaseHold(redis, body.matchId, body.seatId, body.token, session.user.id);
      if (result.status === 204) { res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end(); }
      return sendJson(res, result.status, { error: result.error });
    }
    if (url.pathname === '/api/holds/check' && req.method === 'POST') {
      const session = await requireUser();
      if (!session) return;
      if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Send JSON.' });
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Number.isSafeInteger(body.matchId) || body.matchId < 1 || !Number.isSafeInteger(body.seatId) || body.seatId < 1 || typeof body.token !== 'string' || !body.token || body.token.length > 128) {
        return sendJson(res, 400, { error: 'Enter a valid hold.' });
      }
      const result = await holds.inspectHold(redis, body.matchId, body.seatId, body.token, session.user.id);
      return sendJson(res, result.status, result.hold ? { hold: result.hold } : { error: result.error });
    }
    if (req.method === 'POST' && url.pathname === '/api/reservations/status') {
      const session = await requireUser();
      if (!session) return;
      if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Send JSON.' });
      const body = await readJson(req);
      const requestId = typeof body?.requestId === 'string' ? body.requestId.toLowerCase() : '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) return sendJson(res, 400, { error: 'Enter a valid request ID.' });
      const reservation = reservationForRequest(database, requestId);
      return reservation && reservation.user_id === session.user.id
        ? sendJson(res, 200, { reservation: { id: reservation.id, section: reservation.section, row_label: reservation.row_label, seat_number: reservation.seat_number } })
        : sendJson(res, 404, { error: 'No completed reservation for this request ID.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/reservations') {
      const session = await requireUser();
      if (!session) return;
      if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Send JSON.' });
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'Enter a valid seat, name, and email.' });
      const { matchId, seatId } = body;
      const name = session.user.name;
      const email = session.user.email;
      const holdToken = body.holdToken;
      const requestId = typeof body.requestId === 'string' ? body.requestId.toLowerCase() : body.requestId;
      const validRequestId = typeof requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId);
      if (validRequestId) {
        const previous = reservationForRequest(database, requestId);
        if (previous) return previous.user_id === session.user.id && previous.match_id === matchId && previous.seat_id === seatId
          ? sendJson(res, 200, { reservation: previous, replayed: true })
          : sendJson(res, 409, { error: 'This request ID was already used for a different booking.' });
      }
      // Use the socket address; untrusted X-Forwarded-For would allow bypass.
      const attempt = await rateLimiter.consume(redis, ip);
      if (attempt.unavailable) return sendJson(res, 503, { error: 'Booking attempts are temporarily unavailable.' });
      const rateHeaders = {
        'X-RateLimit-Limit': String(attempt.limit),
        'X-RateLimit-Remaining': String(attempt.remaining),
        'X-RateLimit-Source': attempt.source
      };
      if (!attempt.allowed) return sendJson(res, 429, { error: `Too many booking attempts. Try again in ${attempt.retryAfter} seconds.` }, undefined,
        { ...rateHeaders, 'Retry-After': String(attempt.retryAfter) });
      const userAttempt = await bookingUserLimiter.consume(redis, String(session.user.id));
      if (userAttempt.unavailable) return sendJson(res, 503, { error: 'Booking attempts are temporarily unavailable.' });
      rateHeaders['X-RateLimit-Remaining'] = String(Math.min(attempt.remaining, userAttempt.remaining));
      if (!userAttempt.allowed) return sendJson(res, 429, { error: `Too many booking attempts for this account. Try again in ${userAttempt.retryAfter} seconds.` }, undefined, { ...rateHeaders, 'Retry-After': String(userAttempt.retryAfter) });
      if (!Number.isSafeInteger(matchId) || matchId < 1 || !Number.isSafeInteger(seatId) || seatId < 1 || typeof holdToken !== 'string' || !holdToken || holdToken.length > 128 || !validRequestId) {
        return sendJson(res, 400, { error: 'Enter a valid seat, hold token, and request ID.' }, undefined, rateHeaders);
      }
      const claim = await confirmation.claim(getCache(), requestId);
      if (claim.status !== 200) return sendJson(res, claim.status, { error: claim.error, code: claim.status === 409 ? 'PROCESSING' : undefined }, undefined,
        claim.status === 409 ? { ...rateHeaders, 'Retry-After': '1' } : rateHeaders);
      try {
        // Another request may have completed after the first SQLite lookup.
        const previous = reservationForRequest(database, requestId);
        if (previous) return previous.user_id === session.user.id && previous.match_id === matchId && previous.seat_id === seatId
          ? sendJson(res, 200, { reservation: previous, replayed: true }, undefined, rateHeaders)
          : sendJson(res, 409, { error: 'This request ID was already used for a different booking.' }, undefined, rateHeaders);
        const holdCheck = await holds.verifyHoldForConfirmation(redis, matchId, seatId, holdToken, session.user.id);
        if (holdCheck.status !== 200) return sendJson(res, holdCheck.status, { error: holdCheck.error, code: holdCheck.status === 409 ? 'HOLD_EXPIRED' : undefined }, undefined, rateHeaders);
        const result = reserveSeat(database, { matchId, seatId, name, email, requestId, userId: session.user.id });
        if (result.status === 201 || result.status === 409) await holds.releaseHold(redis, matchId, seatId, holdToken, session.user.id);
        if (result.status === 201) await invalidateAvailability(getCache(), matchId);
        if (result.status === 409) {
          const winner = reservationForRequest(database, requestId);
          if (winner) return winner.user_id === session.user.id && winner.match_id === matchId && winner.seat_id === seatId
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
      res.writeHead(200, { 'Content-Type': `${types[filename]}; charset=utf-8`, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'" });
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
