-- The settled-names-its-attempt check, reading the row as it will be
-- committed rather than as it was when the trigger was queued.
--
-- The previous version's comment claimed the check "is evaluated at COMMIT, so
-- settlement can write the terminal status and the pointer in either order".
-- Half of that was true and the half that matters was not. A deferred row
-- trigger fires at COMMIT, but its `NEW` is the row image from the statement
-- that queued it -- not the row's final state. So:
--
--   UPDATE ... SET status = 'settled'                 -- queues NEW(pointer NULL)
--   INSERT INTO "ChatAttemptUsage" ...
--   UPDATE ... SET settlementAttemptIndex = 1         -- queues NEW(pointer 1)
--   COMMIT
--
-- would have run the first trigger against a NULL pointer and raised, even
-- though the committed row is correct. Today's settlement writes both in one
-- UPDATE so it never hit this, but a constraint that depends on the caller
-- using one statement is a constraint that breaks the day somebody splits it.
--
-- Re-reading the row inside the trigger removes that dependency: at COMMIT the
-- transaction's own uncommitted writes are visible to it, so the SELECT sees
-- the final state whatever order produced it.
CREATE OR REPLACE FUNCTION "chat_reservation_settled_names_its_attempt"()
RETURNS TRIGGER AS $$
DECLARE
    current_status TEXT;
    current_pointer INTEGER;
    attempt_count INTEGER;
BEGIN
    SELECT "status", "settlementAttemptIndex"
    INTO current_status, current_pointer
    FROM "ChatCreditReservation"
    WHERE "id" = NEW."id";

    -- Deleted later in the same transaction: there is nothing left to check.
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF current_status IN ('settled', 'refunded') AND current_pointer IS NULL THEN
        SELECT COUNT(*) INTO attempt_count
        FROM "ChatAttemptUsage"
        WHERE "reservationId" = NEW."id";
        IF attempt_count > 0 THEN
            RAISE EXCEPTION
                'ChatCreditReservation % is % with % attempt cost row(s) and no settlementAttemptIndex',
                NEW."id", current_status, attempt_count
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
