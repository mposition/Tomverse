-- The ceiling a manifest is published under, as an approval of its own.
-- Added dark.
--
-- Nothing publishes a manifest or approves a ceiling, and
-- `npm run check:dark-tables` holds that for the new table.
--
-- ---------------------------------------------------------------------------
-- Where size is controlled
-- ---------------------------------------------------------------------------
--
-- Section 8.5 of the identity design, and the point is *where* rather than
-- whether. An earlier draft capped the candidate verdicts written per run.
-- Whichever cut you take there throws away either the lowest-ranked candidates
-- or a particular rejection reason -- which is exactly the answer to "why was
-- this deployment not picked". A newly added deployment is cut first, and it
-- is the one most in need of an answer.
--
-- So the limit sits on the published snapshot, at approval time. T4 scopes it
-- the same way: the staging registry may grow; only the published snapshot is
-- bounded.
--
-- ---------------------------------------------------------------------------
-- Why the ceiling is a row of its own
-- ---------------------------------------------------------------------------
--
-- The first version of this file put `approvedCeiling` on the manifest and had
-- the publisher supply it alongside the entries. An independent review showed
-- why that is not a ceiling: publish a hundred deployments with a ceiling of a
-- hundred and both checks pass. A limit the publisher picks to fit is not the
-- limit section 8.5 means. "A config over the ceiling is refused" only holds
-- if the ceiling exists before the config and independently of it.
--
-- So the ceiling is approved on its own, by a named person, into an
-- append-only table, and a manifest *cites* one. The manifest still carries a
-- copy of the value -- a later reader asks what the limit was then, and a
-- ceiling raised since would make an older manifest look as though it had room
-- it did not have -- and the database refuses a copy that does not match the
-- approval it cites.
--
-- What this does not do, and says so: a person with write access can approve
-- a ceiling and publish under it in the same minute. What they cannot do is
-- publish under a number that is not an attributed, dated, immutable approval
-- -- which is the same guarantee every other approval in this schema gives.
--
-- ---------------------------------------------------------------------------
-- NOT NULL, and why that is safe only here
-- ---------------------------------------------------------------------------
--
-- `RoutingIdentityManifest` has no rows anywhere, which is why its two new
-- columns can be NOT NULL with no default. Had it held rows, this migration
-- should fail rather than fill them in: there is no approved ceiling to fill
-- them with, and PostgreSQL refuses `ADD COLUMN ... NOT NULL` without a
-- default on a non-empty table, which is the right direction.
--
-- Rollback: drop the two manifest columns, their constraints and trigger, then
-- the approval table. Nothing reads any of them.

-- ---------------------------------------------------------------------------
-- 1. The approval
-- ---------------------------------------------------------------------------

CREATE TABLE "RoutingSnapshotCeilingApproval" (
    "id" TEXT NOT NULL,
    "ceiling" INTEGER NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "evidenceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutingSnapshotCeilingApproval_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RoutingSnapshotCeilingApproval"
    ADD CONSTRAINT "RoutingSnapshotCeilingApproval_ceiling_positive_check"
    CHECK ("ceiling" >= 1);

-- A ceiling is what an operational judgement rests on, so it names a person.
-- Same six characters as every other blank test in this schema, for the
-- reason the cache evidence reference records.
ALTER TABLE "RoutingSnapshotCeilingApproval"
    ADD CONSTRAINT "RoutingSnapshotCeilingApproval_approvedBy_present_check"
    CHECK ("approvedBy" ~ E'[^ \\t\\n\\r\\f\\v]');

CREATE INDEX "RoutingSnapshotCeilingApproval_approvedAt_idx"
    ON "RoutingSnapshotCeilingApproval"("approvedAt");

-- Append-only. An approval that could be edited afterwards could not answer
-- what the limit was when a manifest was published under it.
CREATE OR REPLACE FUNCTION "routing_snapshot_ceiling_approval_is_immutable"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'RoutingSnapshotCeilingApproval % is recorded; approve a new ceiling', OLD."id"
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "routing_snapshot_ceiling_approval_is_immutable_trigger"
    BEFORE UPDATE OR DELETE ON "RoutingSnapshotCeilingApproval"
    FOR EACH ROW
    EXECUTE FUNCTION "routing_snapshot_ceiling_approval_is_immutable"();

CREATE OR REPLACE FUNCTION "routing_snapshot_ceiling_approval_is_not_truncatable"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'RoutingSnapshotCeilingApproval is approval history and cannot be truncated'
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "routing_snapshot_ceiling_approval_is_not_truncatable_trigger"
    BEFORE TRUNCATE ON "RoutingSnapshotCeilingApproval"
    FOR EACH STATEMENT
    EXECUTE FUNCTION "routing_snapshot_ceiling_approval_is_not_truncatable"();

-- ---------------------------------------------------------------------------
-- 2. The manifest cites one
-- ---------------------------------------------------------------------------

ALTER TABLE "RoutingIdentityManifest"
    ADD COLUMN "ceilingApprovalId" TEXT NOT NULL,
    ADD COLUMN "approvedCeiling" INTEGER NOT NULL;

ALTER TABLE "RoutingIdentityManifest"
    ADD CONSTRAINT "RoutingIdentityManifest_ceilingApprovalId_fkey"
    FOREIGN KEY ("ceilingApprovalId") REFERENCES "RoutingSnapshotCeilingApproval"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "RoutingIdentityManifest_ceilingApprovalId_idx"
    ON "RoutingIdentityManifest"("ceilingApprovalId");

-- The stored count sits under the stored copy. This is about two integers on
-- one row and nothing more: it does not see the entry rows, whose count is
-- tied to `entryCount` only by `manifestProblems()` -- the same limit the
-- digest already has. What it adds is that a row cannot record a ceiling it
-- exceeded.
ALTER TABLE "RoutingIdentityManifest"
    ADD CONSTRAINT "RoutingIdentityManifest_within_ceiling_check"
    CHECK ("entryCount" <= "approvedCeiling");

-- The copy must be the approval it cites, and the approval must precede the
-- publication. This is the part that makes the ceiling an approval rather
-- than a number the publisher chose: without it, `approvedCeiling` could be
-- written to fit whatever was being published.
--
-- A trigger rather than a CHECK because it reads another row.
CREATE OR REPLACE FUNCTION "routing_identity_manifest_cites_its_ceiling"()
RETURNS TRIGGER AS $$
DECLARE
    approved_ceiling INTEGER;
    approved_at TIMESTAMP(3);
BEGIN
    SELECT "ceiling", "approvedAt"
    INTO approved_ceiling, approved_at
    FROM "RoutingSnapshotCeilingApproval"
    WHERE "id" = NEW."ceilingApprovalId";

    IF NOT FOUND THEN
        RAISE EXCEPTION 'manifest % cites no ceiling approval', NEW."version"
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."approvedCeiling" <> approved_ceiling THEN
        RAISE EXCEPTION
            'manifest % records a ceiling of % but cites an approval of %',
            NEW."version", NEW."approvedCeiling", approved_ceiling
            USING ERRCODE = 'check_violation';
    END IF;
    IF approved_at > NEW."approvedAt" THEN
        RAISE EXCEPTION
            'manifest % cites a ceiling approved after it was published', NEW."version"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "routing_identity_manifest_cites_its_ceiling_trigger"
    BEFORE INSERT ON "RoutingIdentityManifest"
    FOR EACH ROW
    EXECUTE FUNCTION "routing_identity_manifest_cites_its_ceiling"();
