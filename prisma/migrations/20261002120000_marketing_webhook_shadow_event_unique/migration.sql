-- Marketing S2e: one shadow report per webhook event.
--
-- Zernio retries a delivery up to seven times and redelivers by hand, always
-- with the same event id, so the staging shadow receiver will see the same
-- event more than once. The receiver asks nothing before inserting; this index
-- is what makes the second insert of an event fail, inside the transaction that
-- would also have written its audit entry, so a duplicate leaves neither.
--
-- Partial, on the shadow kind only, and keyed on the digest the strict payload
-- schema requires (`eventIdDigest`, lowercase SHA-256). The plan calls it
-- staging-only: shadow reports are only ever written in staging, so in
-- production the index exists and covers no row. A migration applies
-- everywhere; what keeps production out is the writer's environment check, not
-- the absence of this index.
--
-- Operational dedupe in S2f does not use this index: it scans the post's own
-- history under the post's row lock.
CREATE UNIQUE INDEX "MarketingReport_webhook_shadow_event_key"
    ON "MarketingReport" (("payload" ->> 'eventIdDigest'))
    WHERE "kind" = 'webhook_shadow';
