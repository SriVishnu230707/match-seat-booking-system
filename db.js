const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

function openDatabase(filename = path.join(__dirname, 'data', 'bookings.sqlite')) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      venue TEXT NOT NULL,
      starts_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS seats (
      id INTEGER PRIMARY KEY,
      match_id INTEGER NOT NULL REFERENCES matches(id),
      section TEXT NOT NULL,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      price INTEGER NOT NULL CHECK (price >= 0),
      UNIQUE(match_id, section, row_label, seat_number)
    );
    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY,
      match_id INTEGER NOT NULL REFERENCES matches(id),
      seat_id INTEGER NOT NULL REFERENCES seats(id),
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(match_id, seat_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS reservations_one_per_seat ON reservations(seat_id);
    CREATE TRIGGER IF NOT EXISTS reservations_match_insert
      BEFORE INSERT ON reservations
      WHEN NOT EXISTS (SELECT 1 FROM seats WHERE id = NEW.seat_id AND match_id = NEW.match_id)
      BEGIN SELECT RAISE(ABORT, 'Seat does not belong to match'); END;
    CREATE TRIGGER IF NOT EXISTS reservations_match_update
      BEFORE UPDATE OF match_id, seat_id ON reservations
      WHEN NOT EXISTS (SELECT 1 FROM seats WHERE id = NEW.seat_id AND match_id = NEW.match_id)
      BEGIN SELECT RAISE(ABORT, 'Seat does not belong to match'); END;
  `);
  if (!db.prepare('PRAGMA table_info(reservations)').all().some(column => column.name === 'request_id')) {
    try { db.exec('ALTER TABLE reservations ADD COLUMN request_id TEXT'); }
    catch (error) {
      // A second server may have completed the migration after the PRAGMA.
      if (!db.prepare('PRAGMA table_info(reservations)').all().some(column => column.name === 'request_id')) throw error;
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS reservations_one_per_request ON reservations(request_id)');
  if (!db.prepare('PRAGMA table_info(reservations)').all().some(column => column.name === 'user_id')) {
    try { db.exec('ALTER TABLE reservations ADD COLUMN user_id INTEGER REFERENCES users(id)'); }
    catch (error) {
      if (!db.prepare('PRAGMA table_info(reservations)').all().some(column => column.name === 'user_id')) throw error;
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS reservations_by_user ON reservations(user_id, created_at)');
  if (db.prepare('SELECT COUNT(*) AS count FROM matches').get().count === 0) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Check again inside the transaction if another process seeded first.
      if (db.prepare('SELECT COUNT(*) AS count FROM matches').get().count === 0) {
        const insertMatch = db.prepare('INSERT INTO matches (home_team, away_team, venue, starts_at) VALUES (?, ?, ?, ?)');
        const insertSeat = db.prepare('INSERT INTO seats (match_id, section, row_label, seat_number, price) VALUES (?, ?, ?, ?, ?)');
        const matchId = Number(insertMatch.run('India', 'Australia', 'Wankhede Stadium, Mumbai', '2026-11-15T19:00:00+05:30').lastInsertRowid);
        for (const [section, price, rows] of [['North Stand', 1200, ['A', 'B', 'C']], ['East Stand', 1800, ['A', 'B', 'C']], ['Pavilion', 3500, ['A', 'B']]]) {
          for (const row of rows) for (let number = 1; number <= 10; number++) insertSeat.run(matchId, section, row, number, price);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return db;
}

function listMatches(db) {
  return db.prepare(`SELECT m.*, COUNT(s.id) AS total_seats,
    COUNT(s.id) - COUNT(r.id) AS available_seats
    FROM matches m LEFT JOIN seats s ON s.match_id = m.id
    LEFT JOIN reservations r ON r.seat_id = s.id
    GROUP BY m.id ORDER BY m.starts_at`).all();
}

function listSeats(db, matchId) {
  if (!db.prepare('SELECT id FROM matches WHERE id = ?').get(matchId)) return null;
  return db.prepare(`SELECT s.id, s.section, s.row_label, s.seat_number, s.price,
    CASE WHEN r.id IS NULL THEN 1 ELSE 0 END AS available
    FROM seats s LEFT JOIN reservations r ON r.seat_id = s.id
    WHERE s.match_id = ? ORDER BY s.price, s.section, s.row_label, s.seat_number`).all(matchId);
}

function reservationForRequest(db, requestId) {
  return db.prepare(`SELECT r.id, r.request_id, r.user_id, r.match_id, r.seat_id, r.created_at, r.customer_name, r.customer_email,
    s.section, s.row_label, s.seat_number, s.price, m.home_team, m.away_team, m.venue, m.starts_at
    FROM reservations r JOIN seats s ON s.id = r.seat_id JOIN matches m ON m.id = r.match_id WHERE r.request_id = ?`).get(requestId);
}

function listReservationsForUser(db, userId) {
  return db.prepare(`SELECT r.id, r.created_at, s.section, s.row_label, s.seat_number, s.price,
    m.home_team, m.away_team, m.venue, m.starts_at
    FROM reservations r JOIN seats s ON s.id = r.seat_id JOIN matches m ON m.id = r.match_id
    WHERE r.user_id = ? ORDER BY r.id DESC`).all(userId);
}

function reserveSeat(db, { matchId, seatId, name, email, requestId = null, userId = null }) {
  const seat = db.prepare('SELECT id FROM seats WHERE id = ? AND match_id = ?').get(seatId, matchId);
  if (!seat) return { status: 404, error: 'Seat not found for this match.' };
  try {
    const result = db.prepare('INSERT INTO reservations (match_id, seat_id, customer_name, customer_email, request_id, user_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(matchId, seatId, name, email, requestId, userId);
    return { status: 201, reservation: db.prepare(`SELECT r.id, r.request_id, r.user_id, r.match_id, r.seat_id, r.created_at, r.customer_name, r.customer_email,
      s.section, s.row_label, s.seat_number, s.price, m.home_team, m.away_team, m.venue, m.starts_at
      FROM reservations r JOIN seats s ON s.id = r.seat_id JOIN matches m ON m.id = r.match_id WHERE r.id = ?`)
      .get(Number(result.lastInsertRowid)) };
  } catch (error) {
    if (error.code === 'ERR_SQLITE_ERROR' && error.message.startsWith('UNIQUE constraint failed: reservations.')) return { status: 409, error: 'This seat has already been reserved.' };
    throw error;
  }
}

module.exports = { openDatabase, listMatches, listSeats, reserveSeat, reservationForRequest, listReservationsForUser };
