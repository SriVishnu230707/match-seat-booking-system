const { createHash } = require('node:crypto');

const LIMIT = 5;
const WINDOW_SECONDS = 60;
const MAX_LOCAL_KEYS = 10_000;
const INCREMENT_WITH_EXPIRY = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  local ttl = redis.call('TTL', KEYS[1])
  if ttl < 0 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
    ttl = tonumber(ARGV[1])
  end
  return { count, ttl }
`;

function createBookingRateLimiter({ limit = LIMIT, windowSeconds = WINDOW_SECONDS, scope = 'booking', now = Date.now } = {}) {
  const local = new Map();

  function localAttempt(key) {
    const time = now();
    let record = local.get(key);
    if (!record || record.expiresAt <= time) {
      if (!record && local.size >= MAX_LOCAL_KEYS) {
        for (const [oldKey, value] of local) if (value.expiresAt <= time) local.delete(oldKey);
        if (local.size >= MAX_LOCAL_KEYS) return { unavailable: true };
      }
      record = { count: 0, expiresAt: time + windowSeconds * 1000 };
      local.set(key, record);
    }
    record.count++;
    return result(record.count, Math.max(1, Math.ceil((record.expiresAt - time) / 1000)), 'MEMORY');
  }

  function result(count, retryAfter, source) {
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfter, limit, source };
  }

  async function consume(client, ipAddress) {
    // Hash the address so the Redis key does not contain a raw client IP.
    const key = `ratelimit:${scope}:${createHash('sha256').update(ipAddress).digest('hex')}`;
    // A null client means Redis was unavailable at startup and this process
    // has always used local counters. A client that later disconnected may
    // already hold attempts in Redis; restarting locally would reset them.
    if (!client) return localAttempt(key);
    if (!client.isReady) return { unavailable: true };
    try {
      const [count, ttl] = await client.eval(INCREMENT_WITH_EXPIRY, { keys: [key], arguments: [String(windowSeconds)] });
      return result(Number(count), Math.max(1, Number(ttl)), 'REDIS');
    } catch (error) {
      console.warn(`Redis rate limit failed; blocking bookings until restart: ${error.message}`);
      client.destroy();
      return { unavailable: true };
    }
  }

  return { consume };
}

module.exports = { createBookingRateLimiter, LIMIT, WINDOW_SECONDS };
