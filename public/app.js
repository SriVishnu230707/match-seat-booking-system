const matchesEl = document.querySelector('#matches');
const seatsEl = document.querySelector('#seats');
const form = document.querySelector('#booking-form');
const messageEl = document.querySelector('#message');
const refreshButton = document.querySelector('#refresh-button');
const holdStatusEl = document.querySelector('#hold-status');
const cancelHoldButton = document.querySelector('#cancel-hold');
const checkBookingButton = document.querySelector('#check-booking');
const discardPendingButton = document.querySelector('#discard-pending');
const authForm = document.querySelector('#auth-form');
const authAction = document.querySelector('#auth-action');
const authNameLabel = document.querySelector('#auth-name-label');
const authMessageEl = document.querySelector('#auth-message');
let matches = [];
let currentUser = null;
let currentMatch = null;
let selectedSeat = null;
let seatLoadId = 0;
let currentHold = null;
let holdBusy = false;
let bookingBusy = false;
let statusBusy = false;
let pendingBooking = null;

function setUser(user) {
  currentUser = user;
  authForm.hidden = Boolean(user);
  document.querySelector('#account-profile').hidden = !user;
  document.querySelector('#account-name').textContent = user ? `${user.name} · ${user.email}` : '';
  form.elements.name.value = user?.name || '';
  form.elements.email.value = user?.email || '';
  if (!user) {
    document.querySelector('#my-bookings').textContent = '';
    document.querySelector('#book-button').disabled = true;
    seatsEl.querySelectorAll('.seat').forEach(button => { button.disabled = true; });
  }
}

async function loadMyBookings() {
  if (!currentUser) return;
  const user = currentUser;
  try {
    const { reservations } = await api('/api/me/reservations');
    if (currentUser !== user) return;
    const container = document.querySelector('#my-bookings');
    container.replaceChildren();
    if (!reservations.length) container.textContent = 'No bookings yet.';
    for (const reservation of reservations) {
      const row = document.createElement('div');
      row.className = 'booking-item';
      row.textContent = `#${reservation.id} · ${reservation.home_team} vs ${reservation.away_team} · ${reservation.section} ${reservation.row_label}${reservation.seat_number}`;
      container.append(row);
    }
  } catch (error) { if (currentUser === user) document.querySelector('#my-bookings').textContent = error.message; }
}

authAction.addEventListener('change', () => {
  const registering = authAction.value === 'register';
  authNameLabel.hidden = !registering;
  authForm.elements.name.required = registering;
  authForm.elements.password.autocomplete = registering ? 'new-password' : 'current-password';
});

authForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = authForm.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const registering = authAction.value === 'register';
    const { user } = await api(registering ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: authForm.elements.name.value, email: authForm.elements.email.value, password: authForm.elements.password.value })
    });
    authForm.reset();
    authAction.dispatchEvent(new Event('change'));
    setUser(user);
    authMessageEl.textContent = `Signed in as ${user.name}.`;
    await restoreHold();
    await loadMyBookings();
  } catch (error) {
    if (error.accountCreated) {
      authAction.value = 'login';
      authAction.dispatchEvent(new Event('change'));
    }
    authMessageEl.textContent = error.message;
  }
  finally { button.disabled = false; }
});

document.querySelector('#sign-out').addEventListener('click', async () => {
  if (bookingBusy || statusBusy || holdBusy || pendingBooking) {
    authMessageEl.textContent = 'Check or discard the pending booking before signing out.';
    return;
  }
  if (currentHold && !(await cancelCurrentHold())) return;
  try {
    await api('/api/auth/logout', { method: 'POST' });
    setUser(null);
    setHold(null);
    selectedSeat = null;
    authMessageEl.textContent = 'Signed out.';
    if (currentMatch) await chooseMatch(currentMatch);
  } catch (error) { authMessageEl.textContent = error.message; }
});

function setPending(booking) {
  pendingBooking = booking;
  if (booking) sessionStorage.setItem('cricket-pending-booking', JSON.stringify(booking));
  else sessionStorage.removeItem('cricket-pending-booking');
  checkBookingButton.hidden = !booking;
  discardPendingButton.hidden = !booking;
}

async function checkPendingBooking() {
  if (!pendingBooking || statusBusy || bookingBusy || holdBusy) return false;
  statusBusy = true;
  checkBookingButton.disabled = true;
  try {
    const { reservation } = await api('/api/reservations/status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: pendingBooking.requestId })
    });
    setPending(null);
    setHold(null);
    selectedSeat = null;
    form.reset();
    setUser(currentUser);
    if (currentMatch) await chooseMatch(currentMatch);
    await loadMatches();
    await loadMyBookings();
    message(`Booked! Reservation #${reservation.id}: ${reservation.section} ${reservation.row_label}${reservation.seat_number}.`, 'success');
    return true;
  } catch (error) {
    if (error.status === 404) {
      message('No completed reservation yet. You can retry this confirmation or discard the attempt.', 'error');
      return false;
    }
    message(error.message, 'error');
    return null;
  } finally {
    statusBusy = false;
    checkBookingButton.disabled = false;
  }
}

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
  const retry = response.status === 429 ? response.headers.get('retry-after') : null;
  document.querySelector('#rate-limit-status').textContent = retry
    ? `Booking limit reached. Try again in ${retry} seconds. Counter: ${source}.`
    : `${remaining} of 5 booking attempts left in this window. Counter: ${source}.`;
}
async function api(url, options, cacheLabel) {
  const response = await fetch(url, options);
  if (typeof cacheLabel === 'function') cacheLabel(response);
  else if (cacheLabel) showCache(cacheLabel, response);
  const data = await response.json();
  if (response.status === 401 && url !== '/api/auth/login' && url !== '/api/auth/register') setUser(null);
  if (!response.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: response.status, code: data.code, accountCreated: data.accountCreated });
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
    if (response.status === 401) setUser(null);
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
  if ((bookingBusy || statusBusy) && currentMatch?.id !== match.id) return false;
  if (pendingBooking && currentMatch && currentMatch.id !== match.id) {
    message('Check or discard the previous booking attempt before changing matches.', 'error');
    return false;
  }
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
        button.disabled = !currentUser || !holdsAvailable || (!seat.available && !ownHold);
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
    if (!currentUser) message('Sign in to hold a seat.');
    else if (!holdsAvailable) message('Redis is unavailable. Start it and restart the app to hold seats.', 'error');
    return true;
  } catch (error) {
    if (requestId !== seatLoadId) return false;
    seatsEl.textContent = '';
    message(error.message, 'error');
    return false;
  }
}

async function holdSeat(match, seat) {
  if (!currentUser) return;
  if (holdBusy || bookingBusy || statusBusy || currentMatch?.id !== match.id) return;
  if (pendingBooking) {
    message('Check the previous booking status before selecting another seat.', 'error');
    return;
  }
  if (currentHold?.matchId === match.id && currentHold.seatId === seat.id) return;
  holdBusy = true;
  try {
    if (!(await cancelCurrentHold())) return;
    message('Holding your seat…');
    const { hold } = await api('/api/holds', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchId: match.id, seatId: seat.id })
    });
    setHold({ ...hold, requestId: crypto.randomUUID(), userId: currentUser.id });
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
  if (!currentUser || !currentMatch || !selectedSeat || !currentHold || holdBusy || bookingBusy || statusBusy) return;
  bookingBusy = true;
  const button = document.querySelector('#book-button');
  button.disabled = true;
  const body = { matchId: currentMatch.id, seatId: selectedSeat.id, holdToken: currentHold.token, requestId: currentHold.requestId, userId: currentUser.id, name: currentUser.name, email: currentUser.email };
  setPending(body);
  setHold({ ...currentHold, pending: { name: body.name, email: body.email } });
  try {
    const { reservation } = await api('/api/reservations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, showRateLimit);
    const confirmation = `Booked! Reservation #${reservation.id}: ${reservation.section} ${reservation.row_label}${reservation.seat_number}.`;
    setHold(null);
    setPending(null);
    selectedSeat = null;
    form.reset();
    setUser(currentUser);
    const seatRefreshOk = await chooseMatch(currentMatch);
    const matchesRefreshOk = await loadMatches();
    await loadMyBookings();
    message(seatRefreshOk && matchesRefreshOk ? confirmation : `${confirmation} Availability could not be refreshed; reload the page.`, 'success');
  } catch (error) {
    if (error.code === 'HOLD_EXPIRED' || error.code === 'SEAT_RESERVED') {
      setHold(null);
      setPending(null);
      selectedSeat = null;
      await chooseMatch(currentMatch);
    } else {
      button.disabled = false;
    }
    message(error.status ? error.message : 'Confirmation response was lost. Retry with the same request ID to check the booking.', 'error');
  } finally {
    bookingBusy = false;
  }
});

cancelHoldButton.addEventListener('click', async () => {
  if (holdBusy || bookingBusy || statusBusy) return;
  if (pendingBooking) {
    message('Check the booking status before cancelling this hold.', 'error');
    return;
  }
  if (await cancelCurrentHold() && currentMatch) {
    await chooseMatch(currentMatch);
    message('Seat hold cancelled.');
  }
});

checkBookingButton.addEventListener('click', () => { void checkPendingBooking(); });

discardPendingButton.addEventListener('click', async () => {
  if (!pendingBooking || statusBusy || bookingBusy || holdBusy) return;
  const result = await checkPendingBooking();
  if (result !== false) return;
  setPending(null);
  if (currentHold) setHold({ ...currentHold, requestId: crypto.randomUUID(), pending: undefined });
  message('Attempt discarded. A delayed earlier request could still finish; check your booking before selecting another seat.', 'error');
});

setInterval(() => {
  if (!currentHold || bookingBusy || statusBusy) return;
  if (Date.parse(currentHold.expiresAt) <= Date.now()) {
    setHold(null);
    selectedSeat = null;
    if (currentMatch) void chooseMatch(currentMatch).then(() => message(pendingBooking
      ? 'Your hold expired. Check booking status before selecting another seat.'
      : 'Your seat hold expired. Select a seat again.', 'error'));
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
  let completed = null;
  if (!currentUser) { await loadMatches(); return; }
  try {
    const pending = JSON.parse(sessionStorage.getItem('cricket-pending-booking'));
    if (pending?.userId === currentUser.id && pending?.requestId) setPending(pending);
    else if (pending) setPending(null);
    const saved = JSON.parse(sessionStorage.getItem('cricket-seat-hold'));
    if (saved && saved.userId !== currentUser.id) setHold(null);
    const ownSaved = saved?.userId === currentUser.id ? saved : null;
    const requestId = pendingBooking?.requestId || ownSaved?.requestId;
    if (requestId) {
      try {
        completed = (await api('/api/reservations/status', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId })
        })).reservation;
      } catch (error) { if (error.status !== 404) throw error; }
    }
    if (completed) {
      setHold(null);
      setPending(null);
    }
    if (!completed && ownSaved && Number.isSafeInteger(ownSaved.matchId) && Number.isSafeInteger(ownSaved.seatId) && typeof ownSaved.token === 'string') {
      try {
        const { hold } = await api('/api/holds/check', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ matchId: ownSaved.matchId, seatId: ownSaved.seatId, token: ownSaved.token })
        });
        setHold({ ...hold, requestId: ownSaved.requestId || crypto.randomUUID(), userId: currentUser.id, pending: ownSaved.pending });
      } catch (error) {
        if (error.status !== 503) setHold(null);
      }
    }
  } catch (error) {
    message(error.message, 'error');
  }
  currentMatch = null;
  await loadMatches();
  if (completed) message(`Booked! Reservation #${completed.id}: ${completed.section} ${completed.row_label}${completed.seat_number}.`, 'success');
  else if (pendingBooking && !currentHold) message('Confirmation status is uncertain. Check booking status before selecting another seat.', 'error');
}

async function bootstrap() {
  try {
    const { user } = await api('/api/me');
    setUser(user);
    await restoreHold();
    await loadMyBookings();
  } catch (error) {
    if (error.status !== 401) authMessageEl.textContent = error.message;
    await loadMatches();
  }
}

bootstrap();
