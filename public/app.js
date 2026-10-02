const matchesEl = document.querySelector('#matches');
const seatsEl = document.querySelector('#seats');
const form = document.querySelector('#booking-form');
const messageEl = document.querySelector('#message');
const refreshButton = document.querySelector('#refresh-button');
const holdStatusEl = document.querySelector('#hold-status');
const cancelHoldButton = document.querySelector('#cancel-hold');
let matches = [];
let currentMatch = null;
let selectedSeat = null;
let seatLoadId = 0;
let currentHold = null;
let holdBusy = false;
let bookingBusy = false;

function setHold(hold) {
  currentHold = hold;
  if (hold) sessionStorage.setItem('cricket-seat-hold', JSON.stringify(hold));
  else sessionStorage.removeItem('cricket-seat-hold');
  updateHoldStatus();
}

const money = amount => `₹${Number(amount).toLocaleString('en-IN')}`;
function message(text, kind = '') { messageEl.textContent = text; messageEl.className = kind; }
function showCache(label, response) {
  const status = response.headers.get('x-cache');
  if (!status) return;
  document.querySelector(label).textContent = `${label === '#match-cache' ? 'Matches' : 'Seats'}: ${status}`;
  const ttl = response.headers.get('x-cache-ttl-seconds');
  if (ttl) document.querySelector('#cache-explanation').textContent = `HIT = Redis · MISS = SQLite, then cached · BYPASS = SQLite without Redis · TTL = ${ttl}s`;
}
function showRateLimit(response) {
  const remaining = response.headers.get('x-ratelimit-remaining');
  if (remaining === null) return;
  const source = response.headers.get('x-ratelimit-source') === 'REDIS' ? 'Redis' : 'local fallback';
  const retry = response.headers.get('retry-after');
  document.querySelector('#rate-limit-status').textContent = retry
    ? `Booking limit reached. Try again in ${retry} seconds. Counter: ${source}.`
    : `${remaining} of 5 booking attempts left in this window. Counter: ${source}.`;
}
async function api(url, options, cacheLabel) {
  const response = await fetch(url, options);
  if (typeof cacheLabel === 'function') cacheLabel(response);
  else if (cacheLabel) showCache(cacheLabel, response);
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: response.status });
  return data;
}

function updateHoldStatus() {
  if (!currentHold) {
    holdStatusEl.textContent = 'No seat held.';
    cancelHoldButton.disabled = true;
    return;
  }
  const seconds = Math.max(0, Math.ceil((Date.parse(currentHold.expiresAt) - Date.now()) / 1000));
  holdStatusEl.textContent = `Seat held · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} remaining`;
  cancelHoldButton.disabled = false;
}

async function cancelCurrentHold() {
  if (!currentHold) return true;
  const hold = currentHold;
  try {
    const response = await fetch('/api/holds', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchId: hold.matchId, seatId: hold.seatId, token: hold.token })
    });
    if (response.status !== 204 && response.status !== 409) {
      const data = await response.json();
      throw new Error(data.error || 'Could not cancel the hold.');
    }
    if (currentHold === hold) {
      setHold(null);
      selectedSeat = null;
    }
    return true;
  } catch (error) {
    message(error.message, 'error');
    return false;
  }
}

async function loadMatches() {
  try {
    matches = (await api('/api/matches', undefined, '#match-cache')).matches;
    document.querySelector('#match-count').textContent = `${matches.length} match${matches.length === 1 ? '' : 'es'}`;
    matchesEl.replaceChildren();
    for (const match of matches) {
      const button = document.createElement('button');
      button.className = `match ${currentMatch?.id === match.id ? 'selected' : ''}`;
      button.innerHTML = `<small></small><strong></strong><small></small>`;
      button.children[0].textContent = new Date(match.starts_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
      button.children[1].textContent = `${match.home_team} vs ${match.away_team}`;
      button.children[2].textContent = `${match.venue} · ${match.available_seats}/${match.total_seats} not reserved`;
      button.addEventListener('click', () => chooseMatch(match));
      matchesEl.append(button);
    }
    if (!currentMatch && matches.length) await chooseMatch(matches.find(match => match.id === currentHold?.matchId) || matches[0]);
    return true;
  } catch (error) { message(error.message, 'error'); return false; }
}

async function chooseMatch(match) {
  if (bookingBusy && currentMatch?.id !== match.id) return false;
  if (currentHold && currentHold.matchId !== match.id && !(await cancelCurrentHold())) return false;
  const requestId = ++seatLoadId;
  currentMatch = match;
  selectedSeat = null;
  document.querySelector('#book-button').disabled = true;
  document.querySelector('#selection').textContent = 'Select a seat to hold it for five minutes.';
  document.querySelector('#match-description').textContent = `${match.home_team} vs ${match.away_team} · ${match.venue}`;
  message('');
  for (const button of matchesEl.children) button.classList.toggle('selected', button.children[1].textContent === `${match.home_team} vs ${match.away_team}`);
  seatsEl.textContent = 'Loading seats…';
  try {
    const { seats, holdsAvailable } = await api(`/api/matches/${match.id}/seats`, undefined, response => {
      if (requestId === seatLoadId) showCache('#seat-cache', response);
    });
    if (requestId !== seatLoadId) return false;
    seatsEl.replaceChildren();
    for (const sectionName of [...new Set(seats.map(seat => seat.section))]) {
      const section = document.createElement('div');
      section.className = 'section';
      const title = document.createElement('h3');
      title.textContent = `${sectionName} · ${money(seats.find(seat => seat.section === sectionName).price)}`;
      const grid = document.createElement('div');
      grid.className = 'seat-grid';
      for (const seat of seats.filter(item => item.section === sectionName)) {
        const button = document.createElement('button');
        const ownHold = seat.held && currentHold?.matchId === match.id && currentHold.seatId === seat.id && Date.parse(currentHold.expiresAt) > Date.now();
        button.className = `seat${seat.held ? ' held' : ''}${ownHold ? ' selected' : ''}`;
        button.textContent = `${seat.row_label}${seat.seat_number}`;
        button.title = `${sectionName}, row ${seat.row_label}, seat ${seat.seat_number}`;
        button.disabled = !holdsAvailable || (!seat.available && !ownHold);
        if (ownHold) {
          selectedSeat = seat;
          document.querySelector('#selection').textContent = `${sectionName} · ${seat.row_label}${seat.seat_number} · ${money(seat.price)}`;
          document.querySelector('#book-button').disabled = false;
        }
        button.addEventListener('click', () => holdSeat(match, seat));
        grid.append(button);
      }
      section.append(title, grid);
      seatsEl.append(section);
    }
    if (!holdsAvailable) message('Redis is unavailable. Start it and restart the app to hold seats.', 'error');
    return true;
  } catch (error) {
    if (requestId !== seatLoadId) return false;
    seatsEl.textContent = '';
    message(error.message, 'error');
    return false;
  }
}

async function holdSeat(match, seat) {
  if (holdBusy || bookingBusy || currentMatch?.id !== match.id) return;
  if (currentHold?.matchId === match.id && currentHold.seatId === seat.id) return;
  holdBusy = true;
  try {
    if (!(await cancelCurrentHold())) return;
    message('Holding your seat…');
    const { hold } = await api('/api/holds', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchId: match.id, seatId: seat.id })
    });
    setHold(hold);
    if (currentMatch?.id !== match.id) {
      await cancelCurrentHold();
      return;
    }
    const refreshed = await chooseMatch(match);
    message(refreshed
      ? `Seat ${seat.row_label}${seat.seat_number} is held for five minutes.`
      : `Seat ${seat.row_label}${seat.seat_number} is held, but availability could not refresh. Try checking again.`, 'success');
  } catch (error) {
    if (currentMatch?.id === match.id) await chooseMatch(match);
    message(error.message, 'error');
  } finally {
    holdBusy = false;
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentMatch || !selectedSeat || !currentHold || holdBusy || bookingBusy) return;
  bookingBusy = true;
  const button = document.querySelector('#book-button');
  button.disabled = true;
  const body = { matchId: currentMatch.id, seatId: selectedSeat.id, holdToken: currentHold.token, name: form.elements.name.value, email: form.elements.email.value };
  try {
    const { reservation } = await api('/api/reservations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, showRateLimit);
    const confirmation = `Booked! Reservation #${reservation.id}: ${reservation.section} ${reservation.row_label}${reservation.seat_number}.`;
    setHold(null);
    selectedSeat = null;
    form.reset();
    const seatRefreshOk = await chooseMatch(currentMatch);
    const matchesRefreshOk = await loadMatches();
    message(seatRefreshOk && matchesRefreshOk ? confirmation : `${confirmation} Availability could not be refreshed; reload the page.`, 'success');
  } catch (error) {
    if (error.status === 409) { setHold(null); selectedSeat = null; }
    button.disabled = false;
    await chooseMatch(currentMatch);
    message(error.message, 'error');
  } finally {
    bookingBusy = false;
  }
});

cancelHoldButton.addEventListener('click', async () => {
  if (holdBusy || bookingBusy) return;
  if (await cancelCurrentHold() && currentMatch) {
    await chooseMatch(currentMatch);
    message('Seat hold cancelled.');
  }
});

setInterval(() => {
  if (!currentHold || bookingBusy) return;
  if (Date.parse(currentHold.expiresAt) <= Date.now()) {
    setHold(null);
    selectedSeat = null;
    if (currentMatch) void chooseMatch(currentMatch).then(() => message('Your seat hold expired. Select a seat again.', 'error'));
  } else updateHoldStatus();
}, 1000);

refreshButton.addEventListener('click', async () => {
  refreshButton.disabled = true;
  try {
    const matchOk = await loadMatches();
    const latestMatch = matches.find(match => match.id === currentMatch?.id) || currentMatch;
    const seatsOk = latestMatch ? await chooseMatch(latestMatch) : true;
    if (!matchOk || !seatsOk) message('Availability could not be refreshed. Please try again.', 'error');
  } finally {
    refreshButton.disabled = false;
  }
});

async function restoreHold() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('cricket-seat-hold'));
    if (saved && Number.isSafeInteger(saved.matchId) && Number.isSafeInteger(saved.seatId) && typeof saved.token === 'string') {
      const { hold } = await api('/api/holds/check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId: saved.matchId, seatId: saved.seatId, token: saved.token })
      });
      setHold(hold);
    }
  } catch (error) {
    if (error.status !== 503) setHold(null);
  }
  await loadMatches();
}

restoreHold();
