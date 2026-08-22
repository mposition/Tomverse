-- RoutingRun learns which product and which conversation it ran for.
--
-- Contract: product boundary decision record v1.2 §5.
-- ADR:      docs/policy/routing-run-product-attribution.md.
--
-- ## What was missing
--
-- `BeginDispatchInput` already accepted `conversationId` and
-- `prisma.routingRun.create()` never wrote it. `mode` and `traceId` went in;
-- that one did not. And `assistantMessageId` -- the only other route back to a
-- conversation -- is set on successful runs only, so a failed run had no way at
-- all of naming what it belonged to. ROUTE-07 counts `not_dispatched`
-- terminations in its denominator, and the numerator could not be split by
-- product.
--
-- ## Two columns, two different jobs
--
--   productKey      an execution-time snapshot: which product was this?
--   conversationId  a join: which conversation was this?
--
-- The snapshot is not derivable from the join, because the join is allowed to
-- break. That is the point of the next section.
--
-- ## SET NULL, not CASCADE
--
-- Today RoutingRun survives a conversation deletion, because there is no
-- foreign key at all. Adding one with CASCADE would change that silently: the
-- moment a user deletes a conversation, that turn's evaluation data would go
-- with it, and ROUTE-01's sample and ROUTE-07's denominator would shrink with
-- user tidying rather than with anything about routing. SET NULL breaks the
-- join and keeps the snapshot. ChatCreditReservation.userId is the same
-- pattern for the same reason.
--
-- Account deletion is unchanged: RoutingRun.userId -> User stays ON DELETE
-- CASCADE, so deleting an account still removes that account's runs. The
-- data-domain registry decided that, and this migration does not revisit it --
-- it protects product attribution from *conversation* deletion only.
--
-- ## The conversationId index is not optional
--
-- PostgreSQL creates an index on a PRIMARY KEY and on a UNIQUE constraint, but
-- never on the *referencing* column of a foreign key. ON DELETE SET NULL has to
-- locate the referencing rows, so without this index every single conversation
-- deletion is a sequential scan of the whole RoutingRun table -- and that table
-- grows with every turn the product serves.
--
-- ## What this migration does NOT do
--
-- It does not make productKey mandatory for runs after a cutover, and it does
-- not backfill historical rows. Existing runs have no recorded product, and
-- inventing one would be an attribution nobody made -- the same reason the
-- Conversation backfill refuses to classify from selectionMode. The ADR
-- records why enforcement is writer coverage rather than a hard-coded cutover
-- CHECK.

ALTER TABLE "RoutingRun"
    ADD COLUMN "productKey" TEXT,
    ADD COLUMN "conversationId" TEXT;

-- Created before the constraint so the constraint has an index to use from the
-- moment it exists.
CREATE INDEX "RoutingRun_conversationId_idx" ON "RoutingRun"("conversationId");

CREATE INDEX "RoutingRun_productKey_createdAt_idx"
    ON "RoutingRun"("productKey", "createdAt");

ALTER TABLE "RoutingRun"
    ADD CONSTRAINT "RoutingRun_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- The same allowlist as Conversation.productKey, and NOT VALID for the same
-- reason: it enforces every new write from now on without a full-table scan
-- and without failing the deploy on rows nobody has surveyed. NULL passes,
-- because every historical row is one.
ALTER TABLE "RoutingRun"
    ADD CONSTRAINT "RoutingRun_product_key_check"
    CHECK (
        "productKey" IS NULL
        OR "productKey" IN ('chat', 'review', 'studio')
    )
    NOT VALID;
