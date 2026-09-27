-- The recipient authority for release-notes marketing: one rule per country
-- per policy version.
--
-- Contract: docs/policy/email-notifications.md section 5.1.1 (the canonical
-- starting values) and the redesign draft's sections 4.1-4.3, 7.6 and 7.8 as
-- that section pins them.
--
-- Nothing here sends anything or changes an existing row. One new table; no
-- row is written by this migration. Rules reach the database when an operator
-- creates the next policy draft (lib/emailJurisdictionPolicy.ts) and are read
-- by nothing that sends until S9's verdict does -- the live gate stays
-- MARKETING_ALLOWED_COUNTRY_CODES and the consent gate until then.
--
-- One transaction, for the reason the ledger migration gives: a table with
-- half its triggers looks enforced and is not.

BEGIN;

CREATE TABLE "ReleaseNotesCountryRule" (
    "id" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "basis" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '[]',
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

-- What the recipient side rests on (lib/releaseNotesCountryRuleCore.ts
-- RELEASE_NOTES_RULE_BASES).
ALTER TABLE "ReleaseNotesCountryRule" ADD CONSTRAINT "ReleaseNotesCountryRule_basis_check"
    CHECK ("basis" IN ('opt_out', 'express_consent', 'inferred_consent'));

-- The allowlist (draft section 4.1): a country is open to marketing or not.
ALTER TABLE "ReleaseNotesCountryRule" ADD CONSTRAINT "ReleaseNotesCountryRule_status_check"
    CHECK ("status" IN ('open', 'closed'));

-- ZZ is reached by absence. A ZZ row would read as a finding about some
-- country rather than the lack of one.
ALTER TABLE "ReleaseNotesCountryRule" ADD CONSTRAINT "ReleaseNotesCountryRule_countryCode_check"
    CHECK ("countryCode" ~ '^[A-Z]{2}$' AND "countryCode" <> 'ZZ');

-- The key is derived, so it is checked rather than trusted. An obligation
-- waiver is scoped by (ruleKey, ruleVersion, country); a key that named a
-- different country from its own row would let a waiver for one country
-- apply to another.
ALTER TABLE "ReleaseNotesCountryRule" ADD CONSTRAINT "ReleaseNotesCountryRule_ruleKey_check"
    CHECK ("ruleKey" = 'release_notes.' || "countryCode");

ALTER TABLE "ReleaseNotesCountryRule" ADD CONSTRAINT "ReleaseNotesCountryRule_ruleVersion_check"
    CHECK ("ruleVersion" >= 1);

ALTER TABLE "ReleaseNotesCountryRule" ADD CONSTRAINT "ReleaseNotesCountryRule_shape_check"
    CHECK (jsonb_typeof("conditions") = 'array' AND length(btrim("notes")) > 0);

-- Two rules the triggers enforce, because neither is a property of one row.
--
-- 1. **Only a draft's rules can be written.** An active or superseded version
--    is what some verdict was decided under, and editing its rules in place
--    would rewrite what was true at send time. A delete is allowed when the
--    version row itself is already gone -- the cascade from deleting a draft
--    arrives after its parent -- and refused while the version exists and is
--    not a draft.
--
-- 2. **One (ruleKey, ruleVersion) is one content.** A waiver approval names a
--    rule by that pair (EmailSendApproval_scope_check). If two policy versions
--    carried the same pair with different bases or statuses, the waiver would
--    apply to a rule nobody approved it for. So a row may reuse a pair only
--    with the same basis, status and conditions; anything else is a new
--    version number. `notes` is prose and may differ. The advisory lock keys
--    on the pair so two drafts written at once cannot both be the first.

-- Table names are qualified with the trigger's own schema, as the ledger's
-- triggers do, so the function works in whichever schema the table lives in
-- and never resolves a name through a caller's search_path.
--
-- The parent is read FOR SHARE. Activation updates that row, so a rule
-- written while a draft is being activated either waits for the activation
-- and then sees the new status, or holds the activation back until the rule
-- is committed into what was still a draft. Neither order leaves a rule
-- added to an active version.
CREATE FUNCTION "release_notes_country_rule_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    version_status TEXT;
    clash_id TEXT;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        EXECUTE pg_catalog.format(
            'SELECT v."status" FROM %I."EmailPolicyVersion" v WHERE v."id" = $1 FOR SHARE',
            TG_TABLE_SCHEMA
        ) INTO version_status USING OLD."policyVersionId";
        -- NULL means the version row is gone: this is the cascade from
        -- deleting it, which arrives after the parent. Whether a version may
        -- be deleted is the version's question, not this table's.
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

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(NEW."ruleKey" || ':' || NEW."ruleVersion"::text, 0)
    );

    EXECUTE pg_catalog.format(
        'SELECT r."id" FROM %I."ReleaseNotesCountryRule" r
          WHERE r."ruleKey" = $1 AND r."ruleVersion" = $2 AND r."id" <> $3
            AND (r."basis" <> $4 OR r."status" <> $5 OR r."conditions" <> $6)
          LIMIT 1',
        TG_TABLE_SCHEMA
    ) INTO clash_id
      USING NEW."ruleKey", NEW."ruleVersion", NEW."id", NEW."basis", NEW."status", NEW."conditions";
    IF clash_id IS NOT NULL THEN
        RAISE EXCEPTION '% version % already names a different rule (row %); use a new rule version.',
            NEW."ruleKey", NEW."ruleVersion", clash_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "release_notes_country_rule_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "ReleaseNotesCountryRule"
    FOR EACH ROW EXECUTE FUNCTION "release_notes_country_rule_guard"();

COMMIT;
