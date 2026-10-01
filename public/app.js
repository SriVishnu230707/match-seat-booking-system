const matchesEl = document.querySelector('#matches');
const seatsEl = document.querySelector('#seats');
const form = document.querySelector('#booking-form');
const messageEl = document.querySelector('#message');
const refreshButton = document.querySelector('#refresh-button');
let matches = [];
let currentMatch = null;
let selectedSeat = null;
let seatLoadId = 0;

const money = amount => `₹${Number(amount).toLocaleString('en-IN')}`;
function message(text, kind = '') { messageEl.textContent = text; messageEl.className = kind; }
function showCache(label, response) {
  const status = response.headers.get('x-cache');
  if (!status) return;
  document.querySelector(label).textContent = `${label === '#match-cache' ? 'Matches' : 'Seats'}: ${status}`;
  const ttl = response.headers.get('x-cache-ttl-seconds');
  if (ttl) document.querySelector('#cache-explanation').textContent = `HIT = Redis · MISS = SQLite, then cached · BYPASS = SQLite without Redis · TTL = ${ttl}s`;
}
async function api(url, options, cacheLabel) {
  const response = await fetch(url, options);
  if (typeof cacheLabel === 'function') cacheLabel(response);
  else if (cacheLabel) showCache(cacheLabel, response);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
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
      button.children[2].textContent = `${match.venue} · ${match.available_seats}/${match.total_seats} available`;
      button.addEventListener('click', () => chooseMatch(match));
      matchesEl.append(button);
    }
    if (!currentMatch && matches.length) await chooseMatch(matches[0]);
    return true;
  } catch (error) { message(error.message, 'error'); return false; }
}

async function chooseMatch(match) {
  const requestId = ++seatLoadId;
  currentMatch = match;
  selectedSeat = null;
  document.querySelector('#book-button').disabled = true;
  document.querySelector('#selection').textContent = 'Select a seat to continue.';
  document.querySelector('#match-description').textContent = `${match.home_team} vs ${match.away_team} · ${match.venue}`;
  message('');
  for (const button of matchesEl.children) button.classList.toggle('selected', button.children[1].textContent === `${match.home_team} vs ${match.away_team}`);
  seatsEl.textContent = 'Loading seats…';
  try {
    const { seats } = await api(`/api/matches/${match.id}/seats`, undefined, response => {
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
        button.className = 'seat';
        button.textContent = `${seat.row_label}${seat.seat_number}`;
        button.title = `${sectionName}, row ${seat.row_label}, seat ${seat.seat_number}`;
        button.disabled = !seat.available;
        button.addEventListener('click', () => {
          seatsEl.querySelectorAll('.seat.selected').forEach(item => item.classList.remove('selected'));
          button.classList.add('selected');
          selectedSeat = seat;
          document.querySelector('#selection').textContent = `${sectionName} · ${seat.row_label}${seat.seat_number} · ${money(seat.price)}`;
          document.querySelector('#book-button').disabled = false;
          message('');
        });
        grid.append(button);
      }
      section.append(title, grid);
      seatsEl.append(section);
    }
    return true;
  } catch (error) {
    if (requestId !== seatLoadId) return false;
    seatsEl.textContent = '';
    message(error.message, 'error');
    return false;
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentMatch || !selectedSeat) return;
  const button = document.querySelector('#book-button');
  button.disabled = true;
  const body = { matchId: currentMatch.id, seatId: selectedSeat.id, name: form.elements.name.value, email: form.elements.email.value };
  try {
    const { reservation } = await api('/api/reservations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const confirmation = `Booked! Reservation #${reservation.id}: ${reservation.section} ${reservation.row_label}${reservation.seat_number}.`;
    selectedSeat = null;
    document.querySelector('#selection').textContent = 'Select another seat to continue.';
    form.reset();
    const seatRefreshOk = await chooseMatch(currentMatch);
    const matchesRefreshOk = await loadMatches();
    message(seatRefreshOk && matchesRefreshOk ? confirmation : `${confirmation} Availability could not be refreshed; reload the page.`, 'success');
  } catch (error) {
    button.disabled = false;
    await chooseMatch(currentMatch);
    message(error.message, 'error');
  }
});

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

loadMatches();
