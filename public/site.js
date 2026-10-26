// site.js: passenger-facing booking site — pick a flight, pick a seat in the
// cabin map, add a passenger, confirm the booking. The checkout shows the real
// transaction trace from the API, so the "website" and the DBMS teaching view
// stay one system.
'use strict';

const site = {
  view: 'console',
  flights: [],
  flightId: null,
  flight: null,
  seat: null,          // selected seat object from /api/flights/:id/seats
  passengers: [],
  paxId: null,
  tripsPaxId: null,
};

const $s = (id) => document.getElementById(id);

// Same error contract as app.js: non-ok API answers become thrown errors.
async function jfetch(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json();
  if (!body.ok) throw Object.assign(new Error(body.message || 'request failed'), { code: body.code });
  return body;
}

const jpost = (path, data) => jfetch(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(data),
});

// ---------- view switcher ----------

function setView(view) {
  site.view = view;
  const isSite = view === 'site';
  $s('site-view').hidden = !isSite;
  $s('layout').hidden = isSite;
  for (const b of $s('view-switch').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.view === view));
  }
}

// ---------- step 1: flights ----------

async function loadSiteFlights() {
  const body = await jfetch('/api/flights');
  site.flights = body.rows;
  const list = $s('flight-list');
  list.textContent = '';
  for (const f of site.flights) {
    const li = document.createElement('li');
    li.dataset.flightId = String(f.flight_id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'flight-row' + (f.flight_id === site.flightId ? ' sel' : '');
    btn.setAttribute('aria-label', `Flight ${f.flight_no}, ${f.origin_city} to ${f.dest_city}, departs ${f.departs_at}, from ${f.min_fare}, ${f.free_seats} seats free`);
    const no = document.createElement('span');
    no.className = 'fno';
    no.textContent = f.flight_no;
    const route = document.createElement('span');
    route.className = 'route';
    route.textContent = `${f.origin_city} (${f.origin_code}) to ${f.dest_city} (${f.dest_code})`;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `departs ${f.departs_at.slice(0, 16)} · from ${f.min_fare} · ${f.free_seats} free`;
    btn.appendChild(no);
    btn.appendChild(route);
    btn.appendChild(meta);
    btn.addEventListener('click', () => selectSiteFlight(f.flight_id));
    li.appendChild(btn);
    list.appendChild(li);
  }
  if (site.flightId == null && site.flights[0]) await selectSiteFlight(site.flights[0].flight_id);
}

async function selectSiteFlight(flightId) {
  site.flightId = flightId;
  site.flight = site.flights.find((f) => f.flight_id === flightId) || null;
  site.seat = null;
  for (const li of $s('flight-list').querySelectorAll('li[data-flight-id]')) {
    const btn = li.querySelector('.flight-row');
    btn.classList.toggle('sel', Number(li.dataset.flightId) === flightId);
  }
  await loadCabin();
  updateSummary();
}

// ---------- step 2: cabin seat map ----------

// Rows 1-6, letters A-D, built from live seat data; business seats get a
// darker border, booked seats an X plus strikethrough (never colour-only).
async function loadCabin() {
  if (site.flightId == null) return;
  const body = await jfetch(`/api/flights/${site.flightId}/seats`);
  const rows = {};
  for (const s of body.rows) {
    const m = s.seat_no.match(/^(\d+)([A-Z])$/);
    if (!m) continue;
    (rows[m[1]] = rows[m[1]] || []).push(s);
  }
  const map = $s('cabin-map');
  map.textContent = '';
  const fares = {};
  for (const s of body.rows) fares[s.class] = s.fare;
  $s('cabin-legend').textContent =
    `BUSINESS ${fares.BUSINESS || '—'} · ECONOMY ${fares.ECONOMY || '—'} · dark border = business`;
  for (const rowNo of Object.keys(rows).sort((a, b) => a - b)) {
    const div = document.createElement('div');
    div.className = 'cabin-row';
    const label = document.createElement('span');
    label.className = 'rowno';
    label.textContent = rowNo;
    div.appendChild(label);
    for (const letter of ['A', 'B', 'C', 'D']) {
      // dashed aisle between B and C, like a real cabin
      if (letter === 'C') {
        const aisle = document.createElement('span');
        aisle.className = 'aisle';
        aisle.setAttribute('aria-hidden', 'true');
        div.appendChild(aisle);
      }
      const s = rows[rowNo].find((x) => x.seat_no === rowNo + letter);
      if (!s) continue;
      const b = document.createElement('button');
      b.type = 'button';
      const booked = s.booking_id != null;
      b.className = 'seat ' + (booked ? 'booked' : 'free') + (s.class === 'BUSINESS' ? ' biz' : '');
      b.setAttribute('aria-label', booked
        ? `Seat ${s.seat_no}, booked by ${s.passenger_name}`
        : `Seat ${s.seat_no}, free, ${s.class}, fare ${s.fare}`);
      const x = document.createElement('span');
      x.className = 'seatx';
      x.textContent = booked ? 'X ' : '';
      const labelEl = document.createElement('span');
      labelEl.className = 'slabel';
      labelEl.textContent = s.seat_no;
      b.appendChild(x);
      b.appendChild(labelEl);
      if (booked) b.title = `booked by ${s.passenger_name}`;
      if (site.seat && s.seat_id === site.seat.seat_id) b.classList.add('freesel');
      b.addEventListener('click', () => selectCabinSeat(s));
      div.appendChild(b);
    }
    map.appendChild(div);
  }
}

function selectCabinSeat(s) {
  if (s.booking_id != null) {
    $s('pax-error').textContent = `seat ${s.seat_no} is already booked by ${s.passenger_name}`;
    return;
  }
  $s('pax-error').textContent = '';
  site.seat = s;
  loadCabin();  // re-render to move the selection outline
  updateSummary();
}

// ---------- step 3: passenger + baggage ----------

async function loadSitePassengers() {
  const body = await jfetch('/api/table/passengers');
  site.passengers = body.rows;
  for (const selId of ['site-passenger', 'site-trips-pax']) {
    const sel = $s(selId);
    const current = sel.value;
    sel.textContent = '';
    for (const p of site.passengers) {
      const o = document.createElement('option');
      o.value = p.passenger_id;
      o.textContent = `${p.name}  ${p.email}`;
      sel.appendChild(o);
    }
    if (current) sel.value = current;
  }
  if (site.paxId == null && site.passengers[0]) site.paxId = site.passengers[0].passenger_id;
  if (site.tripsPaxId == null && site.passengers[0]) site.tripsPaxId = site.passengers[0].passenger_id;
  $s('site-passenger').value = String(site.paxId);
  $s('site-trips-pax').value = String(site.tripsPaxId);
}

async function addPassenger() {
  $s('np-error').textContent = '';
  try {
    const body = await jpost('/api/passengers', {
      name: $s('np-name').value,
      email: $s('np-email').value,
      phone: $s('np-phone').value,
    });
    await loadSitePassengers();
    site.paxId = body.row.passenger_id;
    $s('site-passenger').value = String(site.paxId);
    $s('np-name').value = '';
    $s('np-email').value = '';
    $s('np-phone').value = '';
    $s('new-pax').open = false;
    updateSummary();
  } catch (e) {
    $s('np-error').textContent = e.code ? `[${e.code}] ${e.message}` : e.message;
  }
}

// ---------- checkout ----------

function updateSummary() {
  const f = site.flight, s = site.seat;
  const kg = Number($s('site-baggage').value) || 0;
  $s('sum-flight').textContent = f ? `${f.flight_no} ${f.origin_code}-${f.dest_code} ${f.departs_at.slice(0, 16)}` : '—';
  $s('sum-seat').textContent = s ? `${s.seat_no} (${s.class})` : '—';
  $s('sum-fare').textContent = s ? s.fare : '—';
  $s('sum-bag').textContent = kg > 0 ? `${kg} kg = ${kg * 50}.00` : 'none';
  const total = s ? Number(s.fare) + kg * 50 : null;
  $s('sum-total').textContent = total != null ? total.toFixed(2) : '—';
  $s('site-book').disabled = !(f && s && site.paxId);
}

// Confirm booking: one API call that runs the ONE transaction on the server;
// its step list is rendered as the trace next to the button.
async function siteBook() {
  $s('site-error').textContent = '';
  $s('site-ticket').hidden = true;
  $s('site-book').disabled = true;
  const kg = Number($s('site-baggage').value) || 0;
  try {
    const body = await jpost('/api/book', {
      flight_id: site.flightId,
      seat_id: site.seat.seat_id,
      passenger_id: site.paxId,
      baggage_kg: kg,
    });
    renderSiteTrace(body.trace);
    await showTicket(body.booking_id);
  } catch (e) {
    if (e.trace) renderSiteTrace(e.trace);
    $s('site-error').textContent = e.code ? `[${e.code}] ${e.message}` : e.message;
  }
  site.seat = null;
  await loadCabin();
  await loadTrips();
  updateSummary();
  $s('site-book').disabled = !(site.flight && site.seat && site.paxId);
}

async function showTicket(bookingId) {
  // Read back the committed rows: the ticket is built from the database, not
  // from what the browser hoped happened.
  const body = await jfetch(`/api/bookings?passenger_id=${site.paxId}`);
  const row = body.rows.find((r) => r.booking_id === bookingId);
  if (!row) return;
  $s('tkt-id').textContent = '#' + row.booking_id;
  $s('tkt-flight').textContent = `${row.flight_no} seat ${row.seat_no}`;
  $s('tkt-seat').textContent = row.seat_no;
  const p = site.passengers.find((x) => x.passenger_id === site.paxId);
  $s('tkt-pax').textContent = p ? p.name : ('passenger ' + site.paxId);
  const total = Number(row.amount) + Number(row.baggage_fee);
  const totalEl = $s('tkt-total');
  totalEl.textContent = total.toFixed(2) + '  ';
  const badge = document.createElement('span');
  badge.className = 'badge b-' + (row.payment_status === 'PAID' ? 'ok' : 'err');
  badge.textContent = row.payment_status;
  totalEl.appendChild(badge);
  $s('site-ticket').hidden = false;
}

// ---------- my trips ----------

async function loadTrips() {
  $s('trips-error').textContent = '';
  if (site.tripsPaxId == null) return;
  try {
    const body = await jfetch(`/api/bookings?passenger_id=${site.tripsPaxId}`);
    const list = $s('site-trips');
    list.textContent = '';
    if (!body.rows.length) {
      const li = document.createElement('li');
      li.textContent = 'no bookings yet';
      list.appendChild(li);
      return;
    }
    for (const r of body.rows) {
      const li = document.createElement('li');
      const line = document.createElement('span');
      line.className = 'trip-line';
      line.textContent = `#${r.booking_id}  ${r.flight_no} ${r.seat_no}`;
      const badge = document.createElement('span');
      badge.className = 'badge b-' + (r.status === 'CONFIRMED' ? 'ok' : 'err');
      badge.textContent = r.status;
      const amt = document.createElement('span');
      amt.className = 'trip-amt';
      amt.textContent = (Number(r.amount) + Number(r.baggage_fee)).toFixed(2);
      li.appendChild(line);
      li.appendChild(badge);
      li.appendChild(amt);
      if (r.status === 'CONFIRMED') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'danger-text';
        btn.textContent = 'Cancel';
        btn.setAttribute('aria-label', `Cancel booking ${r.booking_id}`);
        btn.addEventListener('click', () => cancelTrip(r.booking_id));
        li.appendChild(btn);
      }
      list.appendChild(li);
    }
  } catch (e) {
    $s('trips-error').textContent = e.message;
  }
}

async function cancelTrip(bookingId) {
  $s('trips-error').textContent = '';
  try {
    const body = await jpost(`/api/cancel/${bookingId}`);
    renderSiteTrace(body.trace);
  } catch (e) {
    if (e.trace) renderSiteTrace(e.trace);
    $s('trips-error').textContent = e.code ? `[${e.code}] ${e.message}` : e.message;
  }
  await loadTrips();
  if (site.flightId != null) await loadCabin();
}

// ---------- site-side transaction trace ----------

function renderSiteTrace(trace) {
  const list = $s('site-trace-list');
  list.textContent = '';
  for (const s of trace.slice().reverse()) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = s.ts;
    const st = document.createElement('span');
    st.className = 'status-' + (s.status || 'OK').toLowerCase();
    st.textContent = s.status || 'OK';
    li.appendChild(t);
    li.appendChild(st);
    li.appendChild(document.createTextNode(` ${s.actor ? s.actor + ' ' : ''}${s.step}`));
    list.appendChild(li);
  }
}

// ---------- wiring ----------

function initSite() {
  for (const b of $s('view-switch').querySelectorAll('button')) {
    b.addEventListener('click', () => setView(b.dataset.view));
  }
  $s('site-passenger').addEventListener('change', (e) => { site.paxId = Number(e.target.value); updateSummary(); });
  $s('site-trips-pax').addEventListener('change', (e) => { site.tripsPaxId = Number(e.target.value); loadTrips(); });
  $s('site-baggage').addEventListener('input', updateSummary);
  $s('btn-add-pax').addEventListener('click', addPassenger);
  $s('site-book').addEventListener('click', siteBook);
  setView('console');
  loadSiteFlights();
  loadSitePassengers();
  loadTrips();
}

initSite();

// the console view also needs to know when a passenger was added here
window.addEventListener('skyledger:passengers-changed', () => {
  if (typeof loadPassengers === 'function') loadPassengers();
});
