// server.js: Express routes for the skyledger demo — booking as one
// transaction, constraint and isolation demos, table views, raw SQL, logs.
// The MySQL pool and helpers live in db.js.
const express = require('express');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { pool, TABLE_SQL, dbError, ts, sleep } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// One booking as ONE transaction: lock the seat row, insert booking, payment,
// and optional baggage, then commit. failAt throws mid-way to demo ROLLBACK.
// WHY the lock: two clerks booking the same seat serialise at SELECT FOR UPDATE,
// so the trigger check and the insert see a stable world.
async function bookSeat(conn, o, trace, actor = 'APP') {
  const step = (text, status) => trace.push({ ts: ts(), actor, step: text, status: status || 'OK' });
  await conn.beginTransaction();
  step('BEGIN');
  const [seat] = await conn.query(
    'SELECT seat_id, flight_id, seat_no, fare FROM seats WHERE seat_id = ? FOR UPDATE', [o.seatId]);
  if (!seat.length) { const e = new Error('Seat not found'); e.code = 'SEAT_NOT_FOUND'; throw e; }
  if (seat[0].flight_id !== o.flightId) { const e = new Error('Seat is not on this flight'); e.code = 'SEAT_FLIGHT_MISMATCH'; throw e; }
  step(`SELECT seat ${seat[0].seat_no} FOR UPDATE -> row lock held`);
  const [b] = await conn.query(
    "INSERT INTO bookings (flight_id, seat_id, passenger_id, status) VALUES (?, ?, ?, 'CONFIRMED')",
    [o.flightId, o.seatId, o.passengerId]);
  step(`INSERT bookings -> booking_id ${b.insertId}`);
  if (o.failAt === 'booking') { const e = new Error('Forced failure after booking insert'); e.code = 'FORCED_FAILURE'; throw e; }
  const [p] = await conn.query(
    "INSERT INTO payments (booking_id, amount, status) VALUES (?, ?, 'PAID')",
    [b.insertId, seat[0].fare]);
  step(`INSERT payments -> payment_id ${p.insertId}, amount ${seat[0].fare}`);
  if (o.failAt === 'payment') { const e = new Error('Forced failure after payment insert'); e.code = 'FORCED_FAILURE'; throw e; }
  if (o.baggageKg > 0) {
    // Fee rule kept deliberately simple: 50.00 per kg, one row per bag.
    const [g] = await conn.query('INSERT INTO baggage (booking_id, kg, fee) VALUES (?, ?, ?)',
      [b.insertId, o.baggageKg, o.baggageKg * 50]);
    step(`INSERT baggage -> baggage_id ${g.insertId}, ${o.baggageKg} kg, fee ${o.baggageKg * 50}`);
  }
  if (o.failAt === 'baggage') { const e = new Error('Forced failure after baggage insert'); e.code = 'FORCED_FAILURE'; throw e; }
  await conn.commit();
  step('COMMIT');
  return { bookingId: b.insertId };
}

app.get('/api/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, db: 'connected' });
}));

app.get('/api/flights', wrap(async (req, res) => {
  // Two joins to the same table: origin and destination are both airports.
  // Subqueries give the booking site what it needs: cheapest fare and how
  // many seats are still free (a seat is free when no CONFIRMED booking
  // points at it).
  const [rows] = await pool.query(
    `SELECT f.flight_id, f.flight_no, ao.code AS origin_code, ao.city AS origin_city,
            ad.code AS dest_code, ad.city AS dest_city, f.departs_at,
            (SELECT MIN(s.fare) FROM seats s WHERE s.flight_id = f.flight_id) AS min_fare,
            (SELECT COUNT(*) FROM seats s
             LEFT JOIN bookings b ON b.seat_id = s.seat_id AND b.status = 'CONFIRMED'
             WHERE s.flight_id = f.flight_id AND b.booking_id IS NULL) AS free_seats
     FROM flights f
     JOIN airports ao ON ao.airport_id = f.origin_id
     JOIN airports ad ON ad.airport_id = f.dest_id
     ORDER BY f.flight_id`);
  res.json({ ok: true, rows });
}));

app.post('/api/passengers', wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const phone = String(b.phone || '').trim();
  if (!name || !email) return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'name and email are required' });
  try {
    const [r] = await pool.query('INSERT INTO passengers (name, email, phone) VALUES (?, ?, ?)', [name, email, phone || null]);
    const [rows] = await pool.query('SELECT passenger_id, name, email, phone FROM passengers WHERE passenger_id = ?', [r.insertId]);
    res.json({ ok: true, row: rows[0] });
  } catch (e) {
    // the UNIQUE(email) constraint did the validation for us
    if (e.errno === 1062) return res.status(409).json({ ok: false, code: 1062, message: 'email already registered — pick that passenger from the list instead' });
    throw e;
  }
}));

app.get('/api/bookings', wrap(async (req, res) => {
  // "My trips": one passenger's bookings with flight, seat, payment and bag
  // fees joined in, newest first.
  const pid = Number(req.query.passenger_id);
  if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'passenger_id must be a positive integer' });
  const [rows] = await pool.query(
    `SELECT bk.booking_id, bk.status, bk.created_at, f.flight_no, s.seat_no,
            IFNULL(pay.amount, 0) AS amount, IFNULL(pay.status, '-') AS payment_status,
            (SELECT IFNULL(SUM(g.fee), 0) FROM baggage g WHERE g.booking_id = bk.booking_id) AS baggage_fee
     FROM bookings bk
     JOIN flights f ON f.flight_id = bk.flight_id
     JOIN seats s ON s.seat_id = bk.seat_id
     LEFT JOIN payments pay ON pay.booking_id = bk.booking_id
     WHERE bk.passenger_id = ?
     ORDER BY bk.booking_id DESC`, [pid]);
  res.json({ ok: true, rows });
}));

app.get('/api/flights/:id/seats', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'flight id must be a positive integer' });
  // LEFT JOIN on CONFIRMED bookings only: a seat with no confirmed booking is free.
  const [rows] = await pool.query(
    `SELECT s.seat_id, s.seat_no, s.class, s.fare, b.booking_id, p.name AS passenger_name
     FROM seats s
     LEFT JOIN bookings b ON b.seat_id = s.seat_id AND b.status = 'CONFIRMED'
     LEFT JOIN passengers p ON p.passenger_id = b.passenger_id
     WHERE s.flight_id = ?
     ORDER BY s.seat_no`, [id]);
  res.json({ ok: true, rows });
}));

app.get('/api/table/:name', wrap(async (req, res) => {
  const sql = TABLE_SQL[req.params.name];
  if (!sql) return res.status(404).json({ ok: false, code: 'UNKNOWN_TABLE', message: 'table not whitelisted: ' + req.params.name });
  const [rows, fields] = await pool.query(sql);
  res.json({ ok: true, columns: fields.map((f) => f.name), rows });
}));

app.post('/api/book', async (req, res) => {
  const b = req.body || {};
  const flightId = Number(b.flight_id), seatId = Number(b.seat_id), passengerId = Number(b.passenger_id);
  const baggageKg = b.baggage_kg == null ? 0 : Number(b.baggage_kg);
  const failAt = b.fail_at || null;
  if (!Number.isInteger(flightId) || !Number.isInteger(seatId) || !Number.isInteger(passengerId)) {
    return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'flight_id, seat_id and passenger_id must be integers' });
  }
  if (failAt && !['booking', 'payment', 'baggage'].includes(failAt)) {
    return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'fail_at must be booking, payment, baggage or null' });
  }
  // WHY getConnection: the transaction needs one dedicated connection for its
  // whole life; the pool just lends it, and finally always gives it back.
  const conn = await pool.getConnection();
  const trace = [];
  try {
    const r = await bookSeat(conn, { flightId, seatId, passengerId, baggageKg, failAt }, trace);
    res.json({ ok: true, committed: true, booking_id: r.bookingId, trace });
  } catch (e) {
    // WHY rollback here: any failure after BEGIN must undo every insert, and the
    // trace must show the ROLLBACK so the audience sees atomicity happen.
    try { await conn.rollback(); trace.push({ ts: ts(), actor: 'APP', step: 'ROLLBACK', status: 'ERROR' }); } catch (_) { /* connection gone */ }
    const d = dbError(e);
    res.status(409).json({ ok: false, committed: false, code: d.code, sqlState: d.sqlState, message: d.message, trace });
  } finally {
    conn.release();
  }
});

app.post('/api/cancel/:bookingId', async (req, res) => {
  const id = Number(req.params.bookingId);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'booking id must be a positive integer' });
  const conn = await pool.getConnection();
  const trace = [];
  try {
    await conn.beginTransaction();
    trace.push({ ts: ts(), actor: 'APP', step: 'BEGIN', status: 'OK' });
    const [b] = await conn.query('SELECT booking_id, status FROM bookings WHERE booking_id = ? FOR UPDATE', [id]);
    if (!b.length) { await conn.rollback(); return res.status(404).json({ ok: false, committed: false, code: 'NOT_FOUND', message: `booking ${id} does not exist`, trace }); }
    if (b[0].status === 'CANCELLED') { await conn.rollback(); return res.status(409).json({ ok: false, committed: false, code: 'ALREADY_CANCELLED', message: `booking ${id} is already CANCELLED`, trace }); }
    await conn.query("UPDATE bookings SET status = 'CANCELLED' WHERE booking_id = ?", [id]);
    trace.push({ ts: ts(), actor: 'APP', step: `UPDATE bookings -> booking_id ${id} now CANCELLED`, status: 'OK' });
    await conn.query("UPDATE payments SET status = 'FAILED' WHERE booking_id = ?", [id]);
    trace.push({ ts: ts(), actor: 'APP', step: `UPDATE payments -> voided for booking ${id}`, status: 'OK' });
    await conn.commit();
    trace.push({ ts: ts(), actor: 'APP', step: 'COMMIT', status: 'OK' });
    res.json({ ok: true, committed: true, trace });
  } catch (e) {
    try { await conn.rollback(); trace.push({ ts: ts(), actor: 'APP', step: 'ROLLBACK', status: 'ERROR' }); } catch (_) { /* connection gone */ }
    const d = dbError(e);
    res.status(409).json({ ok: false, committed: false, code: d.code, sqlState: d.sqlState, message: d.message, trace });
  } finally {
    conn.release();
  }
});

app.post('/api/constraint-demo', wrap(async (req, res) => {
  const type = (req.body || {}).type;
  // Each demo runs one deliberately invalid statement so MySQL itself refuses
  // it; the raw code + message are the point of the demo.
  let sql, params = [];
  if (type === 'fk') {
    sql = "INSERT INTO flights (flight_no, origin_id, dest_id, departs_at) VALUES ('SK999', 999, 2, '2026-12-01 09:00:00')";
  } else if (type === 'unique') {
    sql = "INSERT INTO passengers (name, email, phone) VALUES ('Demo Duplicate', 'asha@mail.com', NULL)";
  } else if (type === 'check') {
    const [b] = await pool.query('SELECT booking_id FROM bookings ORDER BY booking_id LIMIT 1');
    if (!b.length) return res.json({ ok: true, demo: type, code: 'NO_BOOKINGS', message: 'no booking exists to attach bad baggage to' });
    sql = 'INSERT INTO baggage (booking_id, kg, fee) VALUES (?, 50, 2500.00)';
    params = [b[0].booking_id];
  } else if (type === 'trigger') {
    const [b] = await pool.query("SELECT flight_id, seat_id, passenger_id FROM bookings WHERE status = 'CONFIRMED' ORDER BY booking_id LIMIT 1");
    if (!b.length) return res.json({ ok: true, demo: type, code: 'NO_BOOKINGS', message: 'no CONFIRMED booking exists to collide with' });
    sql = "INSERT INTO bookings (flight_id, seat_id, passenger_id, status) VALUES (?, ?, ?, 'CONFIRMED')";
    params = [b[0].flight_id, b[0].seat_id, b[0].passenger_id];
  } else {
    return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'type must be fk, unique, check or trigger' });
  }
  try {
    await pool.query(sql, params);
    res.json({ ok: true, demo: type, code: 'NO_ERROR', message: 'statement unexpectedly succeeded' });
  } catch (e) {
    const d = dbError(e);
    res.json({ ok: true, demo: type, sql, code: d.code, sqlState: d.sqlState, message: d.message });
  }
}));

app.post('/api/isolation-demo', async (req, res) => {
  const b = req.body || {};
  const flightId = Number(b.flight_id), seatId = Number(b.seat_id), passengerId = Number(b.passenger_id || 1);
  const trace = [];
  if (!Number.isInteger(seatId)) return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'seat_id must be an integer' });
  const [pre] = await pool.query("SELECT booking_id FROM bookings WHERE seat_id = ? AND status = 'CONFIRMED'", [seatId]);
  if (pre.length) return res.status(409).json({ ok: false, code: 'SEAT_BUSY', message: 'isolation demo needs a FREE seat — pick one in the seat map' });
  const connA = await pool.getConnection();
  const connB = await pool.getConnection();
  try {
    // WHY 5s: if anything jams, B fails on lock wait timeout instead of hanging forever.
    await connA.query('SET SESSION innodb_lock_wait_timeout = 5');
    await connB.query('SET SESSION innodb_lock_wait_timeout = 5');
    // A: begin, lock the seat row, insert its booking — but do NOT commit yet.
    await connA.beginTransaction();
    trace.push({ ts: ts(), actor: 'A', step: 'BEGIN', status: 'OK' });
    const [s] = await connA.query('SELECT seat_no FROM seats WHERE seat_id = ? FOR UPDATE', [seatId]);
    trace.push({ ts: ts(), actor: 'A', step: `SELECT seat ${s[0].seat_no} FOR UPDATE -> lock held`, status: 'OK' });
    await connA.query("INSERT INTO bookings (flight_id, seat_id, passenger_id, status) VALUES (?, ?, ?, 'CONFIRMED')", [flightId, seatId, passengerId]);
    trace.push({ ts: ts(), actor: 'A', step: 'INSERT bookings (uncommitted)', status: 'OK' });
    // B: the identical booking attempt. It blocks at its own FOR UPDATE because
    // A already holds the row lock.
    const bPromise = bookSeat(connB, { flightId, seatId, passengerId, baggageKg: 0, failAt: null }, trace, 'B');
    await sleep(1500);
    const [trx] = await pool.query('SELECT trx_state FROM information_schema.INNODB_TRX WHERE trx_mysql_thread_id = ?', [connB.connection.threadId]);
    trace.push({ ts: ts(), actor: 'B', step: trx.length ? `status while A holds the lock: trx_state = ${trx[0].trx_state}` : 'attempting booking', status: 'WAIT' });
    await connA.commit();
    trace.push({ ts: ts(), actor: 'A', step: 'COMMIT -> booking is now visible', status: 'OK' });
    let bFailed = null;
    try { await bPromise; } catch (e) { bFailed = dbError(e); }
    // B resumes after A commits, its trigger check now sees A's booking -> SIGNAL 45000.
    if (bFailed) {
      trace.push({ ts: ts(), actor: 'B', step: `failed: [${bFailed.code}] ${bFailed.message}`, status: 'ERROR' });
      try { await connB.rollback(); trace.push({ ts: ts(), actor: 'B', step: 'ROLLBACK', status: 'ERROR' }); } catch (_) { /* gone */ }
    }
    res.json({ ok: true, committed: true, trace, b_failed: bFailed });
  } catch (e) {
    try { await connA.rollback(); } catch (_) { /* A never began */ }
    const d = dbError(e);
    res.status(500).json({ ok: false, committed: false, code: d.code, sqlState: d.sqlState, message: d.message, trace });
  } finally {
    connA.release();
    connB.release();
  }
});

app.post('/api/query', wrap(async (req, res) => {
  const sql = String((req.body || {}).sql || '').trim();
  const body = sql.replace(/;+\s*$/, '');
  const first = (body.match(/^[a-zA-Z]+/) || [''])[0].toUpperCase();
  // Single statement only, and only the four safe-ish verbs; everything else
  // (DROP, ALTER, TRUNCATE, SET, ...) is refused before it reaches MySQL.
  if (!body) return res.status(400).json({ ok: false, code: 'EMPTY', message: 'type a SQL statement' });
  if (body.includes(';')) return res.status(400).json({ ok: false, code: 'MULTI', message: 'only a single statement is allowed' });
  if (!['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(first)) {
    return res.status(400).json({ ok: false, code: 'FORBIDDEN', message: 'only SELECT, INSERT, UPDATE, DELETE are allowed (got ' + (first || 'nothing') + ')' });
  }
  try {
    const [rows, fields] = await pool.query(body);
    if (Array.isArray(rows)) {
      res.json({ ok: true, columns: fields.map((f) => f.name), rows: rows.slice(0, 200) });
    } else {
      res.json({ ok: true, columns: [], rows: [], affectedRows: rows.affectedRows, insertId: rows.insertId });
    }
  } catch (e) {
    const d = dbError(e);
    res.status(400).json({ ok: false, code: d.code, sqlState: d.sqlState, message: d.message });
  }
}));

app.get('/api/logs/audit', wrap(async (req, res) => {
  const since = Number(req.query.since) || 0;
  const [rows] = await pool.query(
    `SELECT log_id, table_name, action, row_id, old_data, new_data, logged_at
     FROM audit_log WHERE log_id > ? ORDER BY log_id DESC LIMIT 100`, [since]);
  res.json({ ok: true, rows });
}));

app.get('/api/logs/general', wrap(async (req, res) => {
  const [g] = await pool.query('SELECT @@general_log AS enabled');
  if (!g[0].enabled) return res.json({ ok: true, enabled: false, rows: [] });
  // Filter to this app's MySQL user and drop our own log-reading queries,
  // otherwise the log would fill with its own SELECT every 2 seconds.
  // CAST: the argument column is stored as CSV bytes, so cast it to text.
  const [rows] = await pool.query(
    `SELECT event_time, user_host, command_type,
            CAST(argument AS CHAR CHARACTER SET utf8mb4) AS argument
     FROM mysql.general_log
     WHERE user_host LIKE ? AND argument NOT LIKE '%general_log%'
     ORDER BY event_time DESC, thread_id DESC LIMIT 30`, [process.env.DB_USER + '%']);
  res.json({ ok: true, enabled: true, rows });
}));

app.post('/api/reset', wrap(async (req, res) => {
  // Dedicated connection because seed.sql is many statements at once; the app
  // pool stays multipleStatements=false so /api/query can never do this.
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    multipleStatements: true, dateStrings: true,
  });
  try {
    const seed = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8');
    await conn.query(seed);
    await conn.query('TRUNCATE TABLE mysql.general_log');  // so the log demo starts clean too
    res.json({ ok: true, message: 'Demo data reset' });
  } finally {
    await conn.end();
  }
}));

// Wrap(fn) gives the simple GET handlers uniform {ok:false, code, message} errors.
function wrap(fn) {
  return (req, res) => fn(req, res).catch((e) => {
    console.error(e);
    const d = dbError(e);
    res.status(500).json({ ok: false, code: d.code, sqlState: d.sqlState, message: d.message });
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`skyledger listening on http://localhost:${PORT}`));
