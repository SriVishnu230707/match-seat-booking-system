const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { server } = require('../server');
const { createBookingServer } = require('../server');
const { openDatabase } = require('../db');
const { createBookingRateLimiter } = require('../rate-limiter');
const { fakeRedis } = require('./support/fake-redis');
const { register } = require('./support/auth-client');

test('JSON parsing preserves Unicode across network chunks and rejects unsafe match IDs', async () => {
  const database = openDatabase(':memory:');
  const redis = fakeRedis();
  const isolatedServer = createBookingServer({ database, getCache: () => redis });
  await new Promise(resolve => isolatedServer.listen(0, resolve));
  const origin = `http://127.0.0.1:${isolatedServer.address().port}`;
  try {
    const name = 'விஷ்ணு';
    const bytes = Buffer.from(JSON.stringify({ name, email: 'unicode@example.com', password: 'testing-password-123' }));
    const split = bytes.indexOf(Buffer.from(name)) + 1;
    const response = await new Promise((resolve, reject) => {
      const request = http.request(`${origin}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        res.on('error', reject);
      });
      request.on('error', reject);
      request.write(bytes.subarray(0, split));
      setTimeout(() => request.end(bytes.subarray(split)), 30);
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.user.name, name);
    for (const id of ['0', '9007199254740992', '9'.repeat(400)]) {
      assert.equal((await fetch(`${origin}/api/matches/${id}/seats`)).status, 400);
    }
  } finally {
    await new Promise(resolve => isolatedServer.close(resolve));
    database.close();
  }
});

test('reservation API returns client errors for malformed bodies', async () => {
  const database = openDatabase(':memory:');
  const isolatedServer = createBookingServer({ database, getCache: () => fake });
  const fake = fakeRedis();
  await new Promise(resolve => isolatedServer.listen(0, resolve));
  const origin = `http://localhost:${isolatedServer.address().port}`;
  const { cookie } = await register(origin);
  const url = `${origin}/api/reservations`;
  try {
    for (const [body, expected] of [['null', 400], ['[]', 400], ['{', 400], [JSON.stringify({ matchId: '1', seatId: 1, name: 'A', email: 'a@b.com' }), 400], ['x'.repeat(10_001), 413]]) {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body });
      assert.equal(response.status, expected, body.slice(0, 30));
      assert.ok((await response.json()).error);
    }
  } finally {
    await new Promise(resolve => isolatedServer.close(resolve));
    database.close();
  }
});

test('availability responses expose cache state and configured lifetime', async () => {
  await new Promise(resolve => server.listen(0, resolve));
  try {
    const origin = `http://localhost:${server.address().port}`;
    const response = await fetch(`${origin}/api/matches`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-cache'), 'BYPASS');
    assert.equal(response.headers.get('x-cache-ttl-seconds'), '30');
    const stylesheet = await fetch(`${origin}/cache.css`);
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type'), /text\/css/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('booking API returns 429 with retry time after five attempts', async () => {
  const database = openDatabase(':memory:');
  const redis = fakeRedis();
  const limitedServer = createBookingServer({ database, getCache: () => redis, rateLimiter: createBookingRateLimiter() });
  await new Promise(resolve => limitedServer.listen(0, resolve));
  try {
    const origin = `http://localhost:${limitedServer.address().port}`;
    const { cookie } = await register(origin);
    const url = `${origin}/api/reservations`;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `fake-client-${attempt}`, Cookie: cookie }, body: '{}' });
      assert.equal(response.status, attempt <= 5 ? 400 : 429);
      assert.equal(response.headers.get('x-ratelimit-remaining'), String(Math.max(0, 5 - attempt)));
      assert.equal(response.headers.get('x-ratelimit-source'), 'REDIS');
      if (attempt === 6) assert.ok(Number(response.headers.get('retry-after')) > 0);
    }
    assert.equal((await fetch(`${origin}/api/matches`)).status, 200);
  } finally {
    await new Promise(resolve => limitedServer.close(resolve));
    database.close();
  }
});

test('booking API does not reserve seats when the shared limiter is unavailable', async () => {
  const database = openDatabase(':memory:');
  const redis = fakeRedis();
  const limitedServer = createBookingServer({ database, getCache: () => redis, rateLimiter: { consume: async () => ({ unavailable: true }) } });
  await new Promise(resolve => limitedServer.listen(0, resolve));
  try {
    const origin = `http://localhost:${limitedServer.address().port}`;
    const { cookie } = await register(origin);
    const response = await fetch(`${origin}/api/reservations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ matchId: 1, seatId: 1, name: 'Asha', email: 'asha@example.com' })
    });
    assert.equal(response.status, 503);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM reservations').get().count, 0);
  } finally {
    await new Promise(resolve => limitedServer.close(resolve));
    database.close();
  }
});

test('seat holds fail closed when Redis is unavailable', async () => {
  const database = openDatabase(':memory:');
  const redis = fakeRedis();
  let active = redis;
  const isolatedServer = createBookingServer({ database, getCache: () => active });
  await new Promise(resolve => isolatedServer.listen(0, resolve));
  try {
    const origin = `http://localhost:${isolatedServer.address().port}`;
    const { cookie } = await register(origin);
    active = null;
    const seatResponse = await fetch(`${origin}/api/matches/1/seats`);
    const { seats, holdsAvailable } = await seatResponse.json();
    assert.equal(holdsAvailable, false);
    assert.equal(seats[0].available, 0);
    const response = await fetch(`${origin}/api/holds`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ matchId: 1, seatId: seats[0].id })
    });
    assert.equal(response.status, 503);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM reservations').get().count, 0);
  } finally {
    await new Promise(resolve => isolatedServer.close(resolve));
    database.close();
  }
});
