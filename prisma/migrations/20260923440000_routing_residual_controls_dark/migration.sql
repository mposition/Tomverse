-- Appendix R1 and R3, as columns nothing writes yet.
--
-- R1 keeps an affinity epoch and a hold-down instant on the dark cache
-- affinity row. A missing epoch is not zero. A missing instant is not a
-- duration this migration chooses. The table is dark and this statement
-- writes no row.
--
-- R3 keeps a request deadline, in milliseconds, on RoutingRun. Null means
-- nobody supplied one. It is not zero. Existing rows stay null. The column
-- is dark, listed beside the other RoutingRun columns the request path
-- must not name.
--
-- Rollback: drop the two checks, then drop the three columns, after
-- confirming no runtime source reads them.

ALTER TABLE "DeploymentCacheAffinity"
    ADD COLUMN "affinityEpoch" INTEGER,
    ADD COLUMN "holdDownUntil" TIMESTAMP(3);

ALTER TABLE "DeploymentCacheAffinity"
    ADD CONSTRAINT "DeploymentCacheAffinity_affinity_epoch_nonnegative_check"
    CHECK ("affinityEpoch" IS NULL OR "affinityEpoch" >= 0);

ALTER TABLE "RoutingRun"
    ADD COLUMN "requestDeadlineMs" INTEGER;

ALTER TABLE "RoutingRun"
    ADD CONSTRAINT "RoutingRun_request_deadline_positive_check"
    CHECK ("requestDeadlineMs" IS NULL OR "requestDeadlineMs" > 0);
