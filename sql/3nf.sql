-- 3NF step: no transitive dependencies -- a non-key column must not depend on
-- another non-key column. passenger_email depends on the passenger (not on the
-- booking), and city names depend on the flight route, so each gets its own
-- relation. This is the shape the real skyledger tables already have.
-- Run with: mysql -u root -p skyledger < sql/3nf.sql
USE skyledger;

-- One row per passenger: email lives with the person, not with every booking.
CREATE OR REPLACE VIEW passengers_3nf AS
SELECT DISTINCT passenger_name, passenger_email
FROM unnormalized_bookings;

-- One row per flight: the route facts live with the flight.
CREATE OR REPLACE VIEW flights_3nf AS
SELECT DISTINCT flight_no, origin_city, dest_city
FROM unnormalized_bookings;

-- Bookings reduced to the booking's own facts plus references; the real
-- bookings / seats / passengers / flights tables are this, fully materialized
-- with keys and constraints.
CREATE OR REPLACE VIEW bookings_3nf AS
SELECT booking_no, flight_no, seat_no, payment_status, passenger_name
FROM unnormalized_bookings;

-- Compare:
--   SELECT * FROM passengers_3nf ORDER BY passenger_name;
--   SELECT * FROM flights_3nf ORDER BY flight_no;
--   SELECT * FROM bookings_3nf ORDER BY booking_no;
