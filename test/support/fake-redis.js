function fakeRedis() {
  let time = 0;
  const entries = new Map();
  function read(key) {
    const entry = entries.get(key);
    if (entry && entry.expiresAt <= time) { entries.delete(key); return null; }
    return entry || null;
  }
  function save(key, value, seconds = Infinity) {
    entries.set(key, { value: String(value), expiresAt: time + seconds * 1000 });
  }
  return {
    isReady: true,
    advance(ms) { time += ms; },
    destroy() { this.isReady = false; },
    async get(key) { return read(key)?.value ?? null; },
    async del(key) { return entries.delete(key) ? 1 : 0; },
    async mGet(keys) { return keys.map(key => read(key)?.value ?? null); },
    async set(key, value, options) {
      if (options.NX && read(key)) return null;
      save(key, value, options.EX);
      return 'OK';
    },
    async eval(script, { keys, arguments: args }) {
      if (keys.length === 4) {
        for (let index = 0; index < 4; index += 2) {
          save(keys[index], Number(read(keys[index])?.value || 0) + 1);
          entries.delete(keys[index + 1]);
        }
        return 1;
      }
      if (keys.length === 2) {
        if ((read(keys[1])?.value || '') !== args[0]) return 0;
        save(keys[0], args[1], Number(args[2]));
        return 1;
      }
      const key = keys[0];
      if (script.includes("redis.call('INCR'")) {
        const previous = read(key);
        const count = Number(previous?.value || 0) + 1;
        const expiresAt = previous?.expiresAt ?? time + Number(args[0]) * 1000;
        entries.set(key, { value: String(count), expiresAt });
        return [count, Math.ceil((expiresAt - time) / 1000)];
      }
      const entry = read(key);
      if (!entry || entry.value !== args[0]) return script.includes('return -1') ? -1 : 0;
      if (script.includes("redis.call('DEL'")) { entries.delete(key); return 1; }
      if (script.includes("redis.call('EXPIRE'")) {
        entry.expiresAt = Math.max(entry.expiresAt, time + Number(args[1]) * 1000);
        return 1;
      }
      if (script.includes("redis.call('TTL'")) return Math.ceil((entry.expiresAt - time) / 1000);
      throw new Error('Unexpected Redis script');
    }
  };
}

module.exports = { fakeRedis };
