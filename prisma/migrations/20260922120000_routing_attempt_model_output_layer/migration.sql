-- A failure layer for an answer that arrived and was not usable.
--
-- `RoutingAttempt.failureLayer` could say that the provider failed
-- (`provider`), that this process or this connection did not survive
-- (`stream`), or that something inside the turn refused before dispatch. It
-- had no way to say that the call succeeded and the answer was empty, so the
-- chat route recorded that under `stream` -- the layer documented as *our*
-- process or connection, which is the one thing it was not.
--
-- `model_output` -- the provider answered, and the answer was not usable.
--
-- The distinction is already drawn elsewhere for the same case under a
-- different name: lib/providerErrorClassification.ts classifies
-- AI_EMPTY_RESPONSE as MODEL_TRANSIENT with scope 'model', and PROVIDER_SCOPED
-- excludes it, so an empty answer has never counted against
-- ProviderHealthState. This is that decision arriving in the attempt record.
--
-- Not fallback-eligible. lib/routingFallbackPolicy.ts falls back only on
-- 'adapter' and 'provider', so adding a layer changes no routing behaviour;
-- an empty answer moves nobody to another model, as before.
--
-- Widening a CHECK accepts every value the old one did, so this is safe to
-- deploy before the code that writes the new value, and that is the order to
-- deploy it in.
--
-- Rollback: restore the previous CHECK. Rows already carrying 'model_output'
-- must be updated first. Their honest old value is 'stream', which is what
-- they would have had before this change -- inaccurate, but it is the value
-- the previous constraint would have held for exactly these rows, so a
-- rollback is mechanical here rather than a data decision.

ALTER TABLE "RoutingAttempt" DROP CONSTRAINT IF EXISTS "RoutingAttempt_failureLayer_check";
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
            'process',
            'storage',
            'application',
            'model_output'
        )
    );
