const test = require('node:test');
const assert = require('node:assert/strict');
const { getOrLoad, invalidateAvailability, MATCHES_KEY, seatsKey, TTL_SECONDS } = require('../cache');

function fakeRedis() {
  const values = new Map();
  return {
    isReady: true,
    values,
    async get(key) { return values.has(key) ? values.get(key) : null; },
    async set(key, value, options) { assert.deepEqual(options, { EX: TTL_SECONDS }); values.set(key, value); },
    async del(keys) { for (const key of keys) values.delete(key); }
  };
}

test('first read fills cache and second read avoids SQLite loader', async () => {
  const redis = fakeRedis();
  let reads = 0;
  const load = () => { reads++; return [{ id: 1, available_seats: 80 }]; };
  assert.equal((await getOrLoad(redis, MATCHES_KEY, load)).cache, 'MISS');
  assert.equal((await getOrLoad(redis, MATCHES_KEY, load)).cache, 'HIT');
  assert.equal(reads, 1);
});

test('successful booking invalidation forces refreshed availability', async () => {
  const redis = fakeRedis();
  let available = 80;
  await getOrLoad(redis, MATCHES_KEY, () => [{ available_seats: available }]);
  await getOrLoad(redis, seatsKey(1), () => [{ available: 1 }]);
  available = 79;
  await invalidateAvailability(redis, 1);
  assert.equal(redis.values.has(MATCHES_KEY), false);
  assert.equal(redis.values.has(seatsKey(1)), false);
  assert.deepEqual((await getOrLoad(redis, MATCHES_KEY, () => [{ available_seats: available }])).value, [{ available_seats: 79 }]);
});

test('SQLite loader remains usable when Redis is unavailable', async () => {
  assert.deepEqual(await getOrLoad(null, MATCHES_KEY, () => [1]), { value: [1], cache: 'BYPASS' });
});
