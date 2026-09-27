-- ADR v2.1 §10.2, as a column nothing writes yet.
--
-- How long the first chunk may be withheld, in milliseconds, before it is
-- flushed. Null means nobody supplied one. It is not zero and it is not a
-- duration this migration chooses. Existing rows stay null. The column is
-- dark, listed beside the other RoutingRun columns the request path must
-- not name.
--
-- Rollback: drop the check, then drop the column, after confirming no
-- runtime source reads it.

ALTER TABLE "RoutingRun"
    ADD COLUMN "precommitBufferMs" INTEGER;

ALTER TABLE "RoutingRun"
    ADD CONSTRAINT "RoutingRun_precommit_buffer_positive_check"
    CHECK ("precommitBufferMs" IS NULL OR "precommitBufferMs" > 0);
