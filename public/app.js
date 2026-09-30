const matchesEl = document.querySelector('#matches');
const seatsEl = document.querySelector('#seats');
const form = document.querySelector('#booking-form');
const messageEl = document.querySelector('#message');
let matches = [];
let currentMatch = null;
let selectedSeat = null;

const money = amount => `₹${Number(amount).toLocaleString('en-IN')}`;
function message(text, kind = '') { messageEl.textContent = text; messageEl.className = kind; }
async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

async function loadMatches() {
  try {
    matches = (await api('/api/matches')).matches;
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
  } catch (error) { message(error.message, 'error'); }
}

async function chooseMatch(match) {
  currentMatch = match;
  selectedSeat = null;
  document.querySelector('#book-button').disabled = true;
  document.querySelector('#selection').textContent = 'Select a seat to continue.';
  document.querySelector('#match-description').textContent = `${match.home_team} vs ${match.away_team} · ${match.venue}`;
  message('');
  for (const button of matchesEl.children) button.classList.toggle('selected', button.children[1].textContent === `${match.home_team} vs ${match.away_team}`);
  seatsEl.textContent = 'Loading seats…';
  try {
    const { seats } = await api(`/api/matches/${match.id}/seats`);
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
  } catch (error) { seatsEl.textContent = ''; message(error.message, 'error'); }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentMatch || !selectedSeat) return;
  const button = document.querySelector('#book-button');
  button.disabled = true;
  const body = { matchId: currentMatch.id, seatId: selectedSeat.id, name: form.elements.name.value, email: form.elements.email.value };
  try {
    const { reservation } = await api('/api/reservations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    message(`Booked! Reservation #${reservation.id}: ${reservation.section} ${reservation.row_label}${reservation.seat_number}.`, 'success');
    selectedSeat = null;
    document.querySelector('#selection').textContent = 'Select another seat to continue.';
    const match = currentMatch;
    currentMatch = null;
    await loadMatches();
    await chooseMatch(match);
    message(`Booked! Reservation #${reservation.id}: ${reservation.section} ${reservation.row_label}${reservation.seat_number}.`, 'success');
  } catch (error) {
    message(error.message, 'error');
    button.disabled = false;
    await chooseMatch(currentMatch);
    message(error.message, 'error');
  }
});

loadMatches();
