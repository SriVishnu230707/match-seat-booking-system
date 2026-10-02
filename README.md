# Cricket Match Seat Booking System

A learning project built with Node.js, SQLite, and Redis, completed through Phase 7. It seeds one fictional India vs Australia match with 80 seats and supports accounts, temporary seat holds, confirmation retries, and booking history.

**SQLite owns the permanent records. Redis stores cached reads, expiring sessions, request counters, and temporary locks.** The browser calls the Node.js API; it never connects directly to Redis or SQLite.

## Contents

- [Run the project](#run-the-project)
- [Architecture](#architecture)
- [Redis keys and lifetimes](#redis-keys-and-lifetimes)
- [Every Redis function and its trigger](#every-redis-function-and-its-trigger)
- [Redis commands and Lua scripts](#redis-commands-and-lua-scripts)
- [Rate limits](#rate-limits)
- [What happens during a booking](#what-happens-during-a-booking)
- [Browser actions and API routes](#browser-actions-and-api-routes)
- [Learn Redis phase by phase](#learn-redis-phase-by-phase)
- [Observe Redis yourself](#observe-redis-yourself)
- [Tests](#tests)
- [Failure handling and limits](#failure-handling-and-limits)
- [Project files](#project-files)
- [Official Redis documentation](#official-redis-documentation)

## Run the project

Requires **Node.js 22.13 or newer**, npm, and a running Redis server for accounts and bookings. Run commands from the repository root.

### Windows with WSL Ubuntu and Antigravity

Redis must already be installed in WSL Ubuntu, with `redis-server` and `redis-cli` available.

~~~powershell
npm install
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-local.ps1
~~~

Open [http://localhost:3000](http://localhost:3000).

In Antigravity, open this repository and choose **Terminal → Run Task → Run booking app with local Redis**. The task runs the same script. Stop an existing app on port 3000 before starting another.

When `REDIS_URL` is unset, the script:

1. Finds the WSL Ubuntu IP address so Windows can connect even when localhost forwarding is unavailable.
2. Generates a password in ignored `data/local-redis-password` if it does not exist.
3. Checks the dedicated Redis instance on port 6380 and starts it if necessary.
4. Binds it to WSL loopback and the WSL IP, enables protected mode and password authentication, and disables Redis disk persistence.
5. Sets `REDIS_URL` for that process and starts the Node.js server.

Stopping Node.js leaves this Redis daemon running. Restarting Redis or shutting down WSL clears its temporary state, including sessions and holds. Confirmed bookings remain in SQLite. If `REDIS_URL` is already set, the script uses that Redis and skips WSL setup.

### Docker or an existing Redis server

~~~powershell
docker run -d --name redis -p 127.0.0.1:6379:6379 redis
npm install
npm start
~~~

If the container already exists, use `docker start redis`. With an existing Redis server, set its connection URL before `npm start`:

~~~powershell
$env:REDIS_URL = 'redis://localhost:6379'
npm start
~~~

### Configuration

| Setting | Default | Effect |
| --- | --- | --- |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection used by the app; the WSL launcher supplies its own URL when unset. |
| `PORT` | `3000` | HTTP server port. |
| `CACHE_TTL_SECONDS` | `30` | Cache lifetime; must be a whole number from 1 to 3600. |
| `COOKIE_SECURE` | Unset | Set to `1` for Secure session cookies when HTTPS terminates at a reverse proxy. Direct TLS also enables Secure cookies. |
| `REDIS_TEST_URL` | Unset | Connection for real Redis integration tests; without it, those tests skip. |

Rate limits, hold duration, confirmation-lock duration, and session duration are constants in the source files, rather than environment settings.

The app creates `data/bookings.sqlite` automatically. `data/` and `node_modules/` are excluded from Git.

## Architecture

GitHub renders the Mermaid diagrams below.

~~~mermaid
flowchart TD
    Browser["Browser: public/app.js<br/>Forms, seat map, countdown, sessionStorage"]
    API["Node.js HTTP API: server.js<br/>Validation, session checks, ownership, request routing"]
    Auth["auth.js<br/>Accounts and sessions"]
    Cache["cache.js<br/>Availability cache"]
    Limits["rate-limiter.js<br/>IP, account, and email counters"]
    Holds["holds.js<br/>Seat ownership and expiry"]
    Confirm["idempotency.js<br/>Confirmation lock"]
    DB["db.js<br/>Queries, migrations, reservation constraints"]
    Redis[("Redis<br/>Sessions, cache, counters, holds, locks")]
    SQLite[("SQLite: data/bookings.sqlite<br/>Users, matches, seats, reservations")]

    Browser -->|"HTTP JSON and session cookie"| API
    API --> Auth
    API --> Cache
    API --> Limits
    API --> Holds
    API --> Confirm
    API --> DB
    Auth -->|"Session GET, SET, DEL"| Redis
    Auth -->|"Create and verify users"| SQLite
    Cache -->|"GET and Lua cache scripts"| Redis
    Cache -->|"Load on miss or bypass"| DB
    Limits -->|"Lua counter script"| Redis
    Holds -->|"SET NX EX, MGET, Lua ownership scripts"| Redis
    Holds -->|"Check seat before and after acquisition"| SQLite
    Confirm -->|"SET NX EX and Lua release"| Redis
    DB --> SQLite
~~~

SQLite's unique seat and request-ID constraints enforce the lasting booking result. Redis coordinates requests while they are running. Temporary holds are read live from Redis and overlaid onto the cached SQLite seat list.

The browser stores its hold token and pending request ID in tab `sessionStorage`. Its login token is in an HttpOnly cookie. Password hashes and confirmed reservations are stored in SQLite.

## Redis keys and lifetimes

All application values are Redis strings. JavaScript serializes cached arrays as JSON strings; the project does not use the RedisJSON module.

| Key pattern | Stored value | Lifetime | Created or changed by |
| --- | --- | --- | --- |
| `matches:list` | JSON array of matches and unreserved-seat counts | 30 seconds by default | Match-list cache miss; deleted after a successful booking. |
| `matches:<matchId>:seats` | JSON array of SQLite seat availability | 30 seconds by default | Seat-list cache miss; deleted after a successful booking for that match. |
| `matches:list:version` | Integer invalidation generation | No expiry set | Incremented after a successful booking. |
| `matches:<matchId>:seats:version` | Integer invalidation generation | No expiry set | Incremented after a successful booking for that match. |
| `ratelimit:<scope>:<sha256(identity)>` | Request count | 60 seconds from the first counted attempt | A rate-limited request. Scopes are listed below. |
| `hold:<matchId>:<seatId>` | `<userId>:<holdToken>` | 300 seconds; confirmation ensures at least 60 seconds remain | Seat selection, confirmation, cancellation, or automatic expiry. |
| `confirmation:<requestId>:lock` | Random lock-owner token | 30 seconds | A new confirmation attempt; removed in its cleanup path. |
| `session:<sha256(sessionToken)>` | User ID as a string | 604800 seconds, or 7 days | Successful signup/login; deleted on logout. |

Session reads do not refresh their expiry. Redis stores the **hash of the cookie token in the key**, not the raw login token. Hold tokens and request IDs are separate values with separate purposes.

Cached match counts describe seats **not permanently reserved**; they can include seats currently held. The seat endpoint overlays holds to decide what can be selected.

## Every Redis function and its trigger

The tables map project functions to Redis calls. Follow the file links to read the actual implementation.

### Availability cache — [cache.js](cache.js)

| Function | Trigger | Redis work and result |
| --- | --- | --- |
| `connectCache()` | Server startup, before listening for HTTP requests | Creates the Node Redis client, attaches an error listener, and calls `connect()`. Uses a 1-second connection timeout and disables automatic reconnection. Returns the connected client or `null` after a failed connection. |
| `getOrLoad(client, key, load)` | `GET /api/matches` and `GET /api/matches/:id/seats` | `GET` checks the cached JSON. On a miss, `GET` reads the version, SQLite supplies the data, and `EVAL` conditionally fills the cache using `SET ... EX`. Returns `HIT`, `MISS`, or `BYPASS`. Missing matches are not cached. |
| `invalidateAvailability(client, matchId)` | Only after SQLite successfully creates a reservation, HTTP 201 | Runs one Lua script that increments both version keys and deletes the match-list and affected seat-list cache keys. A failed invalidation destroys this client's connection to avoid continuing to serve its old cache. |

Helpers: `cacheTtlSeconds()` validates configuration when the module loads; `seatsKey()` and `versionKey()` build key names. These helpers do not send Redis commands.

**Why versions exist:** a booking can invalidate availability while an earlier request is preparing a cache fill. `FILL_IF_UNCHANGED` checks the generation before writing. If it changed, the request reloads SQLite instead of restoring the old cached value. This protects cache fills; it does not make Redis and SQLite one transaction.

The API exposes `X-Cache` and `X-Cache-TTL-Seconds`. **Check availability again** repeats normal reads and can still return a cache hit.

### Rate limiter — [rate-limiter.js](rate-limiter.js)

| Function | Trigger | Redis work and result |
| --- | --- | --- |
| `createBookingRateLimiter(options)` | `createBookingServer()` creates a limiter for each scope | Builds a limiter with its limit, window, scope, and optional local counter map. Construction itself sends no Redis command. |
| `consume(client, identity)` | An API route reaches its rate-limit check | Hashes the IP, user ID, or normalized email into the key; `EVAL` atomically runs `INCR`, `EXPIRE`, and `TTL`. Returns allowed status, remaining allowance, limit, retry time, and counter source. |

Internal `localAttempt()` and `result()` maintain or format results without Redis calls. The local map is capped at 10000 identities. The limiter supports local counters when given `null`, but the current protected booking routes first require a Redis-backed session, so Redis being unavailable blocks those routes before this fallback can help.

### Temporary seat holds — [holds.js](holds.js)

| Function | Trigger | Redis work and result |
| --- | --- | --- |
| `acquireHold(client, db, matchId, seatId, userId)` | Selecting a seat sends `POST /api/holds`, after session and limiter checks | Checks SQLite, then uses `SET` with `NX: true, EX: 300` to create the seat key only if absent. Rechecks SQLite after acquisition to catch a reservation that committed during the Redis call. Returns 201, 404, 409, or 503. |
| `releaseHold(client, matchId, seatId, token, userId)` | Cancel button, switching away from a held seat/match, sign-out cancellation, a completed booking or seat conflict; also acquisition cleanup after its SQLite recheck | `EVAL` compares the complete `userId:token` value and calls `DEL` only on a match. Returns 204 when removed, 409 for an expired/different hold, or 503 for Redis failure. |
| `inspectHold(client, matchId, seatId, token, userId)` | `POST /api/holds/check` during hold restoration after reload or sign-in | `EVAL` checks ownership with `GET`, then reads `TTL`. Returns a restored hold deadline only if remaining seconds are positive. Does not renew the hold. |
| `verifyHoldForConfirmation(client, matchId, seatId, token, userId)` | A new confirmation, after the confirmation lock and another SQLite request-ID lookup | `EVAL` checks ownership and reads `TTL`; if fewer than 60 seconds remain, `EXPIRE` sets 60 seconds. This ensures a short confirmation window; it does not always add 60 seconds. |
| `decorateSeatsWithHolds(client, matchId, seats)` | Every seat-list GET after its cache/SQLite read | `mGet()` sends `MGET` for the currently unreserved seats' hold keys. Existing keys mark those seats held and unavailable. This overlay is not cached. |

Helpers: `holdKey()` builds a seat key; `ownerValue()` builds its ownership value. `seatRecord()` queries SQLite. None of these helpers sends a Redis command.

A Redis TTL expires a hold without a scheduled application job. The browser's one-second timer updates the display and refreshes seats when its deadline passes; it does not poll Redis every second.

### Confirmation coordination — [idempotency.js](idempotency.js)

| Function | Trigger | Redis work and result |
| --- | --- | --- |
| `claim(client, requestId)` | A new `POST /api/reservations` after session, initial replay lookup, counters, and field validation | `SET confirmation:<requestId>:lock <token> NX EX 30` admits one request at a time for that request ID. A competing request gets HTTP 409 with `code: PROCESSING` and `Retry-After: 1`. |
| `release(client, requestId, token)` | The confirmation handler's `finally` block after a successful claim, including error/early-return paths | `EVAL` compares the owner token and deletes only that lock. Failures are logged; the 30-second expiry is the fallback. |

The internal `keyFor()` helper builds the confirmation key without contacting Redis. **Completed results live in SQLite**, not this Redis lock. The unique request-ID index and ownership checks allow a completed retry to return the original reservation.

### Login sessions — [auth.js](auth.js)

| Function | Trigger | Redis work and result |
| --- | --- | --- |
| `createSession(client, userId)` | Successful account creation or password verification | Generates a 32-byte random token and calls `SET session:<sha256(token)> <userId> EX 604800`. The raw token is returned to the server for the cookie. Returns `null` if Redis cannot store the session. |
| `currentUser(client, db, req)` | `requireUser()` on every protected API request | Reads and validates the cookie, then `GET` retrieves the user ID. SQLite supplies the public account details. Returns 200 for a valid user, 401 for missing/expired credentials, or 503 for session infrastructure failure. |
| `deleteSession(client, token)` | Authenticated `POST /api/auth/logout` | Calls `DEL` on the hashed-token key. On success, the server sends a cookie with `Max-Age=0`. |

The internal `sessionKey()` helper hashes the token and builds the key. `readToken()`, `cookieHeader()`, `clearCookieHeader()`, and `publicUser()` handle cookies or response data without Redis commands. `hashPassword()`, `createUser()`, and `verifyUser()` use Node crypto and SQLite; passwords are not stored in Redis.

If signup saves the user but session storage fails, the API returns 503 with `accountCreated: true`. The browser switches to sign-in so the user can recover with the account that already exists.

## Redis commands and Lua scripts

### Commands used by the app

| Command / client API | Meaning here | Where used |
| --- | --- | --- |
| `GET` / `client.get()` | Read one string | Cached data, cache versions, sessions; ownership comparisons inside Lua. |
| `SET ... EX` / `client.set(..., { EX })` | Store a string with a lifetime in seconds | Cache fills inside Lua and login sessions. |
| `SET ... NX EX` / `client.set(..., { NX: true, EX })` | Create only when the key is absent, with an expiry in the same operation | Seat holds and confirmation locks. |
| `MGET` / `client.mGet()` | Read several hold keys in one request | Live seat availability overlay. |
| `INCR` inside Lua | Increase a numeric string by one | Rate counters and cache invalidation generations. |
| `EXPIRE` inside Lua | Set a key's remaining lifetime | Rate windows and the minimum confirmation hold window. |
| `TTL` inside Lua | Read remaining whole seconds | Rate retry time, hold restoration, and confirmation extension. |
| `DEL` / `client.del()` or Lua | Remove a key | Logout, cache invalidation, hold release, and confirmation-lock release. |
| `EVAL` / `client.eval()` | Execute the Lua check and update as one atomic Redis operation | Every script listed below. |

`createClient()`, `connect()`, `isReady`, `on('error')`, and `destroy()` belong to the Node Redis client's lifecycle. `destroy()` closes this connection; it does not delete Redis data.

### All Lua scripts

| Script | File | Atomic steps | Why these steps stay together |
| --- | --- | --- | --- |
| `FILL_IF_UNCHANGED` | `cache.js` | `GET` version → compare with observed version → `SET` cache with `EX` if unchanged | Prevents a fill from restoring availability invalidated while that fill was being prepared. |
| `INVALIDATE` | `cache.js` | `INCR` match version → `DEL` match cache → `INCR` seat version → `DEL` seat cache | Readers see a coordinated generation change and removal of the affected cache entries. |
| `INCREMENT_WITH_EXPIRY` | `rate-limiter.js` | `INCR` counter → `EXPIRE` if first attempt → `TTL` → repair missing expiry when needed | Avoids separate counter/expiry calls leaving an immortal counter or allowing concurrent requests through. |
| `RELEASE_IF_OWNER` | `holds.js` | `GET` ownership value → compare → `DEL` only if equal | A late cancellation cannot delete a replacement hold. |
| `EXTEND_IF_OWNER` | `holds.js` | `GET` owner → compare → `TTL` → `EXPIRE 60` only if needed | An account cannot extend another account's hold or extend a replacement using an old token. |
| `INSPECT_IF_OWNER` | `holds.js` | `GET` owner → compare → return `TTL`, otherwise -1 | Restores only a hold belonging to the signed-in account and supplied token. |
| `RELEASE_IF_OWNER` | `idempotency.js` | `GET` lock token → compare → `DEL` only if equal | An older worker cannot remove a newer worker's confirmation lock. |

Lua makes these Redis operations atomic. It does not include the SQLite write in that atomic operation.

## Rate limits

All scopes use a **60-second window starting at the first counted attempt**. This is not a sliding window or a reset at every wall-clock minute. Later requests increase the count without extending the original window.

| Scope | Identity hashed into key | Limit | Trigger |
| --- | --- | --- | --- |
| `booking` | Socket IP address | 5 | New booking-confirmation attempt. |
| `booking-user` | Signed-in user ID converted to a string | 5 | Confirmation that passed the IP check. |
| `hold` | Socket IP address | 10 | Seat-hold creation attempt. |
| `hold-user` | Signed-in user ID converted to a string | 10 | Hold creation that passed the IP check. |
| `login-ip` | Socket IP address | 5 | Login with valid input format, before password verification. |
| `login-email` | Trimmed, lowercase email | 5 | Login that passed the IP check. |
| `signup-ip` | Socket IP address | 5 | Registration with valid input format, before user creation. |

Both successful and failed credential checks consume an attempt once they reach the counter. IP and account/email checks run sequentially; a blocked IP request never reaches the second counter.

A sixth booking/login/signup attempt or an eleventh hold attempt returns **429** with `Retry-After` derived from the counter TTL. Booking responses also expose `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Source`.

A completed booking replay by its owner returns before the booking counters. Wrong content type, malformed JSON, and invalid body shape are rejected before booking counters; invalid booking fields in an otherwise valid object can consume an attempt. Hold counters run before hold-body validation. Hold inspection, cancellation, reservation status, and booking history do not have dedicated rate counters.

The app uses the socket IP and ignores untrusted `X-Forwarded-For`. People behind a shared IP share its allowance; a reverse proxy can also cause requests to share its socket-IP allowance.

## What happens during a booking

### Successful new confirmation

~~~mermaid
sequenceDiagram
    actor User
    participant UI as Browser
    participant API as server.js
    participant R as Redis
    participant DB as SQLite

    User->>UI: Sign in
    UI->>API: POST /api/auth/login
    API->>R: Increment IP and email counters
    API->>DB: Verify password hash
    API->>R: SET hashed session key EX 604800
    API-->>UI: Session cookie

    User->>UI: Select a seat
    UI->>API: POST /api/holds
    API->>R: GET session and increment hold counters
    API->>DB: Check seat is not reserved
    API->>R: SET seat hold NX EX 300
    API->>DB: Recheck seat after hold acquisition
    API-->>UI: Hold token and deadline

    User->>UI: Confirm reservation
    UI->>API: POST /api/reservations with hold token and request ID
    API->>R: GET session
    API->>DB: Look up completed request ID
    Note over API,DB: Continue here only for a new request
    API->>R: Increment IP and user booking counters
    API->>R: SET confirmation lock NX EX 30
    API->>DB: Recheck completed request ID
    API->>R: Verify hold owner and ensure at least 60 seconds remain
    API->>DB: INSERT reservation with unique seat and request ID
    API->>R: Release hold if owner matches
    API->>R: Increment cache versions and delete affected caches
    API-->>UI: HTTP 201 with reservation
    API->>R: Release confirmation lock in finally
    UI->>API: Refresh availability and booking history
~~~

### Retry and status recovery

The browser generates one UUID request ID per hold and reuses it when retrying confirmation.

1. Every protected retry still checks its Redis session.
2. SQLite is queried for that request ID before booking counters.
3. The same account, match, and seat receive the saved reservation with HTTP 200 and `replayed: true`.
4. Reusing the ID for another account or booking returns 409.
5. If another confirmation still owns the Redis lock, the API returns `PROCESSING`; retry using the same request ID.
6. After a lost response, **Check booking status** queries SQLite through `POST /api/reservations/status`. It returns a limited reservation summary only to the owning account.

Pending request IDs survive hold expiry in tab storage. The UI blocks changing seats while a confirmation is unresolved. **Discard attempt** checks status again before clearing the attempt; an earlier delayed request can still finish afterward.

## Browser actions and API routes

| User action / browser trigger | Request | Redis functions reached |
| --- | --- | --- |
| Initial page load | `GET /api/me`, then match/seat reads | `currentUser()`; `getOrLoad()`; `decorateSeatsWithHolds()`. |
| Open or refresh match list | `GET /api/matches` | `getOrLoad()`. |
| Select match or refresh seat map | `GET /api/matches/:id/seats` | `getOrLoad()`, then `decorateSeatsWithHolds()`. |
| Create account | `POST /api/auth/register` | Signup limiter `consume()`, then `createSession()` if SQLite user creation succeeds. |
| Sign in | `POST /api/auth/login` | IP/email `consume()`, then `createSession()` if password verification succeeds. |
| Sign out | `POST /api/auth/logout` | `currentUser()`, then `deleteSession()`; the UI first cancels its active hold. |
| Load My bookings | `GET /api/me/reservations` | `currentUser()`; history itself comes from SQLite. |
| Select available seat | `POST /api/holds` | `currentUser()`, IP/user `consume()`, then `acquireHold()`. |
| Restore saved hold after reload/sign-in | `POST /api/holds/check` | `currentUser()`, then `inspectHold()`; completed-status lookup happens first when a saved request ID exists. |
| Cancel hold or change held seat/match | `DELETE /api/holds` | `currentUser()`, then `releaseHold()`. |
| Confirm held seat | `POST /api/reservations` | `currentUser()`; for a new attempt: `consume()`, `claim()`, `verifyHoldForConfirmation()`, conditional `releaseHold()`/`invalidateAvailability()`, and `release()` in cleanup. |
| Check uncertain booking | `POST /api/reservations/status` | `currentUser()`; result lookup and ownership check use SQLite. |

Protected requests need the cookie from signup/login. A normal confirmation body is:

~~~json
{
  "matchId": 1,
  "seatId": 1,
  "holdToken": "token-from-the-hold-response",
  "requestId": "36d72be9-9ce7-4a47-a6c0-f21a4981576c"
}
~~~

The server takes the booking name, email, and user ID from the authenticated account. Hold requests use match/seat IDs; hold check/cancel bodies also include `token`; reservation-status requests include `requestId`.

## Learn Redis phase by phase

| Phase | Project addition | Redis concepts to learn |
| --- | --- | --- |
| 1 | Matches, seats, and SQLite reservations | Establish permanent storage and unique seat constraints before adding Redis. |
| 2 | Match and seat caching | String keys, JSON serialization, `GET`, expiring `SET`, invalidation, cache hit/miss/bypass, version checks. |
| 3 | Booking rate limits | `INCR`, `EXPIRE`, `TTL`, identity scopes, Lua atomicity, 429 responses. |
| 4 | Temporary seat holds | `SET NX EX`, ownership tokens, expiry, live `MGET` overlays, compare-and-delete scripts. |
| 5 | Safe confirmation retries | Temporary request locks, stable request IDs, token-checked release, SQLite idempotency. |
| 6 | Real Redis integration checks | Cross-process coordination, actual expiry, connection loss, namespaced test cleanup. |
| 7 | Accounts and booking ownership | Expiring Redis sessions, hashed-token keys, cookies, account/email limits, owner-restricted holds and results. |

## Observe Redis yourself

### Connect to the development instance

For Docker:

~~~powershell
docker exec -it redis redis-cli
~~~

For the WSL launcher, pass its saved password through the Redis CLI environment:

~~~powershell
$redisPassword = (Get-Content -Raw data/local-redis-password).Trim()
wsl -d Ubuntu -- env "REDISCLI_AUTH=$redisPassword" redis-cli -p 6380
~~~

Run the following commands **inside redis-cli**. Replace IDs and placeholder keys with actual values. The hold's `seatId` comes from the hold response; it is not simply the label A1.

~~~text
PING
SCAN 0 MATCH matches:* COUNT 100
GET matches:list
TTL matches:list
GET matches:list:version
GET matches:1:seats
TTL matches:1:seats

SCAN 0 MATCH ratelimit:* COUNT 100
GET ratelimit:booking:<actual-hash>
TTL ratelimit:booking:<actual-hash>

SCAN 0 MATCH hold:* COUNT 100
TTL hold:1:<actual-seat-id>

SCAN 0 MATCH confirmation:*:lock COUNT 100
TTL confirmation:<actual-request-id>:lock

SCAN 0 MATCH session:* COUNT 100
TTL session:<actual-token-hash>
~~~

`SCAN` returns a cursor and a batch of keys. Repeat with the returned cursor until it is 0 if you need the full list. `TTL` reports remaining seconds, -2 for a missing key, and -1 for a key without expiry, such as a cache version key. Confirmation locks may disappear too quickly to observe manually.

Keep cookies, hold tokens, and local Redis credentials private. Inspecting a hold with `GET` reveals its account ID and token; no raw hold or login tokens are needed for the TTL experiments above.

### Small learning experiments

1. **Cache:** click **Check availability again** twice. Observe `MISS` then `HIT`; wait beyond the cache lifetime and repeat. Automatic refreshes can refill caches before you inspect them.
2. **Hold:** sign in and select a seat. Its Redis key has a TTL near 300. A second account cannot acquire the same seat until release or expiry.
3. **Cancel:** click **Cancel hold**. Its Redis key disappears; an old token cannot delete a subsequent owner's hold.
4. **Book:** confirm a seat. SQLite saves the reservation, Redis releases the hold and invalidates availability, and UI refreshes can immediately refill the cache.
5. **Session:** sign out. That session key disappears. Reading a protected endpoint with the old cookie returns 401.
6. **Rate counter:** watch the relevant counter and TTL while making attempts. A completed booking replay does not consume a new booking attempt. The real Redis integration suite also verifies a shared counter across processes.

## Tests

~~~powershell
npm test
~~~

The current unit/API suite contains 27 tests. It covers malformed and oversized bodies, Unicode across network chunks, unsafe match IDs, cache invalidation races, concurrent confirmations, ownership, session expiry, signup recovery, rate limits, and Redis failures.

With WSL Ubuntu:

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-local.ps1 -IntegrationTest
~~~

With another disposable local Redis:

~~~powershell
$env:REDIS_TEST_URL = 'redis://localhost:6379'
npm run test:integration
~~~

The 2 integration tests exercise real expiry, competing holds, confirmation replay, Redis disconnects, and two separate Node processes sharing SQLite and Redis. They use temporary SQLite files and randomly prefixed Redis keys, remove their own test data, and do not flush Redis or insert test reservations into the app's saved database.

Without `REDIS_TEST_URL`, direct `npm run test:integration` skips rather than proving Redis behavior. The WSL launcher sets this variable when invoked with `-IntegrationTest`. Node 22 can print an experimental warning for its built-in SQLite module.

## Failure handling and limits

| Condition | Current behavior |
| --- | --- |
| Redis unavailable at startup | Match reads use SQLite with `BYPASS`. Seat responses mark selection unavailable. Signup/login return 503; protected requests with a cookie cannot validate their session. |
| Missing or expired session | Protected routes return 401. The browser returns to sign-in, including when cancelling a hold. |
| Redis connection lost later | Session, hold, limiter, or confirmation operations fail closed when unavailable. The client does not reconnect automatically; restore Redis and restart the app. |
| Cache read or fill fails | Reads can still return SQLite data; a cache-read failure reports `BYPASS`. A fill-write failure can still report `MISS` even though Redis did not retain the value. |
| Cache invalidation fails after a committed booking | The booking remains saved. This Redis client is destroyed; public reads bypass it and protected operations require a healthy session connection. Other app instances can retain older cache entries until their TTL. |
| Signup succeeds in SQLite but session write fails | The account remains created; the response explains this and the UI switches to sign-in. |
| Hold or lock cleanup fails | The TTL eventually removes the key. Cleanup failure does not undo an already committed SQLite reservation. |
| Redis restarts with the WSL launcher's persistence disabled | Cache, counters, sessions, and temporary locks are lost. SQLite users and bookings remain. |
| Multiple app processes | Shared Redis coordinates temporary state; consistent permanent results require access to the same SQLite database file. Redis alone does not synchronize separate SQLite files. |

SQLite enforces one reservation per seat, one result per non-null request ID, and a matching seat/match relationship. Redis and SQLite have no shared transaction, so availability displays are snapshots rather than a guarantee that a later selection will succeed.

Session cookies are HttpOnly and SameSite=Lax. Mutation requests with a mismatched or malformed Origin are rejected. Existing reservations from before accounts were added remain unassigned; email matching does not automatically transfer their ownership.

The project currently has no payments, password reset, email verification, automatic Redis reconnection, Redis Cluster routing, or production deployment setup. The Lua cache scripts span multiple keys without Cluster hash tags, so use the current implementation with a standalone Redis server.

## Project files

| File | Responsibility |
| --- | --- |
| [server.js](server.js) | HTTP API, validation, Redis-service orchestration, ownership checks, response headers. |
| [db.js](db.js) | SQLite schema, migrations, seed data, queries, permanent reservation constraints. |
| [cache.js](cache.js) | Redis connection, cached availability, version-based invalidation. |
| [rate-limiter.js](rate-limiter.js) | Atomic counters and scoped limits. |
| [holds.js](holds.js) | Seat acquisition, inspection, confirmation extension, release, live overlays. |
| [idempotency.js](idempotency.js) | Temporary confirmation coordination. |
| [auth.js](auth.js) | Password hashing, SQLite accounts, Redis sessions, cookie helpers. |
| [public/app.js](public/app.js) | Browser actions, API calls, account display, hold/pending restoration. |
| [public/index.html](public/index.html) | Account, match, seat, and reservation interface. |
| [scripts/start-local.ps1](scripts/start-local.ps1) | Windows/WSL Redis and app launcher. |
| [.vscode/tasks.json](.vscode/tasks.json) | Antigravity-compatible local run task. |
| [test/](test/) | Unit, API, and real Redis integration tests. |

## Official Redis documentation

Use the [complete Redis documentation](https://redis.io/docs/latest/) and the [Redis command reference](https://redis.io/docs/latest/commands/) alongside this project. The function names in this README belong to this application; the command reference explains the Redis commands they call.
