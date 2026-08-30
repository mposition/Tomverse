-- Two more failure layers for an attempt that never reached a provider.
--
-- `RoutingAttempt.failureLayer` could name only things inside the turn --
-- planner, adapter, manifest, billing, provider, stream -- plus `process` for
-- a host that stopped. A chat turn that failed because object storage no
-- longer held an attachment had none of those, and the chat route recorded it
-- as `provider`, which is the same misattribution that put a bucket's 404 into
-- provider health.
--
-- `storage`  -- object storage answered 404/403/5xx for something we needed.
-- `application` -- our own code or database failed before dispatch.
--
-- Neither is fallback-eligible: lib/routingFallbackPolicy.ts only falls back
-- on `adapter` and `provider`, so a storage failure moves nobody to another
-- model -- correctly, because another model would read the same missing file.
--
-- Widening a CHECK accepts every value the old one did, so this is safe to
-- deploy before the code that writes the new values.
--
-- Rollback: restore the previous CHECK. Any rows already carrying the two new
-- values must be updated first (there is no natural old value for them; they
-- would have to become 'process', which is a lie, so a rollback after those
-- rows exist is a data decision rather than a mechanical one).

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
            'application'
        )
    );
