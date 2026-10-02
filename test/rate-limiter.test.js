const test = require('node:test');
const assert = require('node:assert/strict');
const { createBookingRateLimiter } = require('../rate-limiter');

test('local fallback limits one IP and resets after the window', async () => {
  let time = 0;
  const limiter = createBookingRateLimiter({ limit: 2, windowSeconds: 10, now: () => time });
  assert.deepEqual(await limiter.consume(null, '127.0.0.1'), { allowed: true, remaining: 1, retryAfter: 10, limit: 2, source: 'MEMORY' });
  assert.equal((await limiter.consume(null, '127.0.0.2')).allowed, true);
  assert.equal((await limiter.consume(null, '127.0.0.1')).allowed, true);
  const blocked = await limiter.consume(null, '127.0.0.1');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  time = 10_000;
  assert.equal((await limiter.consume(null, '127.0.0.1')).allowed, true);
});

test('Redis counter is shared across server instances and expires', async () => {
  const counters = new Map();
  let time = 0;
  const redis = {
    isReady: true,
    async eval(_script, { keys, arguments: args }) {
      const key = keys[0];
      let counter = counters.get(key);
      if (!counter || counter.expiresAt <= time) counter = { count: 0, expiresAt: time + Number(args[0]) * 1000 };
      counter.count++;
      counters.set(key, counter);
      return [counter.count, Math.ceil((counter.expiresAt - time) / 1000)];
    }
  };
  const first = createBookingRateLimiter({ limit: 2, windowSeconds: 10 });
  const second = createBookingRateLimiter({ limit: 2, windowSeconds: 10 });
  assert.equal((await first.consume(redis, '127.0.0.1')).allowed, true);
  assert.equal((await second.consume(redis, '127.0.0.1')).allowed, true);
  assert.equal((await first.consume(redis, '127.0.0.1')).allowed, false);
  time = 10_000;
  assert.equal((await second.consume(redis, '127.0.0.1')).allowed, true);
});

test('Redis failure cannot reset a client to a fresh local limit', async () => {
  const limiter = createBookingRateLimiter();
  const redis = {
    isReady: true,
    async eval() { throw new Error('connection lost'); },
    destroy() { this.isReady = false; }
  };
  assert.deepEqual(await limiter.consume(redis, '127.0.0.1'), { unavailable: true });
  assert.deepEqual(await limiter.consume(redis, '127.0.0.1'), { unavailable: true });
  assert.equal((await limiter.consume(null, '127.0.0.1')).allowed, true);
});
