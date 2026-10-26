-- schema.sql: creates the skyledger database, all 3NF tables, constraints and triggers.
-- Run once before seed.sql (it drops and recreates the whole database):
--   mysql -u root -p < schema.sql
-- NOTE: triggers below use DELIMITER because their bodies contain ';' --
-- plain `mysql < schema.sql` handles that; run this file only via the mysql CLI.

DROP DATABASE IF EXISTS skyledger;
CREATE DATABASE skyledger CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE skyledger;

-- Airports: no foreign keys; referenced by flights. Surrogate PK because IATA
-- codes could in theory be reused; UNIQUE keeps codes unambiguous.
CREATE TABLE airports (
  airport_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code       CHAR(3)       NOT NULL UNIQUE,
  city       VARCHAR(100)  NOT NULL
) ENGINE = InnoDB;  -- InnoDB: transactions, row locks and foreign keys

-- Flights point at two airports. ON DELETE RESTRICT means an airport that
-- flights still reference cannot be deleted, so no booking can lose its route.
CREATE TABLE flights (
  flight_id  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  flight_no  VARCHAR(8)   NOT NULL UNIQUE,  -- business key, human-readable
  origin_id  INT UNSIGNED NOT NULL,
  dest_id    INT UNSIGNED NOT NULL,
  departs_at DATETIME     NOT NULL,
  CONSTRAINT fk_flight_origin FOREIGN KEY (origin_id) REFERENCES airports (airport_id) ON DELETE RESTRICT,
  CONSTRAINT fk_flight_dest   FOREIGN KEY (dest_id)   REFERENCES airports (airport_id) ON DELETE RESTRICT,
  CONSTRAINT chk_origin_diff_dest CHECK (origin_id <> dest_id)  -- a flight cannot fly to its own origin
) ENGINE = InnoDB;

-- Seats belong to one flight. UNIQUE(flight_id, seat_no): the same seat number
-- exists on many flights but only once per flight.
CREATE TABLE seats (
  seat_id   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  flight_id INT UNSIGNED NOT NULL,
  seat_no   VARCHAR(4)   NOT NULL,               -- '1A' .. '6D'
  class     ENUM('ECONOMY','BUSINESS') NOT NULL, -- ENUM: only these values are legal
  fare      DECIMAL(10,2) NOT NULL,              -- DECIMAL, not FLOAT: exact money
  CONSTRAINT uq_flight_seat UNIQUE (flight_id, seat_no),
  CONSTRAINT fk_seat_flight FOREIGN KEY (flight_id) REFERENCES flights (flight_id) ON DELETE RESTRICT
) ENGINE = InnoDB;

CREATE TABLE passengers (
  passenger_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(120) NOT NULL,
  email        VARCHAR(200) NOT NULL UNIQUE,  -- one email = one passenger record
  phone        VARCHAR(20)  NULL              -- NULL means "not given"
) ENGINE = InnoDB;

-- One row per booked seat. The BEFORE INSERT trigger below allows at most one
-- CONFIRMED booking per seat; CANCELLED rows stay in the table as history.
CREATE TABLE bookings (
  booking_id   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  flight_id    INT UNSIGNED NOT NULL,
  seat_id      INT UNSIGNED NOT NULL,
  passenger_id INT UNSIGNED NOT NULL,
  status       ENUM('CONFIRMED','CANCELLED') NOT NULL DEFAULT 'CONFIRMED',
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),  -- ms precision for log ordering
  CONSTRAINT fk_booking_flight    FOREIGN KEY (flight_id)    REFERENCES flights (flight_id)      ON DELETE RESTRICT,
  CONSTRAINT fk_booking_seat      FOREIGN KEY (seat_id)      REFERENCES seats (seat_id)          ON DELETE RESTRICT,
  CONSTRAINT fk_booking_passenger FOREIGN KEY (passenger_id) REFERENCES passengers (passenger_id) ON DELETE RESTRICT
) ENGINE = InnoDB;

-- Exactly one payment per booking (UNIQUE booking_id); the DB itself rejects
-- negative amounts so app code cannot be the only line of defense.
CREATE TABLE payments (
  payment_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id INT UNSIGNED NOT NULL UNIQUE,
  amount     DECIMAL(10,2) NOT NULL,
  status     ENUM('PAID','FAILED') NOT NULL DEFAULT 'PAID',
  paid_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_payment_booking FOREIGN KEY (booking_id) REFERENCES bookings (booking_id) ON DELETE RESTRICT,
  CONSTRAINT chk_amount_nonneg  CHECK (amount >= 0)
) ENGINE = InnoDB;

-- One or more bags per booking; kg is bounded so nonsense values are rejected
-- by the database, not by app code.
CREATE TABLE baggage (
  baggage_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id INT UNSIGNED NOT NULL,
  kg         INT NOT NULL,
  fee        DECIMAL(10,2) NOT NULL,
  CONSTRAINT fk_baggage_booking FOREIGN KEY (booking_id) REFERENCES bookings (booking_id) ON DELETE RESTRICT,
  CONSTRAINT chk_kg_range       CHECK (kg BETWEEN 1 AND 40)
) ENGINE = InnoDB;

-- Trigger-written audit trail. Node code never inserts here; only the triggers
-- below do, so every row-level change is logged even if a client forgets to.
CREATE TABLE audit_log (
  log_id     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  table_name VARCHAR(64) NOT NULL,
  action     ENUM('INSERT','UPDATE','DELETE') NOT NULL,
  row_id     BIGINT UNSIGNED NOT NULL,          -- PK value of the changed row
  old_data   JSON NULL,                         -- before-image; NULL for INSERT
  new_data   JSON NULL,                         -- after-image; NULL for DELETE
  logged_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE = InnoDB;

-- Deliberately UNNORMALIZED teaching table: everything repeated per row, and
-- baggage as a comma-separated list (a repeating group, which violates 1NF).
CREATE TABLE unnormalized_bookings (
  unnorm_id       INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_no      VARCHAR(10)   NOT NULL,        -- NOT NULL on purpose: it makes the
  passenger_name  VARCHAR(120)  NOT NULL,        --   insert anomaly demo fail loudly
  passenger_email VARCHAR(200)  NOT NULL,
  flight_no       VARCHAR(8)    NOT NULL,
  origin_city     VARCHAR(100)  NOT NULL,
  dest_city       VARCHAR(100)  NOT NULL,
  seat_no         VARCHAR(4)    NOT NULL,
  fare            DECIMAL(10,2) NOT NULL,
  payment_status  VARCHAR(20)   NOT NULL,
  baggage         VARCHAR(100)  NOT NULL DEFAULT ''  -- '15kg,7kg' or ''
) ENGINE = InnoDB;

-- Small helper table (1..8) used by the 1NF view to split bag lists into rows.
CREATE TABLE demo_numbers (
  n INT UNSIGNED PRIMARY KEY
) ENGINE = InnoDB;

-- ============ TRIGGERS ============

-- Guard against double booking: fires on every INSERT into bookings before the
-- row is written. If the seat already has a CONFIRMED booking, SIGNAL aborts
-- the whole statement (and, inside a transaction, whatever came before it).
DELIMITER ;;
CREATE TRIGGER trg_bookings_no_double_seat BEFORE INSERT ON bookings
FOR EACH ROW
BEGIN
  IF NEW.status = 'CONFIRMED' AND EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.seat_id = NEW.seat_id AND b.status = 'CONFIRMED'
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Seat already has a CONFIRMED booking';
  END IF;
END;;
DELIMITER ;

-- Same guard for UPDATE, so a cancelled booking cannot be re-confirmed onto a
-- seat that somebody else took in the meantime.
DELIMITER ;;
CREATE TRIGGER trg_bookings_no_reconfirm BEFORE UPDATE ON bookings
FOR EACH ROW
BEGIN
  IF NEW.status = 'CONFIRMED' AND OLD.status <> 'CONFIRMED' AND EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.seat_id = NEW.seat_id AND b.status = 'CONFIRMED' AND b.booking_id <> NEW.booking_id
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Seat already has a CONFIRMED booking';
  END IF;
END;;
DELIMITER ;

-- Audit AFTER INSERT on bookings: one row per inserted booking.
DELIMITER ;;
CREATE TRIGGER trg_bookings_after_insert AFTER INSERT ON bookings
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('bookings', 'INSERT', NEW.booking_id, NULL,
          JSON_OBJECT('flight_id', NEW.flight_id, 'seat_id', NEW.seat_id,
                      'passenger_id', NEW.passenger_id, 'status', NEW.status));;
DELIMITER ;

-- Audit AFTER UPDATE on bookings: captures both before- and after-image, so a
-- CONFIRMED -> CANCELLED change leaves visible evidence.
DELIMITER ;;
CREATE TRIGGER trg_bookings_after_update AFTER UPDATE ON bookings
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('bookings', 'UPDATE', NEW.booking_id,
          JSON_OBJECT('status', OLD.status),
          JSON_OBJECT('status', NEW.status));;
DELIMITER ;

-- Audit AFTER DELETE on bookings: keeps the before-image only.
DELIMITER ;;
CREATE TRIGGER trg_bookings_after_delete AFTER DELETE ON bookings
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('bookings', 'DELETE', OLD.booking_id,
          JSON_OBJECT('flight_id', OLD.flight_id, 'seat_id', OLD.seat_id,
                      'passenger_id', OLD.passenger_id, 'status', OLD.status),
          NULL);;
DELIMITER ;

-- Audit AFTER INSERT on payments: the money side of a booking is logged too.
DELIMITER ;;
CREATE TRIGGER trg_payments_after_insert AFTER INSERT ON payments
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('payments', 'INSERT', NEW.payment_id, NULL,
          JSON_OBJECT('booking_id', NEW.booking_id, 'amount', NEW.amount,
                      'status', NEW.status));;
DELIMITER ;

-- Audit AFTER UPDATE on payments: a voided payment (PAID -> FAILED) is logged.
DELIMITER ;;
CREATE TRIGGER trg_payments_after_update AFTER UPDATE ON payments
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('payments', 'UPDATE', NEW.payment_id,
          JSON_OBJECT('status', OLD.status),
          JSON_OBJECT('status', NEW.status));;
DELIMITER ;

-- Audit AFTER INSERT on baggage (added so a booking with a bag writes exactly
-- three audit rows: booking, payment, baggage).
DELIMITER ;;
CREATE TRIGGER trg_baggage_after_insert AFTER INSERT ON baggage
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('baggage', 'INSERT', NEW.baggage_id, NULL,
          JSON_OBJECT('booking_id', NEW.booking_id, 'kg', NEW.kg, 'fee', NEW.fee));;
DELIMITER ;

-- Audit AFTER DELETE on baggage.
DELIMITER ;;
CREATE TRIGGER trg_baggage_after_delete AFTER DELETE ON baggage
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('baggage', 'DELETE', OLD.baggage_id,
          JSON_OBJECT('booking_id', OLD.booking_id, 'kg', OLD.kg, 'fee', OLD.fee),
          NULL);;
DELIMITER ;

-- Audit seat changes: seed inserts them, and fare updates are worth logging.
DELIMITER ;;
CREATE TRIGGER trg_seats_after_insert AFTER INSERT ON seats
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('seats', 'INSERT', NEW.seat_id, NULL,
          JSON_OBJECT('flight_id', NEW.flight_id, 'seat_no', NEW.seat_no,
                      'class', NEW.class, 'fare', NEW.fare));;
DELIMITER ;

DELIMITER ;;
CREATE TRIGGER trg_seats_after_update AFTER UPDATE ON seats
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('seats', 'UPDATE', NEW.seat_id,
          JSON_OBJECT('fare', OLD.fare),
          JSON_OBJECT('fare', NEW.fare));;
DELIMITER ;
