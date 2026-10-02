const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase, listMatches, listSeats, reserveSeat } = require('./db');
const { connectCache, getOrLoad, invalidateAvailability, MATCHES_KEY, seatsKey, TTL_SECONDS } = require('./cache');
const { createBookingRateLimiter } = require('./rate-limiter');

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

function createBookingServer({ database = db, getCache = () => cache, rateLimiter = createBookingRateLimiter() } = {}) {
return http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/matches') {
      const result = await getOrLoad(getCache(), MATCHES_KEY, () => listMatches(database));
      return sendJson(res, 200, { matches: result.value }, result.cache);
    }
    const seatsRoute = url.pathname.match(/^\/api\/matches\/(\d+)\/seats$/);
    if (req.method === 'GET' && seatsRoute) {
      const result = await getOrLoad(getCache(), seatsKey(Number(seatsRoute[1])), () => listSeats(database, Number(seatsRoute[1])));
      return result.value ? sendJson(res, 200, { seats: result.value }, result.cache) : sendJson(res, 404, { error: 'Match not found.' }, result.cache);
    }
    if (req.method === 'POST' && url.pathname === '/api/reservations') {
      // Use the socket address. X-Forwarded-For is client-controlled unless a
      // trusted reverse proxy is configured, so accepting it would allow bypass.
      const attempt = await rateLimiter.consume(getCache(), req.socket.remoteAddress || 'unknown');
      if (attempt.unavailable) return sendJson(res, 503, { error: 'Booking attempts are temporarily unavailable.' });
      const rateHeaders = {
        'X-RateLimit-Limit': String(attempt.limit),
        'X-RateLimit-Remaining': String(attempt.remaining),
        'X-RateLimit-Source': attempt.source
      };
      if (!attempt.allowed) {
        req.resume();
        return sendJson(res, 429, { error: `Too many booking attempts. Try again in ${attempt.retryAfter} seconds.` }, undefined,
          { ...rateHeaders, 'Retry-After': String(attempt.retryAfter) });
      }
      if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Send JSON.' }, undefined, rateHeaders);
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'Enter a valid seat, name, and email.' }, undefined, rateHeaders);
      const { matchId, seatId } = body;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!Number.isSafeInteger(matchId) || matchId < 1 || !Number.isSafeInteger(seatId) || seatId < 1 || !name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        return sendJson(res, 400, { error: 'Enter a valid seat, name, and email.' }, undefined, rateHeaders);
      }
      const result = reserveSeat(database, { matchId, seatId, name, email });
      if (result.status === 201) await invalidateAvailability(getCache(), matchId);
      return sendJson(res, result.status, result.reservation ? { reservation: result.reservation } : { error: result.error }, undefined, rateHeaders);
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
