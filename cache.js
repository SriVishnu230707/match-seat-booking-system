const { createClient } = require('redis');

const TTL_SECONDS = 30;
const MATCHES_KEY = 'matches:list';
const seatsKey = matchId => `matches:${matchId}:seats`;

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
  try {
    const cached = await client.get(key);
    if (cached !== null) return { value: JSON.parse(cached), cache: 'HIT' };
  } catch (error) {
    console.warn(`Redis read failed for ${key}: ${error.message}`);
    return { value: load(), cache: 'BYPASS' };
  }
  const value = load();
  // A missing match is not useful to cache: it may be created later.
  if (value !== null) {
    try { await client.set(key, JSON.stringify(value), { EX: TTL_SECONDS }); }
    catch (error) { console.warn(`Redis write failed for ${key}: ${error.message}`); }
  }
  return { value, cache: 'MISS' };
}

async function invalidateAvailability(client, matchId) {
  if (!client?.isReady) return;
  try { await client.del([MATCHES_KEY, seatsKey(matchId)]); }
  catch (error) { console.warn(`Redis invalidation failed: ${error.message}`); }
}

module.exports = { connectCache, getOrLoad, invalidateAvailability, MATCHES_KEY, seatsKey, TTL_SECONDS };
