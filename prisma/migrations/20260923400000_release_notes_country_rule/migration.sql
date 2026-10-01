-- The recipient authority for release-notes marketing: what a rule version
-- says, and which countries of which policy version carry it.
--
-- Contract: docs/policy/email-notifications.md section 5.1.1 (the canonical
-- starting values) and the redesign draft's sections 4.1-4.3, 7.6 and 7.8 as
-- that section pins them.
--
-- Nothing here sends anything or changes an existing row. Two new tables; no
-- row is written by this migration. Rules reach the database when an operator
-- creates the next policy draft (lib/emailJurisdictionPolicy.ts) and are read
-- by nothing that sends until S9's verdict does -- the live gate stays
-- MARKETING_ALLOWED_COUNTRY_CODES and the consent gate until then.
--
-- ## Why two tables
--
-- An obligation waiver names a rule by key and version
-- (`EmailSendApproval.ruleKey`/`ruleVersion`, section 7.8), so that pair has to
-- name one content or a waiver applies to a rule nobody approved it for.
--
-- The first version kept the content on each country row and held the rule with
-- a trigger that looked for a row of the same pair disagreeing with it. A
-- review found the hole: the check excluded the row being written, so where a
-- pair had only one row -- the ordinary case -- an UPDATE could change its
-- basis, status or conditions under the same version number and there was
-- nothing to disagree with. The rule was only enforced once somebody had
-- already written a second copy of it.
--
-- So the content moved to a row of its own, keyed by the pair, whose content
-- columns no UPDATE may touch. There is nothing left to compare, and a waiver's
-- scope has a row to point at.
--
-- One transaction, for the reason the ledger migration gives: a table with half
-- its triggers looks enforced and is not.

BEGIN;

CREATE TABLE "ReleaseNotesRuleVersion" (
    "ruleKey" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "countryCode" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "releaseConditions" JSONB NOT NULL DEFAULT '[]',
    "activationGates" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReleaseNotesRuleVersion_pkey" PRIMARY KEY ("ruleKey", "ruleVersion")
);

CREATE INDEX "ReleaseNotesRuleVersion_countryCode_idx"
    ON "ReleaseNotesRuleVersion"("countryCode");

CREATE TABLE "ReleaseNotesCountryRule" (
    "id" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "notes" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReleaseNotesCountryRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReleaseNotesCountryRule_policyVersionId_countryCode_key"
    ON "ReleaseNotesCountryRule"("policyVersionId", "countryCode");

CREATE INDEX "ReleaseNotesCountryRule_ruleKey_ruleVersion_idx"
    ON "ReleaseNotesCountryRule"("ruleKey", "ruleVersion");

ALTER TABLE "ReleaseNotesCountryRule"
    ADD CONSTRAINT "ReleaseNotesCountryRule_policyVersionId_fkey"
    FOREIGN KEY ("policyVersionId") REFERENCES "EmailPolicyVersion"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Restrict, not cascade: a rule version some policy version applies is not
-- deletable, because the verdicts decided under it named that pair.
ALTER TABLE "ReleaseNotesCountryRule"
    ADD CONSTRAINT "ReleaseNotesCountryRule_rule_fkey"
    FOREIGN KEY ("ruleKey", "ruleVersion")
    REFERENCES "ReleaseNotesRuleVersion"("ruleKey", "ruleVersion")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ZZ is reached by absence. A ZZ row would read as a finding about some
-- country rather than the lack of one.
ALTER TABLE "ReleaseNotesRuleVersion" ADD CONSTRAINT "ReleaseNotesRuleVersion_countryCode_check"
    CHECK ("countryCode" ~ '^[A-Z]{2}$' AND "countryCode" <> 'ZZ');

-- The key is derived, so it is checked rather than trusted. A waiver is scoped
-- by (ruleKey, ruleVersion, country); a key naming a different country from its
-- own row would let a waiver for one country apply to another.
ALTER TABLE "ReleaseNotesRuleVersion" ADD CONSTRAINT "ReleaseNotesRuleVersion_ruleKey_check"
    CHECK ("ruleKey" = 'release_notes.' || "countryCode");

ALTER TABLE "ReleaseNotesRuleVersion" ADD CONSTRAINT "ReleaseNotesRuleVersion_ruleVersion_check"
    CHECK ("ruleVersion" >= 1);

-- What the recipient side rests on (lib/releaseNotesCountryRuleCore.ts
-- RELEASE_NOTES_RULE_BASES).
ALTER TABLE "ReleaseNotesRuleVersion" ADD CONSTRAINT "ReleaseNotesRuleVersion_basis_check"
    CHECK ("basis" IN ('opt_out', 'express_consent', 'inferred_consent'));

-- The allowlist (draft section 4.1): a country is open to marketing or not.
ALTER TABLE "ReleaseNotesRuleVersion" ADD CONSTRAINT "ReleaseNotesRuleVersion_status_check"
    CHECK ("status" IN ('open', 'closed'));

ALTER TABLE "ReleaseNotesRuleVersion" ADD CONSTRAINT "ReleaseNotesRuleVersion_shape_check"
    CHECK (
        jsonb_typeof("releaseConditions") = 'array'
        AND jsonb_typeof("activationGates") = 'array'
    );

-- A gate is why a verdict may refuse a basis the contract approved. Only the
-- basis that has one may carry one, or a rule would be held back for a reason
-- no code reads.
ALTER TABLE "ReleaseNotesRuleVersion" ADD CONSTRAINT "ReleaseNotesRuleVersion_gates_check"
    CHECK (
        ("basis" = 'inferred_consent' AND jsonb_array_length("activationGates") > 0)
        OR ("basis" <> 'inferred_consent' AND jsonb_array_length("activationGates") = 0)
    );

ALTER TABLE "ReleaseNotesCountryRule" ADD CONSTRAINT "ReleaseNotesCountryRule_notes_check"
    CHECK (length(btrim("notes")) > 0);

-- The country is on both rows, and the foreign key does not compare them: a
-- rule row could otherwise say Korea while applying the Australian rule, and
-- the unique index is per country, so both would sit there. The rule's own key
-- names its country, so comparing against that is enough.
ALTER TABLE "ReleaseNotesCountryRule" ADD CONSTRAINT "ReleaseNotesCountryRule_ruleKey_check"
    CHECK ("ruleKey" = 'release_notes.' || "countryCode");

-- ## What the triggers hold
--
-- 1. **A rule version is written once and never changes or goes away.** It is
--    what a waiver was approved against and what a verdict recorded, so a
--    different content is a different version number.
--
--    Allowing an unreferenced one to be deleted was the hole a second review
--    found, and it defeated the whole point: create a rule version, delete the
--    draft that referenced it (its country rules cascade away), delete the now
--    orphaned rule version, and insert the same (ruleKey, ruleVersion) with a
--    different content. Every CHECK passes, because the row it would have
--    disagreed with is gone. So a rule version outlives the draft that
--    introduced it, even one nobody ever used: the pair is a name, and a name
--    that can be freed is a name that can come to mean something else.
--
-- 2. **Only a draft's country rules can be written.** An active or superseded
--    version is what some verdict was decided under, and editing its rules in
--    place would rewrite what was true at send time. A delete is allowed when
--    the version row itself is already gone -- the cascade from deleting a
--    draft arrives after its parent -- and refused while the version exists and
--    is not a draft.

CREATE FUNCTION "release_notes_rule_version_immutable"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '% version % cannot be deleted; a rule version is a name, and a name that can be freed can come to mean something else.',
            OLD."ruleKey", OLD."ruleVersion"
            USING ERRCODE = 'check_violation';
    END IF;

    -- Every column, `createdAt` included. It is this row's provenance and
    -- nothing reads it to decide a send, but a row whose content cannot change
    -- while its timestamp can is append-only in the part somebody checked and
    -- not in the part they would cite.
    IF NEW."ruleKey" IS DISTINCT FROM OLD."ruleKey"
       OR NEW."ruleVersion" IS DISTINCT FROM OLD."ruleVersion"
       OR NEW."countryCode" IS DISTINCT FROM OLD."countryCode"
       OR NEW."basis" IS DISTINCT FROM OLD."basis"
       OR NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."releaseConditions" IS DISTINCT FROM OLD."releaseConditions"
       OR NEW."activationGates" IS DISTINCT FROM OLD."activationGates"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    THEN
        RAISE EXCEPTION '% version % already names a rule; a different content is a new version.',
            OLD."ruleKey", OLD."ruleVersion"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "release_notes_rule_version_immutable"
    BEFORE UPDATE OR DELETE ON "ReleaseNotesRuleVersion"
    FOR EACH ROW EXECUTE FUNCTION "release_notes_rule_version_immutable"();

-- Table names are qualified with the trigger's own schema, as the ledger's
-- triggers do, so the function works in whichever schema the table lives in and
-- never resolves a name through a caller's search_path.
--
-- The parent is read FOR SHARE. Activation updates that row, so a rule written
-- while a draft is being activated either waits for the activation and then
-- sees the new status, or holds the activation back until the rule is committed
-- into what was still a draft. Neither order leaves a rule added to an active
-- version.
CREATE FUNCTION "release_notes_country_rule_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    version_status TEXT;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        EXECUTE pg_catalog.format(
            'SELECT v."status" FROM %I."EmailPolicyVersion" v WHERE v."id" = $1 FOR SHARE',
            TG_TABLE_SCHEMA
        ) INTO version_status USING OLD."policyVersionId";
        -- NULL means the version row is gone: this is the cascade from deleting
        -- it, which arrives after the parent. Whether a version may be deleted
        -- is the version's question, not this table's.
        IF version_status IS NOT NULL AND version_status <> 'draft' THEN
            RAISE EXCEPTION 'ReleaseNotesCountryRule % belongs to a % policy version and cannot be changed (%).',
                OLD."id", version_status, TG_OP
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    EXECUTE pg_catalog.format(
        'SELECT v."status" FROM %I."EmailPolicyVersion" v WHERE v."id" = $1 FOR SHARE',
        TG_TABLE_SCHEMA
    ) INTO version_status USING NEW."policyVersionId";
    -- NULL here is a missing parent, which the foreign key refuses on its own.
    IF version_status IS NOT NULL AND version_status <> 'draft' THEN
        RAISE EXCEPTION 'ReleaseNotesCountryRule rows can only be written to a draft policy version (this one is %).',
            version_status
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "release_notes_country_rule_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "ReleaseNotesCountryRule"
    FOR EACH ROW EXECUTE FUNCTION "release_notes_country_rule_guard"();

COMMIT;
