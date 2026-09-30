# Cricket Match Seat Booking System — Phase 1

A small, working seat reservation app. It uses Node.js and SQLite with no npm dependencies. **Redis is intentionally introduced in later phases**; this phase establishes the booking flow and database guarantee that Redis cannot replace.

## Run

Requires Node.js 22.13 or newer.

```powershell
npm start
```

Open <http://localhost:3000>. The app creates `data/bookings.sqlite` and seeds one match with 80 seats on first run. The sample match is fictional. To reset local data, stop the server and remove the `data` folder.

```powershell
npm test
```

Node 22 currently labels its built-in SQLite module experimental, so it may print an experimental warning. No external SQLite package is required.

## Phase 1 features

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

This is a learning project: it has no accounts, payments, or temporary seat holds yet. Those are separate steps in the project plan.
