-- One published snapshot of the routing identity configuration. Added dark.
--
-- Nothing publishes a manifest and nothing reads one.
-- `npm run check:dark-tables` holds that for the table, and the two columns
-- added to RoutingAttempt join its dark column list.
--
-- ---------------------------------------------------------------------------
-- What this unblocks, and why it had to come first
-- ---------------------------------------------------------------------------
--
-- The identity design forbids four things until a manifest exists: enabling
-- the identity config writer, recording a canary, judging eligibility, and
-- making a deployment-level decision. All four share one failure -- a decision
-- made against configuration that has since moved, with nothing able to say
-- afterwards what it was made against.
--
-- Mutable rows cannot answer "what was allowed at the time", and the residency
-- question puts a legal judgement on top of that answer. So a decision names a
-- manifest version, and a version is published once and never edited.
--
-- ---------------------------------------------------------------------------
-- Why the digest is recorded twice
-- ---------------------------------------------------------------------------
--
-- An attempt carries the manifest id *and* the digest it saw. Deliberate
-- redundancy: the foreign key says which row, and the digest says what that
-- row held when the decision was made. If the two ever disagree, the
-- disagreement is the finding -- a manifest was altered after publication,
-- which the append-only trigger is meant to make impossible and which the
-- stored digest lets anybody detect without trusting the trigger.
--
-- ---------------------------------------------------------------------------
-- What is deliberately not unique
-- ---------------------------------------------------------------------------
--
-- `version` is unique; `digest` is not. Two versions may publish identical
-- configuration -- a republish after a rollout was stopped, say -- and that is
-- a different publication, not a duplicate. Forcing the digest unique would
-- refuse the second one and leave nothing recording that it happened.
--
-- ---------------------------------------------------------------------------
-- What this locks
-- ---------------------------------------------------------------------------
--
-- The table is new. The two columns on RoutingAttempt are nullable with no
-- default, so no rewrite; the CHECK scan and the foreign key take their locks
-- on a live table the same way the grain columns did, and every value is NULL
-- so neither finds anything to refuse.
--
-- Rollback: drop the two columns on RoutingAttempt, which takes their CHECK,
-- index and foreign key with them, then drop the table. Nothing reads either.

CREATE TABLE "RoutingIdentityManifest" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "digest" TEXT NOT NULL,
    "entryCount" INTEGER NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutingIdentityManifest_pkey" PRIMARY KEY ("id")
);

-- From one. Zero is indistinguishable from an unset column in every report
-- that reads it.
ALTER TABLE "RoutingIdentityManifest"
    ADD CONSTRAINT "RoutingIdentityManifest_version_positive_check"
    CHECK ("version" >= 1);

-- A manifest publishing no deployment says something -- that none is
-- configured -- but it is not published by leaving the list out.
ALTER TABLE "RoutingIdentityManifest"
    ADD CONSTRAINT "RoutingIdentityManifest_entryCount_positive_check"
    CHECK ("entryCount" >= 1);

-- Exactly a sha256 in lowercase hex. What the database cannot check is that
-- the digest describes the deployments it was computed over -- it never sees
-- them -- so `manifestProblems()` in lib/routingIdentityManifest.ts recomputes
-- it, and a caller passes the entries rather than being handed a digest.
ALTER TABLE "RoutingIdentityManifest"
    ADD CONSTRAINT "RoutingIdentityManifest_digest_shape_check"
    CHECK ("digest" ~ '^[0-9a-f]{64}$');

-- A manifest is what a legal judgement about residency rests on, so it names
-- a person. The blank test is a character class rather than btrim, for the
-- reason the cache evidence reference records: btrim strips only U+0020 while
-- JavaScript's trim() strips every Unicode space, and the two definitions
-- have to refuse the same strings.
ALTER TABLE "RoutingIdentityManifest"
    ADD CONSTRAINT "RoutingIdentityManifest_approvedBy_present_check"
    CHECK ("approvedBy" ~ E'[^ \\t\\n\\r\\f\\v]');

CREATE UNIQUE INDEX "RoutingIdentityManifest_version_key"
    ON "RoutingIdentityManifest"("version");
CREATE INDEX "RoutingIdentityManifest_approvedAt_idx"
    ON "RoutingIdentityManifest"("approvedAt");

-- Published once and never edited. That is the whole property: a decision
-- names a version, and the version has to still mean what it meant.
CREATE OR REPLACE FUNCTION "routing_identity_manifest_is_immutable"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'RoutingIdentityManifest % is published; publish a new version', OLD."version"
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "routing_identity_manifest_is_immutable_trigger"
    BEFORE UPDATE OR DELETE ON "RoutingIdentityManifest"
    FOR EACH ROW
    EXECUTE FUNCTION "routing_identity_manifest_is_immutable"();

-- TRUNCATE does not fire an ON DELETE trigger, so it walks straight past the
-- row trigger above and needs its own. This stops the application, not the
-- database owner: a superuser can disable a trigger and
-- `session_replication_role = replica` skips it. What it makes impossible is
-- the ordinary mistake.
CREATE OR REPLACE FUNCTION "routing_identity_manifest_is_not_truncatable"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'RoutingIdentityManifest is published history and cannot be truncated'
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "routing_identity_manifest_is_not_truncatable_trigger"
    BEFORE TRUNCATE ON "RoutingIdentityManifest"
    FOR EACH STATEMENT
    EXECUTE FUNCTION "routing_identity_manifest_is_not_truncatable"();

-- ---------------------------------------------------------------------------
-- The attempt's binding
-- ---------------------------------------------------------------------------

ALTER TABLE "RoutingAttempt"
    ADD COLUMN "identityManifestId" TEXT,
    ADD COLUMN "identityManifestDigest" TEXT;

-- Both or neither. An id with no digest cannot detect a manifest that moved,
-- and a digest with no id names nothing.
--
-- Every conjunct is `IS NULL` or `IS NOT NULL`, which cannot evaluate to NULL.
-- A CHECK passes on TRUE *or NULL*, so a branch built from `=` against a
-- nullable column would let the row through -- that is how the allocation axis
-- accepted a seed grain with no mode.
ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_identity_manifest_binding_check"
    CHECK (
        ("identityManifestId" IS NULL AND "identityManifestDigest" IS NULL)
        OR ("identityManifestId" IS NOT NULL AND "identityManifestDigest" IS NOT NULL)
    );

ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_identityManifestDigest_shape_check"
    CHECK (
        "identityManifestDigest" IS NULL
        OR "identityManifestDigest" ~ '^[0-9a-f]{64}$'
    );

CREATE INDEX "RoutingAttempt_identityManifestId_createdAt_idx"
    ON "RoutingAttempt"("identityManifestId", "createdAt")
    WHERE "identityManifestId" IS NOT NULL;

-- RESTRICT, for the reason the grain columns use it: an attempt is a
-- historical record, and deleting the manifest it names must not delete it or
-- drop the attribution.
--
-- Not the same statement twice. The trigger refuses every UPDATE and DELETE on
-- a manifest; the foreign key refuses an id change or a delete *while an
-- attempt points at it*, and it keeps doing that after somebody drops the
-- trigger. What it does not add is a defence against
-- `session_replication_role = replica`, which skips user triggers and foreign
-- key triggers alike -- an earlier version of this comment implied it did.
ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_identityManifestId_fkey"
    FOREIGN KEY ("identityManifestId") REFERENCES "RoutingIdentityManifest"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
