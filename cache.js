const { createClient } = require('redis');

function cacheTtlSeconds(raw = process.env.CACHE_TTL_SECONDS) {
  if (raw === undefined) return 30;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 3600) throw new Error('CACHE_TTL_SECONDS must be an integer from 1 to 3600.');
  return value;
}
const TTL_SECONDS = cacheTtlSeconds();
const MATCHES_KEY = 'matches:list';
const seatsKey = matchId => `matches:${matchId}:seats`;
const versionKey = key => `${key}:version`;
const FILL_IF_UNCHANGED = `
  if (redis.call('GET', KEYS[2]) or '') ~= ARGV[1] then return 0 end
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
`;
const INVALIDATE = `
  redis.call('INCR', KEYS[1])
  redis.call('DEL', KEYS[2])
  redis.call('INCR', KEYS[3])
  redis.call('DEL', KEYS[4])
  return 1
`;

async function connectCache() {
  const client = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    socket: { connectTimeout: 1000, reconnectStrategy: false }
  });
  client.on('error', error => console.warn(`Redis: ${error.message}`));
  try {
    await client.connect();
    console.log('Redis connected');
    return client;
  } catch {
    console.warn('Redis unavailable; serving reads directly from SQLite. Restart after starting Redis.');
    client.destroy();
    return null;
  }
}

async function getOrLoad(client, key, load) {
  if (!client?.isReady) return { value: load(), cache: 'BYPASS' };
  let version;
  try {
    const cached = await client.get(key);
    if (cached !== null) return { value: JSON.parse(cached), cache: 'HIT' };
    version = (await client.get(versionKey(key))) || '';
  } catch (error) {
    console.warn(`Redis read failed for ${key}: ${error.message}`);
    return { value: load(), cache: 'BYPASS' };
  }
  const value = load();
  // A missing match is not useful to cache: it may be created later.
  if (value !== null) {
    try {
      const written = await client.eval(FILL_IF_UNCHANGED, {
        keys: [key, versionKey(key)], arguments: [version, JSON.stringify(value), String(TTL_SECONDS)]
      });
      // A booking invalidated the key while SQLite was being read. Reload instead
      // of returning the now-stale value; a later request can refill the cache.
      if (!written) return { value: load(), cache: 'BYPASS' };
    }
    catch (error) { console.warn(`Redis write failed for ${key}: ${error.message}`); }
  }
  return { value, cache: 'MISS' };
}

async function invalidateAvailability(client, matchId) {
  if (!client) return;
  if (!client.isReady) {
    client.destroy();
    return;
  }
  const seatKey = seatsKey(matchId);
  try {
    await client.eval(INVALIDATE, { keys: [versionKey(MATCHES_KEY), MATCHES_KEY, versionKey(seatKey), seatKey], arguments: [] });
  }
  catch (error) {
    console.warn(`Redis invalidation failed; bypassing cache until restart: ${error.message}`);
    client.destroy();
  }
}

module.exports = { connectCache, getOrLoad, invalidateAvailability, MATCHES_KEY, seatsKey, TTL_SECONDS, cacheTtlSeconds };
