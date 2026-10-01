# Cricket Match Seat Booking System — Phase 2

A small seat reservation app built with Node.js, SQLite, and Redis. SQLite is the source of truth for bookings. Redis caches match and seat availability for faster reads.

## Run

Requires Node.js 22.13 or newer. Start Redis with Docker, then install dependencies:

```powershell
docker run -d --name redis -p 6379:6379 redis
npm install
npm start
```

If the container already exists, use `docker start redis` instead of `docker run`. Open <http://localhost:3000>. The app creates `data/bookings.sqlite` and seeds one fictional match with 80 seats on first run.

If Redis is unavailable at startup, the app still serves reads from SQLite. Start Redis and restart the app to enable caching. Set `REDIS_URL` if Redis is not at `redis://localhost:6379`. Set `CACHE_TTL_SECONDS` to a whole number from 1 to 3600 to change the cache lifetime (default: 30).

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

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/matches` | List matches and availability counts |
| GET | `/api/matches/1/seats` | List seats for a match |
| POST | `/api/reservations` | Reserve a seat |

Example request:

```json
{"matchId":1,"seatId":1,"name":"Asha","email":"asha@example.com"}
```

This learning project does not have accounts, payments, rate limiting, or temporary holds yet. Cached seat availability is a display aid; SQLite decides whether a reservation succeeds.
