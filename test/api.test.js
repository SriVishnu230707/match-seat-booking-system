const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');
const { createBookingServer } = require('../server');
const { openDatabase } = require('../db');
const { createBookingRateLimiter } = require('../rate-limiter');

test('reservation API returns client errors for malformed bodies', async () => {
  await new Promise(resolve => server.listen(0, resolve));
  const url = `http://localhost:${server.address().port}/api/reservations`;
  try {
    for (const [body, expected] of [['null', 400], ['[]', 400], ['{', 400], [JSON.stringify({ matchId: '1', seatId: 1, name: 'A', email: 'a@b.com' }), 400], ['x'.repeat(10_001), 413]]) {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      assert.equal(response.status, expected, body.slice(0, 30));
      assert.ok((await response.json()).error);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
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
  const limitedServer = createBookingServer({ database, getCache: () => null, rateLimiter: createBookingRateLimiter() });
  await new Promise(resolve => limitedServer.listen(0, resolve));
  try {
    const origin = `http://localhost:${limitedServer.address().port}`;
    const url = `${origin}/api/reservations`;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `fake-client-${attempt}` }, body: '{}' });
      assert.equal(response.status, attempt <= 5 ? 400 : 429);
      assert.equal(response.headers.get('x-ratelimit-remaining'), String(Math.max(0, 5 - attempt)));
      assert.equal(response.headers.get('x-ratelimit-source'), 'MEMORY');
      if (attempt === 6) assert.ok(Number(response.headers.get('retry-after')) > 0);
    }
    assert.equal((await fetch(`${origin}/api/matches`)).status, 200);
  } finally {
    await new Promise(resolve => limitedServer.close(resolve));
    database.close();
  }
});
