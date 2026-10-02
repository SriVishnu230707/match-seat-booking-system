const { randomUUID } = require('node:crypto');

const LOCK_SECONDS = 30;
const keyFor = requestId => `confirmation:${requestId}:lock`;
const RELEASE_IF_OWNER = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

async function claim(client, requestId) {
  if (!client?.isReady) return { status: 503, error: 'Booking confirmation requires Redis.' };
  const token = randomUUID();
  try {
    const acquired = await client.set(keyFor(requestId), token, { NX: true, EX: LOCK_SECONDS });
    return acquired ? { status: 200, token } : { status: 409, error: 'This confirmation is still processing. Retry with the same request ID.' };
  } catch (error) {
    console.warn(`Confirmation claim failed: ${error.message}`);
    return { status: 503, error: 'Booking confirmation is temporarily unavailable.' };
  }
}

async function release(client, requestId, token) {
  if (!client?.isReady) return;
  try {
    await client.eval(RELEASE_IF_OWNER, { keys: [keyFor(requestId)], arguments: [token] });
  } catch (error) {
    console.warn(`Confirmation claim release failed: ${error.message}`);
  }
}

module.exports = { claim, release };
