-- A provider invocation and its post-call timestamp cannot be one database
-- transaction. Persist the last local fact first so a crash in that gap keeps
-- the existing unknown_after_dispatch / reserved-upper-bound recovery path.
--
-- Historical rows stay NULL. In particular, this migration does not infer a
-- start timestamp from dispatchedAt: that would turn an old completion record
-- into a newly invented observation.
ALTER TABLE "RoutingAttempt"
    ADD COLUMN "dispatchStartedAt" TIMESTAMP(3);

-- A start is evidence, not editable metadata. Allow the one NULL -> timestamp
-- transition only while the attempt is pending and has no historical
-- dispatchedAt. This leaves old rows readable but makes an inferred backfill
-- or a later timestamp rewrite a database error. Other outcome and settlement
-- updates do not change this column and pass through unchanged.
CREATE FUNCTION "routing_attempt_dispatch_start_is_immutable"()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD."dispatchStartedAt" IS NOT NULL
       AND NEW."dispatchStartedAt" IS DISTINCT FROM OLD."dispatchStartedAt" THEN
        RAISE EXCEPTION
            'RoutingAttempt % dispatchStartedAt is immutable', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."dispatchStartedAt" IS NULL
       AND NEW."dispatchStartedAt" IS NOT NULL
       AND (OLD."outcome" <> 'pending' OR OLD."dispatchedAt" IS NOT NULL) THEN
        RAISE EXCEPTION
            'RoutingAttempt % cannot backfill dispatchStartedAt', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "routing_attempt_dispatch_start_is_immutable"
    BEFORE UPDATE OF "dispatchStartedAt" ON "RoutingAttempt"
    FOR EACH ROW
    EXECUTE FUNCTION "routing_attempt_dispatch_start_is_immutable"();

ALTER TABLE "RoutingAttempt"
    DROP CONSTRAINT "RoutingAttempt_dispatch_requires_finalized_manifest_check";
ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_dispatch_requires_finalized_manifest_check"
    CHECK (
        (
            "dispatchStartedAt" IS NULL
            OR (
                "manifestFinalizedAt" IS NOT NULL
                AND "manifestFinalizedAt" <= "dispatchStartedAt"
            )
        )
        AND (
            "dispatchedAt" IS NULL
            OR (
                "manifestFinalizedAt" IS NOT NULL
                AND "manifestFinalizedAt" <= "dispatchedAt"
                AND (
                    "dispatchStartedAt" IS NULL
                    OR "dispatchStartedAt" <= "dispatchedAt"
                )
            )
        )
    );

ALTER TABLE "RoutingAttempt"
    DROP CONSTRAINT "RoutingAttempt_not_dispatched_check";
ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_not_dispatched_check"
    CHECK (
        "outcome" <> 'not_dispatched'
        OR (
            "dispatchedAt" IS NULL
            AND "providerRequestId" IS NULL
            AND "firstVisibleTokenAt" IS NULL
            AND "actualInputTokens" IS NULL
            AND "actualOutputTokens" IS NULL
        )
    );

ALTER TABLE "RoutingAttempt"
    DROP CONSTRAINT "RoutingAttempt_unknown_after_dispatch_check";
ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_unknown_after_dispatch_check"
    CHECK (
        "outcome" <> 'unknown_after_dispatch'
        OR "dispatchStartedAt" IS NOT NULL
        OR "dispatchedAt" IS NOT NULL
    );

ALTER TABLE "RoutingAttempt"
    DROP CONSTRAINT "RoutingAttempt_visible_token_requires_dispatch_check";
ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_visible_token_requires_dispatch_check"
    CHECK (
        "firstVisibleTokenAt" IS NULL
        OR "dispatchStartedAt" IS NOT NULL
        OR "dispatchedAt" IS NOT NULL
    );
