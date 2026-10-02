const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const { createClient } = require('redis');
const { openDatabase, listSeats } = require('../db');
const { createBookingServer } = require('../server');
const { holdKey } = require('../holds');

const redisUrl = process.env.REDIS_TEST_URL;

function scopedClient(raw, prefix) {
  const key = value => `${prefix}${value}`;
  return {
    get isReady() { return raw.isReady; },
    get: value => raw.get(key(value)),
    set: (value, content, options) => raw.set(key(value), content, options),
    mGet: values => raw.mGet(values.map(key)),
    eval: (script, options) => raw.eval(script, { ...options, keys: options.keys.map(key) }),
    destroy: () => raw.destroy()
  };
}

async function connect() {
  const client = createClient({ url: redisUrl, socket: { connectTimeout: 1000, reconnectStrategy: false } });
  client.on('error', () => {});
  await client.connect();
  return client;
}

async function startServer(database, client) {
  let activeClient = client;
  const server = createBookingServer({ database, getCache: () => activeClient });
  await new Promise(resolve => server.listen(0, resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    useClient(next) { activeClient = next; },
    close: () => new Promise(resolve => server.close(resolve))
  };
}

function post(origin, route, body) {
  return fetch(`${origin}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function startWorker(dbFile, prefix) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'support', 'redis-worker.js'), [], {
      env: { ...process.env, REDIS_TEST_DB_FILE: dbFile, REDIS_TEST_PREFIX: prefix },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('message', message => {
      if (message.error) reject(new Error(message.error));
      else resolve({ child, origin: `http://127.0.0.1:${message.port}` });
    });
    child.once('exit', code => { if (code !== 0) reject(new Error(`Worker exited ${code}: ${stderr}`)); });
  });
}

function stopWorker(worker) {
  return new Promise(resolve => {
    if (!worker.child.connected) return resolve();
    worker.child.once('exit', resolve);
    worker.child.send({ type: 'stop' });
  });
}

test('real Redis: competing holds, expiry, shared confirmation, replay, and disconnect', { skip: !redisUrl && 'Set REDIS_TEST_URL to a disposable local Redis instance.' }, async () => {
  const prefix = `cricket-integration:${randomUUID()}:`;
  const dbFile = path.join(os.tmpdir(), `cricket-integration-${randomUUID()}.sqlite`);
  const rawClients = [];
  const databases = [];
  const servers = [];
  try {
    for (let index = 0; index < 2; index++) rawClients.push(await connect());
    const clients = rawClients.map(raw => scopedClient(raw, prefix));
    for (let index = 0; index < 2; index++) databases.push(openDatabase(dbFile));
    for (let index = 0; index < 2; index++) servers.push(await startServer(databases[index], clients[index]));
    const seatId = listSeats(databases[0], 1)[0].id;
    const booking = { matchId: 1, seatId, requestId: randomUUID(), name: 'Redis Tester', email: 'redis@example.com' };

    const [first, second] = await Promise.all(servers.map(server => post(server.origin, '/api/holds', { matchId: 1, seatId })));
    assert.deepEqual([first.status, second.status].sort(), [201, 409]);
    const winnerIndex = first.status === 201 ? 0 : 1;
    const { hold } = await (winnerIndex === 0 ? first : second).json();
    const otherIndex = 1 - winnerIndex;
    const seats = await (await fetch(`${servers[otherIndex].origin}/api/matches/1/seats`)).json();
    assert.equal(seats.seats[0].held, 1);
    assert.equal(seats.seats[0].available, 0);

    // Shorten this test hold directly in Redis to verify real key expiry.
    await rawClients[winnerIndex].expire(`${prefix}${holdKey(1, seatId)}`, 1);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal((await post(servers[otherIndex].origin, '/api/reservations', { ...booking, holdToken: hold.token })).status, 409);
    const replacement = await post(servers[otherIndex].origin, '/api/holds', { matchId: 1, seatId });
    assert.equal(replacement.status, 201);
    const nextHold = (await replacement.json()).hold;
    assert.notEqual(nextHold.token, hold.token);

    const confirmed = await post(servers[otherIndex].origin, '/api/reservations', { ...booking, holdToken: nextHold.token });
    assert.equal(confirmed.status, 201);
    const original = (await confirmed.json()).reservation;
    const replay = await post(servers[winnerIndex].origin, '/api/reservations', { ...booking, holdToken: nextHold.token });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).reservation.id, original.id);
    assert.equal(databases[0].prepare('SELECT COUNT(*) AS count FROM reservations').get().count, 1);

    // Completed results remain in SQLite when Redis is no longer reachable.
    rawClients[winnerIndex].destroy();
    assert.equal((await post(servers[winnerIndex].origin, '/api/reservations', { ...booking, holdToken: nextHold.token })).status, 200);
    const anotherSeat = listSeats(databases[0], 1)[1].id;
    assert.equal((await post(servers[winnerIndex].origin, '/api/holds', { matchId: 1, seatId: anotherSeat })).status, 503);

    // Replacing the connection restores new holds without losing SQLite state.
    const replacementRaw = await connect();
    rawClients.push(replacementRaw);
    servers[winnerIndex].useClient(scopedClient(replacementRaw, prefix));
    assert.equal((await post(servers[winnerIndex].origin, '/api/holds', { matchId: 1, seatId: anotherSeat })).status, 201);
  } finally {
    await Promise.all(servers.map(server => server.close()));
    databases.forEach(database => database.close());
    const live = rawClients.find(client => client.isReady);
    if (live) {
      for await (const keys of live.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
        if (keys.length) await live.del(keys);
      }
    }
    rawClients.forEach(client => { if (client.isOpen) client.destroy(); });
    for (const extension of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(`${dbFile}${extension}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
});

test('real Redis: separate Node processes share holds and one durable reservation', { skip: !redisUrl && 'Set REDIS_TEST_URL to a disposable local Redis instance.' }, async () => {
  const prefix = `cricket-process-test:${randomUUID()}:`;
  const dbFile = path.join(os.tmpdir(), `cricket-process-test-${randomUUID()}.sqlite`);
  const workers = [];
  let cleaner;
  try {
    cleaner = await connect();
    workers.push(await startWorker(dbFile, prefix));
    workers.push(await startWorker(dbFile, prefix));
    const db = openDatabase(dbFile);
    const seatId = listSeats(db, 1)[0].id;
    db.close();
    const [first, second] = await Promise.all(workers.map(worker => post(worker.origin, '/api/holds', { matchId: 1, seatId })));
    assert.deepEqual([first.status, second.status].sort(), [201, 409]);
    const winner = first.status === 201 ? 0 : 1;
    const hold = (await (winner === 0 ? first : second).json()).hold;
    const booking = { matchId: 1, seatId, holdToken: hold.token, requestId: randomUUID(), name: 'Process Tester', email: 'process@example.com' };
    const confirmed = await post(workers[winner].origin, '/api/reservations', booking);
    assert.equal(confirmed.status, 201);
    const original = (await confirmed.json()).reservation;
    const replay = await post(workers[1 - winner].origin, '/api/reservations', booking);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).reservation.id, original.id);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const limited = await post(workers[attempt % 2].origin, '/api/reservations', {});
      assert.equal(limited.status, attempt < 5 ? 400 : 429);
      assert.equal(limited.headers.get('x-ratelimit-source'), 'REDIS');
    }
    const checkDb = openDatabase(dbFile);
    assert.equal(checkDb.prepare('SELECT COUNT(*) AS count FROM reservations').get().count, 1);
    checkDb.close();
  } finally {
    await Promise.all(workers.map(stopWorker));
    if (cleaner?.isReady) {
      for await (const keys of cleaner.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
        if (keys.length) await cleaner.del(keys);
      }
      cleaner.destroy();
    }
    for (const extension of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(`${dbFile}${extension}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
});
