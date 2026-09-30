const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, listMatches, listSeats, reserveSeat } = require('../db');

test('seeded match has available seats and only one reservation can own a seat', () => {
  const db = openDatabase(':memory:');
  const match = listMatches(db)[0];
  assert.equal(match.total_seats, 80);
  const seat = listSeats(db, match.id)[0];
  const booking = { matchId: match.id, seatId: seat.id, name: 'Asha', email: 'asha@example.com' };
  const first = reserveSeat(db, booking);
  assert.equal(first.status, 201);
  assert.equal(first.reservation.customer_name, 'Asha');
  assert.equal(reserveSeat(db, booking).status, 409);
  assert.equal(listSeats(db, match.id).find(item => item.id === seat.id).available, 0);
  assert.equal(listMatches(db)[0].available_seats, 79);
  db.close();
});

test('a seat cannot be reserved under a different match', () => {
  const db = openDatabase(':memory:');
  const seat = listSeats(db, 1)[0];
  assert.equal(reserveSeat(db, { matchId: 999, seatId: seat.id, name: 'Asha', email: 'asha@example.com' }).status, 404);
  db.close();
});
