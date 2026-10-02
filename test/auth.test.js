const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase, listSeats } = require('../db');
const { createBookingServer } = require('../server');
const { fakeRedis } = require('./support/fake-redis');
const { register } = require('./support/auth-client');

test('accounts own sessions, holds, status, and reservation history', async () => {
  const db = openDatabase(':memory:');
  const redis = fakeRedis();
  const server = createBookingServer({ database: db, getCache: () => redis });
  await new Promise(resolve => server.listen(0, resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (route, body, cookie, method = 'POST') => fetch(`${origin}${route}`, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body)
  });
  try {
    const first = await register(origin, 'Asha');
    const second = await register(origin, 'Bala');
    assert.match(first.cookie, /^cricket_session=/);
    assert.equal(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(first.user.id).password_hash.includes('testing-password'), false);
    assert.equal((await fetch(`${origin}/api/me`)).status, 401);
    assert.equal((await fetch(`${origin}/api/me`, { headers: { Cookie: first.cookie } })).status, 200);
    const seatId = listSeats(db, 1)[0].id;
    const acquired = await request('/api/holds', { matchId: 1, seatId }, first.cookie);
    assert.equal(acquired.status, 201);
    const { hold } = await acquired.json();
    const holdBody = { matchId: 1, seatId, token: hold.token };
    assert.equal((await request('/api/holds/check', holdBody, second.cookie)).status, 409);
    assert.equal((await request('/api/holds', holdBody, second.cookie, 'DELETE')).status, 409);
    const booking = { matchId: 1, seatId, holdToken: hold.token, requestId: randomUUID() };
    assert.equal((await request('/api/reservations', booking, second.cookie)).status, 409);
    const confirmed = await request('/api/reservations', booking, first.cookie);
    assert.equal(confirmed.status, 201);
    const reservationId = (await confirmed.json()).reservation.id;
    assert.equal((await request('/api/reservations/status', { requestId: booking.requestId }, second.cookie)).status, 404);
    assert.equal((await request('/api/reservations', booking, second.cookie)).status, 409);
    const history = await (await fetch(`${origin}/api/me/reservations`, { headers: { Cookie: first.cookie } })).json();
    assert.deepEqual(history.reservations.map(item => item.id), [reservationId]);
    const otherHistory = await (await fetch(`${origin}/api/me/reservations`, { headers: { Cookie: second.cookie } })).json();
    assert.deepEqual(otherHistory.reservations, []);
    assert.equal((await request('/api/auth/logout', {}, first.cookie)).status, 200);
    assert.equal((await fetch(`${origin}/api/me`, { headers: { Cookie: first.cookie } })).status, 401);
    const login = await request('/api/auth/login', { email: first.email, password: 'testing-password-123' });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    assert.equal((await request('/api/holds', { matchId: 1, seatId: listSeats(db, 1)[1].id }, first.cookie)).status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});

test('account endpoints reject foreign origins and expired sessions', async () => {
  const db = openDatabase(':memory:');
  const redis = fakeRedis();
  const server = createBookingServer({ database: db, getCache: () => redis });
  await new Promise(resolve => server.listen(0, resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const foreign = await fetch(`${origin}/api/auth/register`, {
      method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Asha', email: 'asha@example.com', password: 'testing-password-123' })
    });
    assert.equal(foreign.status, 403);
    const malformedOrigin = await fetch(`${origin}/api/auth/register`, {
      method: 'POST', headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(malformedOrigin.status, 403);
    const { cookie } = await register(origin);
    redis.advance(7 * 24 * 60 * 60 * 1000 + 1000);
    assert.equal((await fetch(`${origin}/api/me`, { headers: { Cookie: cookie } })).status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});

test('failed logins are limited and existing reservations survive account migration', async () => {
  const filename = path.join(os.tmpdir(), `cricket-legacy-${randomUUID()}.sqlite`);
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE matches (id INTEGER PRIMARY KEY, home_team TEXT NOT NULL, away_team TEXT NOT NULL, venue TEXT NOT NULL, starts_at TEXT NOT NULL);
    CREATE TABLE seats (id INTEGER PRIMARY KEY, match_id INTEGER NOT NULL, section TEXT NOT NULL, row_label TEXT NOT NULL, seat_number INTEGER NOT NULL, price INTEGER NOT NULL);
    CREATE TABLE reservations (id INTEGER PRIMARY KEY, match_id INTEGER NOT NULL, seat_id INTEGER NOT NULL, customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), request_id TEXT, UNIQUE(match_id, seat_id));
    INSERT INTO matches VALUES (1, 'India', 'Australia', 'Mumbai', '2026-11-15');
    INSERT INTO seats VALUES (1, 1, 'North', 'A', 1, 1200);
    INSERT INTO reservations (match_id, seat_id, customer_name, customer_email) VALUES (1, 1, 'Legacy', 'legacy@example.com');
  `);
  legacy.close();
  const db = openDatabase(filename);
  const redis = fakeRedis();
  const server = createBookingServer({ database: db, getCache: () => redis });
  await new Promise(resolve => server.listen(0, resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(db.prepare('SELECT user_id FROM reservations WHERE id = 1').get().user_id, null);
    const account = await register(origin, 'Asha');
    for (let attempt = 1; attempt <= 6; attempt++) {
      const response = await fetch(`${origin}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: account.email, password: 'wrong-password' })
      });
      assert.equal(response.status, attempt <= 5 ? 401 : 429);
    }
    const history = await (await fetch(`${origin}/api/me/reservations`, { headers: { Cookie: account.cookie } })).json();
    assert.deepEqual(history.reservations, []);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    for (const extension of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(`${filename}${extension}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
});
