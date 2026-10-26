-- seed.sql: fills skyledger with demo data. Idempotent: safe to re-run on any
-- state (it empties every table first, then inserts a fixed demo dataset).
--   mysql -u root -p < seed.sql
-- The last statement clears the audit noise from seeding so the demo log
-- starts empty.

USE skyledger;

-- We empty parent and child tables together, so FK checks are switched off for
-- this session only and switched straight back on. TRUNCATE also resets the
-- AUTO_INCREMENT counters, which keeps demo ids small after a reset.
SET FOREIGN_KEY_CHECKS = 0;
TRUNCATE TABLE audit_log;
TRUNCATE TABLE baggage;
TRUNCATE TABLE payments;
TRUNCATE TABLE bookings;
TRUNCATE TABLE passengers;
TRUNCATE TABLE seats;
TRUNCATE TABLE flights;
TRUNCATE TABLE airports;
TRUNCATE TABLE unnormalized_bookings;
TRUNCATE TABLE demo_numbers;
SET FOREIGN_KEY_CHECKS = 1;

-- 3 airports
INSERT INTO airports (code, city) VALUES ('DEL', 'Delhi');
INSERT INTO airports (code, city) VALUES ('BOM', 'Mumbai');
INSERT INTO airports (code, city) VALUES ('BLR', 'Bengaluru');

-- 2 flights (fresh AUTO_INCREMENT guarantees flight_id 1 and 2)
INSERT INTO flights (flight_no, origin_id, dest_id, departs_at) VALUES ('SK101', 1, 2, '2026-11-02 07:30:00');
INSERT INTO flights (flight_no, origin_id, dest_id, departs_at) VALUES ('SK202', 2, 3, '2026-11-02 10:45:00');

-- 24 seats per flight: rows 1-6, letters A-D. Rows 1-2 are BUSINESS, the rest
-- ECONOMY. Seat ids follow insertion order: flight 1 -> ids 1-24, flight 2 -> 25-48.
INSERT INTO seats (flight_id, seat_no, class, fare) VALUES
  (1,'1A','BUSINESS',8500.00),(1,'1B','BUSINESS',8500.00),(1,'1C','BUSINESS',8500.00),(1,'1D','BUSINESS',8500.00),
  (1,'2A','BUSINESS',8500.00),(1,'2B','BUSINESS',8500.00),(1,'2C','BUSINESS',8500.00),(1,'2D','BUSINESS',8500.00),
  (1,'3A','ECONOMY',4500.00),(1,'3B','ECONOMY',4500.00),(1,'3C','ECONOMY',4500.00),(1,'3D','ECONOMY',4500.00),
  (1,'4A','ECONOMY',4500.00),(1,'4B','ECONOMY',4500.00),(1,'4C','ECONOMY',4500.00),(1,'4D','ECONOMY',4500.00),
  (1,'5A','ECONOMY',4500.00),(1,'5B','ECONOMY',4500.00),(1,'5C','ECONOMY',4500.00),(1,'5D','ECONOMY',4500.00),
  (1,'6A','ECONOMY',4500.00),(1,'6B','ECONOMY',4500.00),(1,'6C','ECONOMY',4500.00),(1,'6D','ECONOMY',4500.00),
  (2,'1A','BUSINESS',6800.00),(2,'1B','BUSINESS',6800.00),(2,'1C','BUSINESS',6800.00),(2,'1D','BUSINESS',6800.00),
  (2,'2A','BUSINESS',6800.00),(2,'2B','BUSINESS',6800.00),(2,'2C','BUSINESS',6800.00),(2,'2D','BUSINESS',6800.00),
  (2,'3A','ECONOMY',3200.00),(2,'3B','ECONOMY',3200.00),(2,'3C','ECONOMY',3200.00),(2,'3D','ECONOMY',3200.00),
  (2,'4A','ECONOMY',3200.00),(2,'4B','ECONOMY',3200.00),(2,'4C','ECONOMY',3200.00),(2,'4D','ECONOMY',3200.00),
  (2,'5A','ECONOMY',3200.00),(2,'5B','ECONOMY',3200.00),(2,'5C','ECONOMY',3200.00),(2,'5D','ECONOMY',3200.00),
  (2,'6A','ECONOMY',3200.00),(2,'6B','ECONOMY',3200.00),(2,'6C','ECONOMY',3200.00),(2,'6D','ECONOMY',3200.00);

-- 6 passengers
INSERT INTO passengers (name, email, phone) VALUES
  ('Asha Verma',  'asha@mail.com',  '9810012345'),
  ('Rahul Iyer',  'rahul@mail.com', '9810023456'),
  ('Meera Nair',  'meera@mail.com', '9810034567'),
  ('Dev Patel',   'dev@mail.com',   '9810045678'),
  ('Sara Khan',   'sara@mail.com',  '9810056789'),
  ('John Dsouza', 'john@mail.com',  '9810067890');

-- 4 existing bookings. Seat ids come from subqueries, not magic numbers, so the
-- seed survives if seats are ever inserted in a different order.
-- Booking 1: Asha, SK101 seat 2A, paid, 15kg bag (fee = 15 x 50).
INSERT INTO bookings (flight_id, seat_id, passenger_id, status)
VALUES (1, (SELECT seat_id FROM seats WHERE flight_id = 1 AND seat_no = '2A'),
           (SELECT passenger_id FROM passengers WHERE email = 'asha@mail.com'), 'CONFIRMED');
INSERT INTO payments (booking_id, amount, status)
VALUES (1, (SELECT fare FROM seats WHERE seat_id = 5), 'PAID');
INSERT INTO baggage (booking_id, kg, fee) VALUES (1, 15, 750.00);

-- Booking 2: Rahul, SK101 seat 3C, paid, no bag.
INSERT INTO bookings (flight_id, seat_id, passenger_id, status)
VALUES (1, (SELECT seat_id FROM seats WHERE flight_id = 1 AND seat_no = '3C'),
           (SELECT passenger_id FROM passengers WHERE email = 'rahul@mail.com'), 'CONFIRMED');
INSERT INTO payments (booking_id, amount, status)
VALUES (2, (SELECT fare FROM seats WHERE seat_id = 11), 'PAID');

-- Booking 3: Meera, SK101 seat 5B, paid, 20kg bag.
INSERT INTO bookings (flight_id, seat_id, passenger_id, status)
VALUES (1, (SELECT seat_id FROM seats WHERE flight_id = 1 AND seat_no = '5B'),
           (SELECT passenger_id FROM passengers WHERE email = 'meera@mail.com'), 'CONFIRMED');
INSERT INTO payments (booking_id, amount, status)
VALUES (3, (SELECT fare FROM seats WHERE seat_id = 18), 'PAID');
INSERT INTO baggage (booking_id, kg, fee) VALUES (3, 20, 1000.00);

-- Booking 4: Dev, SK202 seat 1A, paid, 12kg bag.
INSERT INTO bookings (flight_id, seat_id, passenger_id, status)
VALUES (2, (SELECT seat_id FROM seats WHERE flight_id = 2 AND seat_no = '1A'),
           (SELECT passenger_id FROM passengers WHERE email = 'dev@mail.com'), 'CONFIRMED');
INSERT INTO payments (booking_id, amount, status)
VALUES (4, (SELECT fare FROM seats WHERE seat_id = 25), 'PAID');
INSERT INTO baggage (booking_id, kg, fee) VALUES (4, 12, 600.00);

-- 10 rows in the unnormalized table, chosen so each anomaly is one query:
--  - rows 1-3 repeat Asha three times  -> update anomaly
--  - booking_no / passenger_name are NOT NULL -> insert anomaly
--  - rows 6-10 are the only place SK202's route exists -> delete anomaly
INSERT INTO unnormalized_bookings
  (booking_no, passenger_name, passenger_email, flight_no, origin_city, dest_city, seat_no, fare, payment_status, baggage) VALUES
  ('BK-1001', 'Asha Verma',  'asha@mail.com',  'SK101', 'Delhi', 'Mumbai',    '2A', 8500.00, 'PAID',     '15kg,7kg'),
  ('BK-1002', 'Asha Verma',  'asha@mail.com',  'SK101', 'Delhi', 'Mumbai',    '2B', 8500.00, 'PAID',     ''),
  ('BK-1003', 'Asha Verma',  'asha@mail.com',  'SK101', 'Delhi', 'Mumbai',    '3A', 4500.00, 'REFUNDED', '20kg'),
  ('BK-1004', 'Rahul Iyer',  'rahul@mail.com', 'SK101', 'Delhi', 'Mumbai',    '1C', 8500.00, 'PAID',     '10kg'),
  ('BK-1005', 'Meera Nair',  'meera@mail.com', 'SK101', 'Delhi', 'Mumbai',    '4D', 4500.00, 'FAILED',   ''),
  ('BK-1006', 'Dev Patel',   'dev@mail.com',   'SK202', 'Mumbai', 'Bengaluru','1A', 6800.00, 'PAID',     '12kg,5kg'),
  ('BK-1007', 'Sara Khan',   'sara@mail.com',  'SK202', 'Mumbai', 'Bengaluru','2C', 6800.00, 'PAID',     ''),
  ('BK-1008', 'John Dsouza', 'john@mail.com',  'SK202', 'Mumbai', 'Bengaluru','3B', 3200.00, 'PAID',     '18kg'),
  ('BK-1009', 'Priya Bose',  'priya@mail.com', 'SK202', 'Mumbai', 'Bengaluru','4A', 3200.00, 'REFUNDED', ''),
  ('BK-1010', 'Rahul Iyer',  'rahul@mail.com', 'SK202', 'Mumbai', 'Bengaluru','5B', 3200.00, 'PAID',     '');

-- Numbers 1..8 for the 1NF view (splits bag lists into one row per bag).
INSERT INTO demo_numbers (n) VALUES (1),(2),(3),(4),(5),(6),(7),(8);

-- Seeding fired all the INSERT triggers; clear the noise so the audience sees
-- only the demo's own audit rows.
TRUNCATE TABLE audit_log;
