const { randomUUID } = require('node:crypto');

const HOLD_SECONDS = 300;
const CONFIRM_SECONDS = 60;
const holdKey = (matchId, seatId) => `hold:${matchId}:${seatId}`;

const RELEASE_IF_OWNER = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;
const EXTEND_IF_OWNER = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    local ttl = redis.call('TTL', KEYS[1])
    if ttl < tonumber(ARGV[2]) then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
    return 1
  end
  return 0
`;
const INSPECT_IF_OWNER = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('TTL', KEYS[1])
  end
  return -1
`;

function seatRecord(db, matchId, seatId) {
  return db.prepare(`SELECT s.id, r.id AS reservation_id FROM seats s
    LEFT JOIN reservations r ON r.seat_id = s.id
    WHERE s.id = ? AND s.match_id = ?`).get(seatId, matchId);
}

async function acquireHold(client, db, matchId, seatId) {
  if (!client?.isReady) return { status: 503, error: 'Seat holds require Redis. Start Redis and restart the app.' };
  const seat = seatRecord(db, matchId, seatId);
  if (!seat) return { status: 404, error: 'Seat not found for this match.' };
  if (seat.reservation_id) return { status: 409, error: 'This seat is already reserved.' };
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + HOLD_SECONDS * 1000).toISOString();
  try {
    const acquired = await client.set(holdKey(matchId, seatId), token, { NX: true, EX: HOLD_SECONDS });
    if (!acquired) return { status: 409, error: 'This seat is temporarily held by another customer.' };
    // A reservation may have committed between the first SQLite check and SET.
    const latestSeat = seatRecord(db, matchId, seatId);
    if (!latestSeat || latestSeat.reservation_id) {
      await releaseHold(client, matchId, seatId, token);
      return { status: 409, error: 'This seat is already reserved.' };
    }
    return { status: 201, hold: { matchId, seatId, token, expiresAt } };
  } catch (error) {
    console.warn(`Seat hold failed: ${error.message}`);
    return { status: 503, error: 'Seat holds are temporarily unavailable.' };
  }
}

async function releaseHold(client, matchId, seatId, token) {
  if (!client?.isReady) return { status: 503, error: 'Seat holds are temporarily unavailable.' };
  try {
    const removed = await client.eval(RELEASE_IF_OWNER, { keys: [holdKey(matchId, seatId)], arguments: [token] });
    return removed ? { status: 204 } : { status: 409, error: 'This hold has expired or belongs to another request.' };
  } catch (error) {
    console.warn(`Seat hold release failed: ${error.message}`);
    return { status: 503, error: 'Seat holds are temporarily unavailable.' };
  }
}

async function verifyHoldForConfirmation(client, matchId, seatId, token) {
  if (!client?.isReady) return { status: 503, error: 'Seat holds are temporarily unavailable.' };
  try {
    const valid = await client.eval(EXTEND_IF_OWNER, {
      keys: [holdKey(matchId, seatId)], arguments: [token, String(CONFIRM_SECONDS)]
    });
    return valid ? { status: 200 } : { status: 409, error: 'Your seat hold has expired. Select the seat again.' };
  } catch (error) {
    console.warn(`Seat hold verification failed: ${error.message}`);
    return { status: 503, error: 'Seat holds are temporarily unavailable.' };
  }
}

async function inspectHold(client, matchId, seatId, token) {
  if (!client?.isReady) return { status: 503, error: 'Seat holds are temporarily unavailable.' };
  try {
    const seconds = Number(await client.eval(INSPECT_IF_OWNER, {
      keys: [holdKey(matchId, seatId)], arguments: [token]
    }));
    return seconds > 0
      ? { status: 200, hold: { matchId, seatId, token, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() } }
      : { status: 409, error: 'This seat hold has expired.' };
  } catch (error) {
    console.warn(`Seat hold inspection failed: ${error.message}`);
    return { status: 503, error: 'Seat holds are temporarily unavailable.' };
  }
}

async function decorateSeatsWithHolds(client, matchId, seats) {
  if (!client?.isReady) return { status: 200, seats: seats.map(seat => ({ ...seat, held: 0, available: 0 })), holdsAvailable: false };
  try {
    const openSeats = seats.filter(seat => seat.available);
    const values = openSeats.length ? await client.mGet(openSeats.map(seat => holdKey(matchId, seat.id))) : [];
    const heldIds = new Set(openSeats.filter((_, index) => values[index] !== null).map(seat => seat.id));
    return {
      status: 200,
      seats: seats.map(seat => ({ ...seat, held: heldIds.has(seat.id) ? 1 : 0, available: seat.available && !heldIds.has(seat.id) ? 1 : 0 })),
      holdsAvailable: true
    };
  } catch (error) {
    console.warn(`Seat hold lookup failed: ${error.message}`);
    return { status: 503, error: 'Seat availability is temporarily unavailable.' };
  }
}

module.exports = { HOLD_SECONDS, holdKey, acquireHold, releaseHold, verifyHoldForConfirmation, inspectHold, decorateSeatsWithHolds };
