const { createClient } = require('redis');
const { openDatabase } = require('../../db');
const { createBookingServer } = require('../../server');

async function main() {
  const raw = createClient({ url: process.env.REDIS_TEST_URL, socket: { connectTimeout: 1000, reconnectStrategy: false } });
  raw.on('error', () => {});
  await raw.connect();
  const prefix = process.env.REDIS_TEST_PREFIX;
  const scoped = {
    get isReady() { return raw.isReady; },
    get: key => raw.get(prefix + key),
    set: (key, value, options) => raw.set(prefix + key, value, options),
    mGet: keys => raw.mGet(keys.map(key => prefix + key)),
    eval: (script, options) => raw.eval(script, { ...options, keys: options.keys.map(key => prefix + key) }),
    destroy: () => raw.destroy()
  };
  const database = openDatabase(process.env.REDIS_TEST_DB_FILE);
  const server = createBookingServer({ database, getCache: () => scoped });
  server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
  process.on('message', message => {
    if (message?.type !== 'stop') return;
    server.close(() => {
      database.close();
      raw.destroy();
      process.exit(0);
    });
  });
}

main().catch(error => { process.send({ error: error.message }); process.exitCode = 1; });
