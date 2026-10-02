const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, listSeats } = require('../db');
const { createBookingServer } = require('../server');
const holds = require('../holds');
const { fakeRedis } = require('./support/fake-redis');

test('only one customer can hold a seat and only its token can release it', async () => {
  const db = openDatabase(':memory:');
  const redis = fakeRedis();
  const seatId = listSeats(db, 1)[0].id;
  try {
    const [first, second] = await Promise.all([
      holds.acquireHold(redis, db, 1, seatId), holds.acquireHold(redis, db, 1, seatId)
    ]);
    assert.deepEqual([first.status, second.status].sort(), [201, 409]);
    assert.equal(first.hold.token.length, 36);
    assert.equal((await holds.decorateSeatsWithHolds(redis, 1, listSeats(db, 1))).seats[0].available, 0);
    assert.equal((await holds.releaseHold(redis, 1, seatId, 'wrong-token')).status, 409);
    assert.equal((await holds.verifyHoldForConfirmation(redis, 1, seatId, first.hold.token)).status, 200);
    assert.ok(Date.parse((await holds.inspectHold(redis, 1, seatId, first.hold.token)).hold.expiresAt) - Date.now() > 200_000);
    assert.equal((await holds.releaseHold(redis, 1, seatId, first.hold.token)).status, 204);
    assert.equal((await holds.acquireHold(redis, db, 1, seatId)).status, 201);
  } finally { db.close(); }
});

test('expired holds free the seat without allowing an old token to delete a new hold', async () => {
  const db = openDatabase(':memory:');
  const redis = fakeRedis();
  const seatId = listSeats(db, 1)[0].id;
  try {
    const old = await holds.acquireHold(redis, db, 1, seatId);
    redis.advance(301_000);
    const next = await holds.acquireHold(redis, db, 1, seatId);
    assert.equal(next.status, 201);
    assert.notEqual(next.hold.token, old.hold.token);
    assert.equal((await holds.releaseHold(redis, 1, seatId, old.hold.token)).status, 409);
    assert.equal((await holds.verifyHoldForConfirmation(redis, 1, seatId, old.hold.token)).status, 409);
    assert.equal((await holds.verifyHoldForConfirmation(redis, 1, seatId, next.hold.token)).status, 200);
    assert.equal((await holds.inspectHold(redis, 1, seatId, next.hold.token)).status, 200);
  } finally { db.close(); }
});

test('a slow Redis reply does not overstate the hold deadline', async () => {
  const db = openDatabase(':memory:');
  const redis = fakeRedis();
  const originalSet = redis.set.bind(redis);
  redis.set = async (...args) => {
    const result = await originalSet(...args);
    await new Promise(resolve => setTimeout(resolve, 30));
    return result;
  };
  try {
    const startedAt = Date.now();
    const result = await holds.acquireHold(redis, db, 1, listSeats(db, 1)[0].id);
    assert.equal(result.status, 201);
    assert.ok(Date.parse(result.hold.expiresAt) <= startedAt + holds.HOLD_SECONDS * 1000 + 5);
  } finally { db.close(); }
});

test('API requires a live hold to confirm and then marks the seat reserved', async () => {
  const db = openDatabase(':memory:');
  const redis = fakeRedis();
  const server = createBookingServer({ database: db, getCache: () => redis });
  await new Promise(resolve => server.listen(0, resolve));
  const origin = `http://localhost:${server.address().port}`;
  const seatId = listSeats(db, 1)[0].id;
  const request = (route, body, method = 'POST') => fetch(`${origin}${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  try {
    const booking = { matchId: 1, seatId, name: 'Asha', email: 'asha@example.com' };
    assert.equal((await request('/api/reservations', booking)).status, 400);
    const acquired = await request('/api/holds', { matchId: 1, seatId });
    assert.equal(acquired.status, 201);
    const { hold } = await acquired.json();
    assert.equal((await request('/api/holds/check', { matchId: 1, seatId, token: hold.token })).status, 200);
    assert.equal((await request('/api/holds', { matchId: 1, seatId })).status, 409);
    const seatList = await (await fetch(`${origin}/api/matches/1/seats`)).json();
    assert.equal(seatList.seats[0].held, 1);
    assert.equal((await request('/api/reservations', { ...booking, holdToken: 'wrong' })).status, 409);
    const confirmed = await request('/api/reservations', { ...booking, holdToken: hold.token });
    assert.equal(confirmed.status, 201);
    assert.equal((await request('/api/reservations', { ...booking, holdToken: hold.token })).status, 409);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reservations').get().count, 1);
    assert.equal((await holds.acquireHold(redis, db, 1, seatId)).status, 409);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});
