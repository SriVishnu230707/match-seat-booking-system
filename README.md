# Cricket Match Seat Booking System — Phase 7

A small seat reservation app built with Node.js, SQLite, and Redis. SQLite stores users and confirmed bookings. Redis caches availability, stores login sessions, limits requests, holds seats temporarily, and coordinates confirmation retries.

## Run

Requires Node.js 22.13 or newer. Start Redis with Docker, then install dependencies:

```powershell
docker run -d --name redis -p 6379:6379 redis
npm install
npm start
```

If the container already exists, use `docker start redis` instead of `docker run`. Open <http://localhost:3000>. The app creates `data/bookings.sqlite` and seeds one fictional match with 80 seats on first run.

If Redis is unavailable at startup, public match reads still use SQLite, but **sign-in, seat holds, and confirmations are unavailable**. Start Redis and restart the app. Set `REDIS_URL` if Redis is not at `redis://localhost:6379`. Set `CACHE_TTL_SECONDS` to a whole number from 1 to 3600 to change the cache lifetime (default: 30). For HTTPS behind a reverse proxy, set `COOKIE_SECURE=1` so session cookies carry the Secure attribute.

```powershell
npm test
```

To run the real Redis integration suite, start a disposable Redis instance and set `REDIS_TEST_URL`. The suite prefixes every Redis key with a random test namespace and removes those keys afterward; it does not flush the database.

```powershell
# In a separate terminal, when Redis is installed in WSL Ubuntu:
wsl -d Ubuntu -- redis-server --bind 127.0.0.1 --port 6380 --save "" --appendonly no

# Back in the project terminal:
$env:REDIS_TEST_URL = 'redis://127.0.0.1:6380'
npm run test:integration
```

If Redis is already running elsewhere, point `REDIS_TEST_URL` at that local test instance instead. Do not use a production Redis URL for tests.

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
- Requires an account to hold and reserve a seat; the account supplies the booking name and email.
- Stores reservations permanently in SQLite.
- Enforces `UNIQUE(match_id, seat_id)` in the database. If two users try to book the same seat, one succeeds and the other receives HTTP 409.

## Phase 3 rate limiting

- `POST /api/reservations` allows 5 new attempts per client IP **and account** in a 60-second window. Valid retries by the owning account return the saved result without consuming another attempt. Malformed JSON and requests with the wrong content type are rejected before the counter.
- Redis stores `ratelimit:booking:<hashed IP>` and atomically increments the counter and sets its expiry with a Lua script. This prevents concurrent requests from escaping the limit.
- The sixth attempt receives HTTP 429, a `Retry-After` header, and a clear message. The page shows remaining attempts and whether Redis or the local fallback counted them.
- The server uses the socket address rather than an untrusted `X-Forwarded-For` header. Users sharing a public IP share the IP limit; signed-in accounts also have their own limit.
- If Redis was unavailable at startup, this single app process uses a bounded in-memory counter. Its limit is **not shared across multiple server processes**; run Redis for a shared limit. If an established Redis connection fails later, bookings return HTTP 503 until restart so an attacker cannot gain a fresh local allowance.

To inspect a Redis counter after making a booking attempt, use `SCAN 0 MATCH ratelimit:booking:*` in `redis-cli`, then `GET` and `TTL` with the returned key. The key contains a hash of the IP address.

## Phase 4 temporary seat holds

- Selecting an available seat calls `POST /api/holds`. Redis atomically creates `hold:<matchId>:<seatId>` with `SET ... NX EX 300`. A competing request receives HTTP 409.
- The page shows a five-minute countdown and can cancel the hold. It stores the hold token in tab session storage, then checks the token with Redis after a page refresh.
- `GET /api/matches/:id/seats` overlays **live Redis hold state** onto the SQLite seat list. The cached SQLite list never includes temporary holds, so expiration does not require cache invalidation.
- `POST /api/reservations` requires a live hold token. The server verifies and briefly extends that token before writing to SQLite. SQLite's unique seat constraint still prevents duplicate confirmed bookings.
- Cancelling or finishing a hold uses a Redis script that deletes the key only when its token matches. A late cancellation cannot delete someone else's newer hold.
- Hold creation is limited to 10 attempts per IP and account per minute; booking confirmation keeps its 5-attempt IP and account limits.
- Redis and SQLite cannot commit as one transaction. Holds provide a checkout window; SQLite is the final authority. This project has no payment flow yet.

To inspect a hold, run `GET hold:1:1` and `TTL hold:1:1` in `redis-cli` after selecting seat ID 1. The stored value binds the token to the account ID; treat it as private.

## Phase 5 safe confirmation retries

- The browser creates one UUID request ID per hold and reuses it for every confirmation retry. It saves the pending request separately from the seat hold in tab session storage, so the request ID survives hold expiry and a refresh can recover the outcome.
- SQLite stores the request ID with the confirmed reservation and enforces uniqueness. A retry returns the original reservation with HTTP 200 and `replayed: true`; a different booking using the same ID receives HTTP 409.
- Redis uses `SET confirmation:<requestId>:lock <token> NX EX 30` to coordinate confirmations in flight. A second request receives HTTP 409 with `code: PROCESSING` and can retry. A token-checked script releases the lock; expiry handles a crashed worker.
- SQLite's unique indexes remain the final protection if a Redis lock expires during a slow request or several server processes race. The completed result stays in SQLite; the API requires a working Redis session to retrieve it.
- On page refresh, the browser checks the saved request ID for a completed reservation before trying to restore the seat hold. The **Check booking status** button can repeat that check after an uncertain response. While an attempt is unresolved, the page prevents another seat selection from overwriting its request ID. **Discard attempt** checks status once more before clearing it; a delayed server request could still finish afterward. Keep the request ID private: it can retrieve a limited confirmation summary in this learning app.

To inspect a confirmation lock while a request is in flight, use `SCAN 0 MATCH confirmation:*:lock`, then `TTL` on the returned key. Normal confirmations may finish too quickly to observe the key manually.

## Phase 6 real Redis reliability checks

- `npm test` runs the fast unit and API tests using the Redis test double. `npm run test:integration` uses an actual Redis server and a temporary SQLite database.
- The integration suite checks competing holds, real key expiry, shared availability, confirmation and replay across two app instances, and Redis disconnection. It also starts two separate Node processes to verify one reservation and a shared booking rate limit.
- Confirmed bookings remain in SQLite after Redis disconnects. Account endpoints and new holds return HTTP 503 until a healthy Redis connection is available. The running app does not reconnect automatically; restart it after restoring Redis.
- The test suite does not modify `data/bookings.sqlite`. Temporary SQLite files and namespaced Redis test keys are cleaned up after the run.

## Phase 7 accounts and ownership

- Register or sign in with an email and password. SQLite stores users and salted `scrypt` password hashes. Existing reservations remain intact but are not automatically assigned to an account by matching email.
- Redis stores a random session token for seven days. The browser receives it in an `HttpOnly`, `SameSite=Lax` cookie; `COOKIE_SECURE=1` adds `Secure` for HTTPS deployments. Signing out deletes the Redis session.
- Holds store the account ID with the token. Only that account can check, cancel, or confirm its hold. Reservation status, completed retries, and **My bookings** are restricted to the account that booked the seat.
- Redis keeps separate IP and account counters for holds and booking confirmations. Sign-in attempts are limited by IP and normalized email; registration is limited by IP. These checks use the same atomic Redis counter script as earlier phases.
- Cross-origin mutation requests are rejected when an `Origin` header does not match the request host. The app also sends basic browser security headers. Deploy behind HTTPS for real users; this project still has no password reset, email verification, or payment flow.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/matches` | List matches and availability counts |
| GET | `/api/matches/1/seats` | List seats for a match |
| POST | `/api/auth/register` | Create an account and session |
| POST | `/api/auth/login` | Sign in |
| POST | `/api/auth/logout` | Sign out |
| GET | `/api/me` | Current account |
| GET | `/api/me/reservations` | Current account's bookings |
| POST | `/api/holds` | Hold a seat for five minutes |
| POST | `/api/holds/check` | Check ownership and remaining hold time |
| DELETE | `/api/holds` | Cancel a hold using its token |
| POST | `/api/reservations/status` | Recover a completed confirmation by request ID |
| POST | `/api/reservations` | Confirm a held seat |

Example request:

```json
{"matchId":1,"seatId":1,"holdToken":"token-from-the-hold-response","requestId":"36d72be9-9ce7-4a47-a6c0-f21a4981576c"}
```

Send the session cookie from sign-in with protected requests. Redis checks the account's session and hold ownership; SQLite decides whether a reservation succeeds.
