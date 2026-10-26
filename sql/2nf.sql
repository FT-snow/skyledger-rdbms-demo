-- 2NF step: every non-key fact must depend on the WHOLE key. booking_no is a
-- single-column key, so this table is technically already 2NF -- but flight
-- facts (route) are repeated on every booking row, which is what 2NF-style
-- splitting is about: a fact lives once, with the entity it belongs to.
-- Run with: mysql -u root -p skyledger < sql/2nf.sql
USE skyledger;

-- Flight facts now exist once per flight instead of once per booking.
CREATE OR REPLACE VIEW flights_2nf AS
SELECT DISTINCT flight_no, origin_city, dest_city
FROM unnormalized_bookings;

-- Booking rows keep only facts about the booking itself.
CREATE OR REPLACE VIEW bookings_2nf AS
SELECT booking_no, passenger_name, passenger_email, flight_no, seat_no, fare, payment_status
FROM unnormalized_bookings;

-- Compare:
--   SELECT * FROM flights_2nf ORDER BY flight_no;
--   SELECT * FROM bookings_2nf ORDER BY booking_no;
