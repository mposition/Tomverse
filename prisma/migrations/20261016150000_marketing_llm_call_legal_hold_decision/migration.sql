-- baseline-check: replace-function-if-body-sha256 "marketing_llm_call_update_guard" "15e53e38a307be530ad27104f6d7439c4956de9617efc7524ed67f3882be740c"
-- A ledger row's legal hold names the decision that set it (S3c3c review).
--
-- A hold decision used to be checked by its action and call alone, and the
-- update compared only the flag, so a person's earlier "release" audit row
-- could be presented again after a new hold, and a delayed release meant for
-- an old hold could lift a new one -- and an unheld row past its retention is
-- deleted. Now the row stores the audit row of the decision that last moved
-- the hold. A new decision must name the one it replaces, and the database
-- holds that on its own: the flag and the reference move only together, and
-- only to a person's audit row for this direction on this call whose recorded
-- predecessor is the row's current decision. Decisions form one chain per row,
-- so no earlier decision can be presented again: its predecessor is no longer
-- the current one.

ALTER TABLE "MarketingLlmCall" ADD COLUMN "legalHoldAuditLogId" TEXT;
CREATE UNIQUE INDEX "MarketingLlmCall_legalHoldAuditLogId_key" ON "MarketingLlmCall"("legalHoldAuditLogId");
ALTER TABLE "MarketingLlmCall" ADD CONSTRAINT "MarketingLlmCall_legalHoldAuditLogId_fkey"
    FOREIGN KEY ("legalHoldAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A held row always names the decision that held it.
ALTER TABLE "MarketingLlmCall" ADD CONSTRAINT "MarketingLlmCall_legal_hold_decision_check"
    CHECK (NOT "legalHold" OR "legalHoldAuditLogId" IS NOT NULL);

-- Rows are born with no hold decision. A trigger of its own, so the insert
-- guard the ledger was created with stays as it was reviewed.
CREATE FUNCTION "marketing_llm_call_insert_hold_guard"() RETURNS trigger AS $$
BEGIN
    IF NEW."legalHoldAuditLogId" IS NOT NULL THEN
        RAISE EXCEPTION 'marketing_llm_call_insert_not_reserved';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE TRIGGER "MarketingLlmCall_insert_hold_guard"
    BEFORE INSERT ON "MarketingLlmCall"
    FOR EACH ROW EXECUTE FUNCTION "marketing_llm_call_insert_hold_guard"();

CREATE OR REPLACE FUNCTION "marketing_llm_call_update_guard"() RETURNS trigger AS $$
DECLARE
    now_utc TIMESTAMP(3) := (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
    dispatch_keys TEXT[] := ARRAY['dispatchIntentId', 'adapterConfigDigest', 'dispatchDigest',
                                  'dispatchAuditLogId', 'dispatchedAt'];
    close_keys TEXT[] := ARRAY['closeDigest', 'closeAuditLogId', 'closedAt', 'closeReason',
                               'observationId', 'reportedModel', 'reportedServiceTier',
                               'reportedInputTokens', 'reportedOutputTokens'];
    old_rest JSONB;
    new_rest JSONB;
    decision_action TEXT;
    decision_target TEXT;
    decision_previous TEXT;
BEGIN
    IF OLD."state" = NEW."state" THEN
        -- Same state: a legal-hold decision, or the one consumer write on a
        -- closed draft call. Never both, never anything else.
        old_rest := to_jsonb(OLD) - 'legalHold' - 'legalHoldAuditLogId' - 'consumerDigest';
        new_rest := to_jsonb(NEW) - 'legalHold' - 'legalHoldAuditLogId' - 'consumerDigest';
        IF old_rest IS DISTINCT FROM new_rest THEN
            RAISE EXCEPTION 'marketing_llm_call_update_invalid';
        END IF;
        -- A hold decision flips the flag and names the person's audit row for
        -- it, together; neither moves without the other, and a decision always
        -- names a row (the unique index makes it a row no other decision used).
        IF (OLD."legalHold" IS DISTINCT FROM NEW."legalHold")
                <> (OLD."legalHoldAuditLogId" IS DISTINCT FROM NEW."legalHoldAuditLogId")
            OR (OLD."legalHold" IS DISTINCT FROM NEW."legalHold" AND NEW."legalHoldAuditLogId" IS NULL) THEN
            RAISE EXCEPTION 'marketing_llm_call_update_invalid';
        END IF;
        IF OLD."legalHold" IS DISTINCT FROM NEW."legalHold" THEN
            -- The decision's own audit row, named from the trigger's schema
            -- because search_path is pinned: this direction, this call, and the
            -- row's current decision as its predecessor (':none' for none).
            EXECUTE format(
                'SELECT "action", "targetId", "metadata" ->> ''previousHoldAuditLogId'' FROM %I."AdminAuditLog" WHERE "id" = $1',
                TG_TABLE_SCHEMA)
                INTO decision_action, decision_target, decision_previous
                USING NEW."legalHoldAuditLogId";
            IF decision_action IS DISTINCT FROM (CASE WHEN NEW."legalHold"
                    THEN 'marketing_llm.legal_hold_set' ELSE 'marketing_llm.legal_hold_released' END)
                OR decision_target IS DISTINCT FROM NEW."id"
                OR decision_previous IS DISTINCT FROM COALESCE(OLD."legalHoldAuditLogId", ':none') THEN
                RAISE EXCEPTION 'marketing_llm_call_hold_decision_invalid';
            END IF;
        END IF;
        IF OLD."consumerDigest" IS DISTINCT FROM NEW."consumerDigest" THEN
            IF OLD."consumerDigest" IS NOT NULL
                OR OLD."state" NOT IN ('settled', 'unknown_retained')
                OR OLD."legalHold" IS DISTINCT FROM NEW."legalHold" THEN
                RAISE EXCEPTION 'marketing_llm_call_update_invalid';
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."legalHold" IS DISTINCT FROM NEW."legalHold"
        OR NEW."consumerDigest" IS NOT NULL THEN
        RAISE EXCEPTION 'marketing_llm_call_update_invalid';
    END IF;

    IF OLD."state" = 'reserved' AND NEW."state" = 'dispatched' THEN
        IF now_utc >= OLD."createdAt" + INTERVAL '15 minutes' THEN
            RAISE EXCEPTION 'marketing_llm_call_dispatch_late';
        END IF;
        old_rest := to_jsonb(OLD) - 'state' - dispatch_keys;
        new_rest := to_jsonb(NEW) - 'state' - dispatch_keys;
        NEW."dispatchedAt" := now_utc;
    ELSIF OLD."state" = 'reserved' AND NEW."state" = 'released' THEN
        -- A reservation is dispatchable strictly before createdAt + 15 minutes
        -- and expirable from that instant on, so no moment is neither.
        IF NEW."closeReason" = 'reservation_expired'
            AND now_utc < OLD."createdAt" + INTERVAL '15 minutes' THEN
            RAISE EXCEPTION 'marketing_llm_call_expiry_early';
        END IF;
        old_rest := to_jsonb(OLD) - 'state' - close_keys;
        new_rest := to_jsonb(NEW) - 'state' - close_keys;
        NEW."closedAt" := now_utc;
    ELSIF OLD."state" = 'dispatched' AND NEW."state" IN ('settled', 'unknown_retained') THEN
        IF NEW."closeReason" = 'dispatch_expired'
            AND now_utc < OLD."dispatchedAt" + INTERVAL '1 hour' THEN
            RAISE EXCEPTION 'marketing_llm_call_expiry_early';
        END IF;
        old_rest := to_jsonb(OLD) - 'state' - close_keys;
        new_rest := to_jsonb(NEW) - 'state' - close_keys;
        NEW."closedAt" := now_utc;
    ELSE
        RAISE EXCEPTION 'marketing_llm_call_transition_invalid';
    END IF;

    -- Everything the transition does not set is unchanged: the reservation,
    -- and for a close the dispatch evidence that came before it.
    IF old_rest IS DISTINCT FROM new_rest THEN
        RAISE EXCEPTION 'marketing_llm_call_update_invalid';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;
