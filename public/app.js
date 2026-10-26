// app.js: browser logic for skyledger — seat map, booking actions, polling of
// tables and logs, SQL box. Plain functions, no framework, talks to /api/*.
'use strict';

const state = {
  flights: [],
  flightId: null,
  seatId: null,          // selected seat (free or booked)
  selectedBookingId: null,
  passengers: [],
  tableTab: 'bookings',
  logTab: 'audit',
  auditSince: 0,
  prevRows: new Map(),   // table row key -> JSON text, for the flash comparison
};

const $ = (id) => document.getElementById(id);

// One fetch wrapper: every API error becomes a thrown {code, message}.
async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json();
  if (!body.ok) throw Object.assign(new Error(body.message || 'request failed'), { code: body.code });
  return body;
}

const post = (path, data) => api(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(data),
});

function showError(id, e) {
  const el = $(id);
  el.textContent = e.code ? `[${e.code}] ${e.message}` : e.message;
}

// ---------- flights, passengers, seat map ----------

async function loadFlights() {
  const body = await api('/api/flights');
  state.flights = body.rows;
  const sel = $('flight-select');
  sel.textContent = '';
  for (const f of state.flights) {
    const o = document.createElement('option');
    o.value = f.flight_id;
    o.textContent = `${f.flight_no}  ${f.origin_code}-${f.dest_code}  ${f.departs_at}`;
    sel.appendChild(o);
  }
  state.flightId = state.flights[0] ? state.flights[0].flight_id : null;
  await refreshSeatMap();
}

async function loadPassengers() {
  const body = await api('/api/table/passengers');
  state.passengers = body.rows;
  const sel = $('passenger-select');
  sel.textContent = '';
  for (const p of state.passengers) {
    const o = document.createElement('option');
    o.value = p.passenger_id;
    o.textContent = `${p.name}  ${p.email}`;
    sel.appendChild(o);
  }
}

// Seat map: booked seats show an X and strikethrough (not colour-only) and
// carry an aria-label; clicking a booked seat selects it for cancellation.
async function refreshSeatMap() {
  if (state.flightId == null) return;
  const body = await api(`/api/flights/${state.flightId}/seats`);
  const map = $('seat-map');
  map.textContent = '';
  for (const s of body.rows) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seat ' + (s.booking_id ? 'booked' : 'free');
    b.setAttribute('aria-label', s.booking_id
      ? `Seat ${s.seat_no}, booked by ${s.passenger_name}`
      : `Seat ${s.seat_no}, free, ${s.class}, fare ${s.fare}`);
    if (s.booking_id) { b.title = `booked by ${s.passenger_name}`; }
    // the X sits in its own span so the strikethrough only hits the seat number
    const x = document.createElement('span');
    x.className = 'seatx';
    x.textContent = s.booking_id ? 'X ' : '';
    const label = document.createElement('span');
    label.className = 'slabel';
    label.textContent = s.seat_no;
    b.appendChild(x);
    b.appendChild(label);
    if (s.seat_id === state.seatId) b.classList.add(s.booking_id ? 'selected' : 'freesel');
    b.addEventListener('click', () => selectSeat(s));
    map.appendChild(b);
  }
}

// One seat selected at a time: free seat = bookable, booked seat = cancellable.
function selectSeat(s) {
  state.seatId = s.seat_id;
  state.selectedBookingId = s.booking_id || null;
  $('btn-cancel').disabled = !state.selectedBookingId;
  refreshSeatMap();
}

// ---------- booking actions ----------

async function runBook(forceFail) {
  $('book-error').textContent = '';
  try {
    const body = await post('/api/book', {
      flight_id: state.flightId,
      seat_id: state.seatId,
      passenger_id: Number($('passenger-select').value),
      baggage_kg: Number($('baggage-kg').value) || 0,
      fail_at: forceFail ? $('fail-at').value : null,
    });
    renderTrace(body.trace);
    await refreshAfterAction();
  } catch (e) {
    if (e.trace) renderTrace(e.trace);
    showError('book-error', e);
    await refreshAfterAction();
  }
}

async function runCancel() {
  $('book-error').textContent = '';
  try {
    const body = await post(`/api/cancel/${state.selectedBookingId}`);
    renderTrace(body.trace);
    state.selectedBookingId = null;
    state.seatId = null;
    $('btn-cancel').disabled = true;
    await refreshAfterAction();
  } catch (e) {
    if (e.trace) renderTrace(e.trace);
    showError('book-error', e);
    await refreshAfterAction();
  }
}

// After any action the tables, seat map and audit log may all have moved.
async function refreshAfterAction() {
  await Promise.all([refreshSeatMap(), refreshTable()]);
  if (state.logTab === 'audit') await pollAudit();
}

// ---------- concept demos ----------

async function runConceptDemo(type) {
  $('concept-error').textContent = '';
  try {
    const body = await post('/api/constraint-demo', { type });
    const line = body.code === 'NO_ERROR' || body.code === 'NO_BOOKINGS'
      ? `${type}: ${body.message}`
      : `${type}: MySQL error [${body.code} / SQLSTATE ${body.sqlState}] ${body.message}`;
    renderTrace([{ ts: nowTs(), actor: 'DB', step: line, status: body.code === 'NO_ERROR' ? 'OK' : 'ERROR' }]);
    $('concept-error').textContent = line;
  } catch (e) { showError('concept-error', e); }
}

// A vs B on the same seat: A wins, B waits on the row lock and then fails.
async function runIsolationDemo() {
  $('concept-error').textContent = '';
  if (state.seatId == null || state.selectedBookingId != null) {
    $('concept-error').textContent = 'select a FREE seat in the seat map first';
    return;
  }
  try {
    const body = await post('/api/isolation-demo', {
      flight_id: state.flightId,
      seat_id: state.seatId,
      passenger_id: Number($('passenger-select').value),
    });
    renderTrace(body.trace);
    await refreshAfterAction();
  } catch (e) {
    if (e.trace) renderTrace(e.trace);
    showError('concept-error', e);
    await refreshAfterAction();
  }
}

// Normalization buttons load the anomaly queries into the SQL box; the user
// runs them and sees what the flat table does (or refuses to do).
const NORM_QUERIES = {
  update: "UPDATE unnormalized_bookings SET passenger_email = 'asha.verma@newmail.com' WHERE booking_no = 'BK-1001';",
  insert: "INSERT INTO unnormalized_bookings (booking_no, flight_no, origin_city, dest_city, seat_no, fare, payment_status)\nVALUES ('BK-1011', 'SK303', 'Delhi', 'Chennai', '1A', 5000.00, 'PENDING');",
  delete: 'DELETE FROM unnormalized_bookings WHERE flight_no = \'SK202\';',
};

function loadNormalizationQuery(kind) {
  $('sql-input').value = NORM_QUERIES[kind] + "\n\n-- then check: SELECT * FROM unnormalized_bookings;";
  $('sql-input').focus();
}

// ---------- tables (center) ----------

const TABLE_TABS = [
  'bookings', 'payments', 'baggage', 'seats', 'passengers', 'flights',
  'airports', 'audit_log', 'unnormalized_bookings', 'bookings_1nf', 'bookings_2nf', 'bookings_3nf',
];

function renderTableTabs() {
  const nav = $('table-tabs');
  for (const t of TABLE_TABS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t;
    b.setAttribute('aria-pressed', String(t === state.tableTab));
    b.addEventListener('click', () => { state.tableTab = t; renderTableTabs(); refreshTable(); });
    nav.appendChild(b);
  }
}

// Render the active table; rows that appeared or changed since the last poll
// get the 150ms flash.
async function refreshTable() {
  $('table-error').textContent = '';
  try {
    const body = await api(`/api/table/${state.tableTab}`);
    const table = $('data-table');
    table.textContent = '';
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    for (const c of body.columns) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = c;
      trh.appendChild(th);
    }
    thead.appendChild(trh);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const row of body.rows) {
      const key = String(row[body.columns[0]]);
      const json = JSON.stringify(row);
      const tr = document.createElement('tr');
      if (!state.prevRows.has(key) || state.prevRows.get(key) !== json) tr.className = 'flash';
      state.prevRows.set(key, json);
      for (const c of body.columns) {
        const td = document.createElement('td');
        td.textContent = row[c] == null ? 'NULL' : String(row[c]);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  } catch (e) {
    state.prevRows.clear();
    showError('table-error', e);
  }
}

// ---------- logs (right) ----------

function setLogTab(tab) {
  state.logTab = tab;
  for (const b of $('log-tabs').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.log === tab));
  }
  $('audit-list').hidden = tab !== 'audit';
  $('general-list').hidden = tab !== 'general';
  $('trace-list').hidden = tab !== 'trace';
}

function nowTs() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w, '0');
  return `${p(d.getHours(), 2)}:${p(d.getMinutes(), 2)}:${p(d.getSeconds(), 2)}.${p(d.getMilliseconds(), 3)}`;
}

function logItem(text, status, tsText, flash) {
  const li = document.createElement('li');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = tsText;
  const s = document.createElement('span');
  s.className = 'status-' + status.toLowerCase();
  s.textContent = status;
  li.appendChild(t);
  li.appendChild(s);
  li.appendChild(document.createTextNode(' ' + text));
  if (flash) li.className = 'flash';
  return li;
}

// Audit log: poll only rows newer than the last one we saw (since=<id>).
async function pollAudit() {
  try {
    const body = await api(`/api/logs/audit?since=${state.auditSince}`);
    const list = $('audit-list');
    for (const r of body.rows) {
      const detail = r.new_data ? JSON.stringify(r.new_data) : JSON.stringify(r.old_data);
      const text = `${r.action} ${r.table_name} row ${r.row_id} ${detail}`;
      // every audit row is a change that actually happened, so status is OK
      list.prepend(logItem(text, 'OK', r.logged_at, true));
      state.auditSince = Math.max(state.auditSince, r.log_id);
    }
    while (list.children.length > 200) list.removeChild(list.lastChild);
  } catch (e) { /* the audit panel stays as-is on a failed poll */ }
}

// General log: newest 30 statements MySQL itself recorded for our user.
async function pollGeneral() {
  try {
    const body = await api('/api/logs/general');
    const list = $('general-list');
    list.textContent = '';
    if (!body.enabled) {
      list.appendChild(logItem('general log is OFF — enable with SET GLOBAL general_log = "ON"', 'OK', '--', false));
      return;
    }
    for (const r of body.rows) {
      list.appendChild(logItem(`${r.command_type} ${r.argument}`, 'OK', r.event_time, false));
    }
  } catch (e) {
    const list = $('general-list');
    list.textContent = '';
    list.appendChild(logItem(e.message, 'ERROR', '--', false));
  }
}

// Transaction trace: the ordered steps of the last action, newest at the top.
function renderTrace(trace) {
  const list = $('trace-list');
  list.textContent = '';
  const items = trace.slice().reverse();
  for (const s of items) {
    const text = `${s.actor ? s.actor + ' ' : ''}${s.step}`;
    list.appendChild(logItem(text, s.status || 'OK', s.ts, false));
  }
}

// ---------- SQL box ----------

async function runQuery() {
  $('sql-error').textContent = '';
  const sql = $('sql-input').value.trim();
  if (!sql) return;
  try {
    const body = await post('/api/query', { sql });
    const table = $('sql-table');
    table.textContent = '';
    if (body.columns && body.columns.length) {
      const thead = document.createElement('thead');
      const trh = document.createElement('tr');
      for (const c of body.columns) {
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = c;
        trh.appendChild(th);
      }
      thead.appendChild(trh);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      for (const row of body.rows) {
        const tr = document.createElement('tr');
        for (const c of body.columns) {
          const td = document.createElement('td');
          td.textContent = row[c] == null ? 'NULL' : String(row[c]);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    } else {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.textContent = `OK, affected rows: ${body.affectedRows}`;
      tr.appendChild(td);
      table.appendChild(tr);
    }
    await refreshAfterAction();
  } catch (e) {
    $('sql-table').textContent = '';
    showError('sql-error', e);
  }
}

// ---------- top bar ----------

async function checkHealth() {
  try {
    await api('/api/health');
    $('db-status').textContent = 'connected';
  } catch (e) {
    $('db-status').textContent = 'not connected';
  }
}

async function resetDemo() {
  $('book-error').textContent = '';
  try {
    await post('/api/reset', {});
    state.auditSince = 0;
    state.prevRows.clear();
    state.seatId = null;
    state.selectedBookingId = null;
    $('btn-cancel').disabled = true;
    await loadFlights();
    await refreshAfterAction();
  } catch (e) { showError('book-error', e); }
}

// ---------- wiring ----------

function pollEverything() {
  refreshTable();
  if (state.logTab === 'audit') pollAudit();
  if (state.logTab === 'general') pollGeneral();
  checkHealth();
}

function init() {
  $('flight-select').addEventListener('change', (e) => {
    state.flightId = Number(e.target.value);
    state.seatId = null;
    state.selectedBookingId = null;
    $('btn-cancel').disabled = true;
    refreshSeatMap();
  });
  $('btn-book').addEventListener('click', () => runBook(false));
  $('btn-book-fail').addEventListener('click', () => runBook(true));
  $('btn-cancel').addEventListener('click', runCancel);
  $('btn-isolation').addEventListener('click', runIsolationDemo);
  $('btn-run').addEventListener('click', runQuery);
  $('btn-reset').addEventListener('click', resetDemo);
  for (const b of document.querySelectorAll('button[data-demo]')) {
    b.addEventListener('click', () => runConceptDemo(b.dataset.demo));
  }
  for (const b of document.querySelectorAll('button[data-norm]')) {
    b.addEventListener('click', () => loadNormalizationQuery(b.dataset.norm));
  }
  for (const b of $('log-tabs').querySelectorAll('button')) {
    b.addEventListener('click', () => setLogTab(b.dataset.log));
  }
  renderTableTabs();
  loadFlights();
  loadPassengers();
  refreshTable();
  pollAudit();
  checkHealth();
  setInterval(pollEverything, 2000);
}

init();
