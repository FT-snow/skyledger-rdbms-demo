-- 1NF fix: every cell holds exactly one atomic value. The comma-separated
-- baggage list ("15kg,7kg") becomes one row per bag. Run with:
--   mysql -u root -p skyledger < sql/1nf.sql
USE skyledger;

-- One row per (booking, bag). demo_numbers supplies 1..8; the join repeats each
-- booking row once per bag it lists, and SUBSTRING_INDEX picks the n-th piece.
-- Rows with an empty baggage list produce a single row with an empty bag value.
CREATE OR REPLACE VIEW bookings_1nf AS
SELECT
  u.booking_no,
  u.passenger_name,
  u.passenger_email,
  u.flight_no,
  u.origin_city,
  u.dest_city,
  u.seat_no,
  u.fare,
  u.payment_status,
  n.n AS bag_no,
  TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(u.baggage, ',', n.n), ',', -1)) AS bag
FROM unnormalized_bookings u
JOIN demo_numbers n
  ON n.n <= IF(u.baggage = '', 1, 1 + LENGTH(u.baggage) - LENGTH(REPLACE(u.baggage, ',', '')));

-- Compare: SELECT * FROM bookings_1nf ORDER BY booking_no, bag_no;
