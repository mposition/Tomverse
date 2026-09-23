-- The ceiling a manifest is published under. Added dark.
--
-- Nothing publishes a manifest, and `npm run check:dark-tables` holds that.
--
-- ---------------------------------------------------------------------------
-- Where size is controlled
-- ---------------------------------------------------------------------------
--
-- Section 5 of the identity design, and the point is *where* rather than
-- whether. An earlier draft capped the candidate verdicts written per run.
-- Whichever cut you take there throws away either the lowest-ranked candidates
-- or a particular rejection reason -- which is exactly the answer to "why was
-- this deployment not picked". A newly added deployment is cut first, and it
-- is the one most in need of an answer.
--
-- So the limit sits on the configuration at approval time. A manifest over its
-- ceiling is refused publication and the last approved snapshot stands.
-- Nothing is discarded at execution time to make a row fit.
--
-- ---------------------------------------------------------------------------
-- Why it is stored rather than read from a setting
-- ---------------------------------------------------------------------------
--
-- The same reason the digest is stored beside the manifest id: a later reader
-- asks what the limit was *then*, and a current setting cannot answer that. A
-- ceiling that was raised last month would make a manifest published under the
-- old one look as though it had room it did not have.
--
-- NOT NULL with no default. A configuration nobody set a ceiling for cannot be
-- published, because a ceiling is an approval and an absent approval is not an
-- unlimited one. The table is empty, so NOT NULL costs nothing here.
--
-- Rollback: drop the column. Nothing reads it.

ALTER TABLE "RoutingIdentityManifest"
    ADD COLUMN "approvedCeiling" INTEGER NOT NULL;

ALTER TABLE "RoutingIdentityManifest"
    ADD CONSTRAINT "RoutingIdentityManifest_approvedCeiling_positive_check"
    CHECK ("approvedCeiling" >= 1);

-- The published manifest never exceeded the ceiling it names. The application
-- refuses this before it writes, and the database says it a second time --
-- `manifestProblems()` compares the entries it was handed, which the database
-- never sees, and this compares the count that was stored.
ALTER TABLE "RoutingIdentityManifest"
    ADD CONSTRAINT "RoutingIdentityManifest_within_ceiling_check"
    CHECK ("entryCount" <= "approvedCeiling");
