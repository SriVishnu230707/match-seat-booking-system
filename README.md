# Cricket Match Seat Booking System — Phase 4

A small seat reservation app built with Node.js, SQLite, and Redis. SQLite stores confirmed bookings. Redis caches availability, limits requests, and holds seats temporarily during checkout.

## Run

Requires Node.js 22.13 or newer. Start Redis with Docker, then install dependencies:

```powershell
docker run -d --name redis -p 6379:6379 redis
npm install
npm start
```

If the container already exists, use `docker start redis` instead of `docker run`. Open <http://localhost:3000>. The app creates `data/bookings.sqlite` and seeds one fictional match with 80 seats on first run.

If Redis is unavailable at startup, match reads still use SQLite and rate limiting uses a local counter, but **new seat holds and confirmations are unavailable**. Start Redis and restart the app. Set `REDIS_URL` if Redis is not at `redis://localhost:6379`. Set `CACHE_TTL_SECONDS` to a whole number from 1 to 3600 to change the cache lifetime (default: 30).

```powershell
npm test
```

Node 22 may print an experimental warning for its built-in SQLite module.

## Phase 2 caching

- `GET /api/matches` caches its result at `matches:list`.
- `GET /api/matches/:id/seats` caches its result at `matches:<id>:seats`.
- Both keys expire after 30 seconds (`SET ... EX 30`).
- A successful reservation is saved in SQLite first, then deletes both affected cache keys (`DEL`).
- A version check prevents an older in-flight read from repopulating a key after booking invalidation.
- If invalidation fails, this app instance bypasses Redis until restart. Existing keys still have a 30-second maximum lifetime.
- Read responses include `X-Cache: MISS`, `HIT`, or `BYPASS` so you can observe the behavior.
- Read responses also include `X-Cache-TTL-Seconds`. The page shows both cache states and lets you repeat the availability request with **Check availability again**. This button does not skip Redis; a hit is expected while the key is alive.

Try the cache manually:

```powershell
docker exec -it redis redis-cli
GET matches:list
TTL matches:list
GET matches:1:seats
```

Visit or refresh the app before running `GET`: the app fills each key on the first request. Reserve a seat and check that the keys disappear. The next read fills them with updated availability.

For a quick experiment, start the app with a 10-second lifetime:

```powershell
$env:CACHE_TTL_SECONDS = '10'
npm start
```

Click **Check availability again** twice, wait 10 seconds, then click again. The page should show `MISS`, `HIT`, then `MISS` when Redis is running.

## Booking features

- Lists matches and available seat counts.
- Shows seats grouped by section, with price and reserved status.
- Accepts customer name and email to reserve a selected seat.
- Stores reservations permanently in SQLite.
- Enforces `UNIQUE(match_id, seat_id)` in the database. If two users try to book the same seat, one succeeds and the other receives HTTP 409.

## Phase 3 rate limiting

- `POST /api/reservations` allows 5 attempts per client IP in a 60-second window. Invalid requests also count.
- Redis stores `ratelimit:booking:<hashed IP>` and atomically increments the counter and sets its expiry with a Lua script. This prevents concurrent requests from escaping the limit.
- The sixth attempt receives HTTP 429, a `Retry-After` header, and a clear message. The page shows remaining attempts and whether Redis or the local fallback counted them.
- The server uses the socket address rather than an untrusted `X-Forwarded-For` header. Users sharing a public IP also share the limit. A future login system can provide a better identity.
- If Redis was unavailable at startup, this single app process uses a bounded in-memory counter. Its limit is **not shared across multiple server processes**; run Redis for a shared limit. If an established Redis connection fails later, bookings return HTTP 503 until restart so an attacker cannot gain a fresh local allowance.

To inspect a Redis counter after making a booking attempt, use `SCAN 0 MATCH ratelimit:booking:*` in `redis-cli`, then `GET` and `TTL` with the returned key. The key contains a hash of the IP address.

## Phase 4 temporary seat holds

- Selecting an available seat calls `POST /api/holds`. Redis atomically creates `hold:<matchId>:<seatId>` with `SET ... NX EX 300`. A competing request receives HTTP 409.
- The page shows a five-minute countdown and can cancel the hold. It stores the hold token in tab session storage, then checks the token with Redis after a page refresh.
- `GET /api/matches/:id/seats` overlays **live Redis hold state** onto the SQLite seat list. The cached SQLite list never includes temporary holds, so expiration does not require cache invalidation.
- `POST /api/reservations` requires a live hold token. The server verifies and briefly extends that token before writing to SQLite. SQLite's unique seat constraint still prevents duplicate confirmed bookings.
- Cancelling or finishing a hold uses a Redis script that deletes the key only when its token matches. A late cancellation cannot delete someone else's newer hold.
- Hold creation is limited to 10 attempts per IP per minute; booking confirmation keeps its 5-attempt limit.
- Redis and SQLite cannot commit as one transaction. Holds provide a checkout window; SQLite is the final authority. This project has no payment flow yet.

To inspect a hold, run `GET hold:1:1` and `TTL hold:1:1` in `redis-cli` after selecting seat ID 1. Treat the returned token as private.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/matches` | List matches and availability counts |
| GET | `/api/matches/1/seats` | List seats for a match |
| POST | `/api/holds` | Hold a seat for five minutes |
| POST | `/api/holds/check` | Check ownership and remaining hold time |
| DELETE | `/api/holds` | Cancel a hold using its token |
| POST | `/api/reservations` | Confirm a held seat |

Example request:

```json
{"matchId":1,"seatId":1,"holdToken":"token-from-the-hold-response","name":"Asha","email":"asha@example.com"}
```

This learning project does not have accounts or payments yet. The hold token is a bearer token; anyone with it can act on that hold. SQLite decides whether a reservation succeeds.
