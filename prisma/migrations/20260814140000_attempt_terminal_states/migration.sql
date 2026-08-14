-- An attempt whose process died after dispatching, and the rule that a
-- terminal outcome is final.

-- `unknown_after_dispatch`: the honest name for what a sweep can know.
--
-- A stale `pending` attempt is not evidence that the provider failed, and
-- recording it as `failed_pre_token` would be a claim about a provider call
-- nobody observed. Two things are actually known: a dispatch was recorded, and
-- the process stopped reporting before writing a terminal outcome. That is
-- what this value says and nothing more.
ALTER TABLE "RoutingAttempt" DROP CONSTRAINT "RoutingAttempt_outcome_check";
ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_outcome_check"
    CHECK (
        "outcome" IN (
            'pending',
            'not_dispatched',
            'failed_pre_token',
            'failed_post_token',
            'cancelled',
            'succeeded',
            'unknown_after_dispatch'
        )
    );

-- `process`: the layer that failed when nothing about the request did.
--
-- The existing layers all name something inside the turn -- planner, adapter,
-- manifest, billing, provider, stream. A process that stopped is none of them,
-- and filing it under `provider` would put a host restart into provider health
-- and, through §8's recovery, into decisions about which model to route to.
ALTER TABLE "RoutingAttempt" DROP CONSTRAINT "RoutingAttempt_failureLayer_check";
ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_failureLayer_check"
    CHECK (
        "failureLayer" IN (
            'none',
            'planner',
            'adapter',
            'manifest',
            'billing',
            'provider',
            'stream',
            'process'
        )
    );

-- The value only means anything about an attempt that was dispatched. On one
-- that was not, the outcome is `not_dispatched` and there is no uncertainty to
-- record.
ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_unknown_after_dispatch_check"
    CHECK (
        "outcome" <> 'unknown_after_dispatch' OR "dispatchedAt" IS NOT NULL
    );

-- A terminal outcome is final.
--
-- `closeAttempt` is a compare-and-set on `outcome = 'pending'`, which stops the
-- live path and a sweep from both closing one attempt. This is the same rule
-- at the layer that cannot be bypassed: without it, any future writer -- a
-- migration, a backfill, a well-meant admin action -- could turn a recorded
-- `failed_pre_token` into something else, and the drill's own scenarios are
-- told apart by exactly that field.
--
-- `pending` may become anything terminal. Nothing terminal may become
-- anything else, including itself: a second write of the same value is a
-- second writer who believed they were the first.
CREATE OR REPLACE FUNCTION "routing_attempt_outcome_is_terminal"()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD."outcome" <> 'pending' AND NEW."outcome" IS DISTINCT FROM OLD."outcome" THEN
        RAISE EXCEPTION
            'RoutingAttempt % is already %; a terminal outcome cannot be changed', OLD."id", OLD."outcome"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "routing_attempt_outcome_is_terminal"
    BEFORE UPDATE ON "RoutingAttempt"
    FOR EACH ROW
    EXECUTE FUNCTION "routing_attempt_outcome_is_terminal"();

-- The sweep looks for attempts left pending, oldest first. Partial, because a
-- closed attempt is never a candidate again.
CREATE INDEX "RoutingAttempt_pending_sweep_idx"
    ON "RoutingAttempt" ("createdAt")
    WHERE "outcome" = 'pending';
