-- Which attempt the user's charge came from, moved off the audit row.
--
-- `ChatAttemptUsage.userBilled` was a flag on a table that refuses every
-- UPDATE. That was survivable only because the rows were all written at
-- settlement, when the answer was already known. Recording an attempt's cost
-- when the *attempt* ends -- so a process that dies after dispatching still
-- leaves the provider cost behind -- makes the flag impossible: at that moment
-- nobody knows which attempt the user will be charged for.
--
-- So the pointer moves to the reservation, and the audit row stays immutable.
-- "At most one billed attempt" stops being a partial unique index and becomes
-- one column holding one value, which is a stronger statement and a simpler
-- one.

ALTER TABLE "ChatCreditReservation" ADD COLUMN "settlementAttemptIndex" INTEGER;

DROP INDEX IF EXISTS "ChatAttemptUsage_one_billed_attempt_idx";
ALTER TABLE "ChatAttemptUsage" DROP COLUMN "userBilled";

-- The pointer names a real attempt of *this* reservation.
--
-- A bare nullable integer would accept 7, or the index of another
-- reservation's attempt. The composite key is already unique on
-- ChatAttemptUsage, so it can be referenced directly.
--
-- MATCH SIMPLE (the default) is what makes a NULL pointer legal while a
-- non-NULL one is fully checked: with both columns non-null the row must
-- exist, and with the pointer null nothing is required.
--
-- NO ACTION rather than SET NULL, and the reason is specific: this key spans
-- the primary key column. Postgres SET NULL nulls *every* referencing column,
-- so deleting an attempt row would try to null `id` and fail on the not-null
-- constraint instead of clearing the pointer -- a delete that reports the
-- wrong problem. Nothing deletes an attempt row on its own anyway: they
-- cascade with the reservation, and DEFERRABLE lets that happen in one
-- statement because the check runs at COMMIT, when both are already gone.
ALTER TABLE "ChatCreditReservation"
    ADD CONSTRAINT "ChatCreditReservation_settlementAttempt_fkey"
    FOREIGN KEY ("id", "settlementAttemptIndex")
    REFERENCES "ChatAttemptUsage" ("reservationId", "attemptIndex")
    ON DELETE NO ACTION ON UPDATE NO ACTION
    DEFERRABLE INITIALLY DEFERRED;

-- Write once. NULL may become an index; an index may not become another
-- index, and may not go back to NULL.
--
-- The rule this protects is §7's: a goodwill refund "must not rewrite provider
-- cost accounting". Moving the pointer after the fact would re-attribute the
-- user's charge to a different attempt, which is that rewrite by another
-- route. A correction is a new record elsewhere, not a quiet edit here.
CREATE OR REPLACE FUNCTION "chat_reservation_settlement_pointer_is_write_once"()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD."settlementAttemptIndex" IS NOT NULL
       AND NEW."settlementAttemptIndex" IS DISTINCT FROM OLD."settlementAttemptIndex" THEN
        RAISE EXCEPTION
            'ChatCreditReservation % already settled against attempt %; the pointer is write-once',
            OLD."id", OLD."settlementAttemptIndex"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "chat_reservation_settlement_pointer_is_write_once"
    BEFORE UPDATE ON "ChatCreditReservation"
    FOR EACH ROW
    EXECUTE FUNCTION "chat_reservation_settlement_pointer_is_write_once"();

-- A settled multi-attempt reservation names the attempt it settled against.
--
-- The pointer column gives "at most one" for free; "exactly one, once the
-- money has moved" is a different claim and needs its own enforcement. Checked
-- as a constraint trigger so it is evaluated at COMMIT: settlement writes the
-- terminal status and the pointer in one transaction, and an immediate check
-- would fire between the two statements whichever order they were written in.
--
-- Scoped to reservations that actually have attempt rows. A single-attempt
-- turn writes none -- the reservation is its own record -- and requiring a
-- pointer there would demand a row that does not exist.
CREATE OR REPLACE FUNCTION "chat_reservation_settled_names_its_attempt"()
RETURNS TRIGGER AS $$
DECLARE
    attempt_count INTEGER;
BEGIN
    IF NEW."status" IN ('settled', 'refunded') AND NEW."settlementAttemptIndex" IS NULL THEN
        SELECT COUNT(*) INTO attempt_count
        FROM "ChatAttemptUsage"
        WHERE "reservationId" = NEW."id";
        IF attempt_count > 0 THEN
            RAISE EXCEPTION
                'ChatCreditReservation % is % with % attempt cost row(s) and no settlementAttemptIndex',
                NEW."id", NEW."status", attempt_count
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "chat_reservation_settled_names_its_attempt"
    AFTER INSERT OR UPDATE ON "ChatCreditReservation"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION "chat_reservation_settled_names_its_attempt"();
