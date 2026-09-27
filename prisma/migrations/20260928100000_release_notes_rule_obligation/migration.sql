-- The statutory duties one country's rule carries in one policy version, and
-- how each one is settled.
--
-- Contract: docs/policy/email-product-news-redesign-draft.md sections 7.7 and
-- 7.8.
--
-- Nothing here sends anything. One new table; no row is written by this
-- migration. Duty states reach the database when an operator creates the next
-- policy draft (lib/emailJurisdictionPolicy.ts), and no send reads them until
-- S9's verdict does.
--
-- ## Why a state must carry its own evidence
--
-- Section 7.8 replaced "one missing duty disables the Korean rule" with three
-- settled states, because the accident that rule guarded against was a duty
-- nobody noticed had gone, not an owner deciding in writing not to do one. So
-- each state names what makes it true, and the CHECK below is what stops a row
-- from claiming a state without it: `implemented` names the readiness check,
-- `deferred` the date it must exist by, `waived` the approval that decided it.
--
-- A duty with **no row** is unsettled and blocks its rule. That is the whole
-- mechanism and it lives in `lib/releaseNotesObligationCore.ts`, which declares
-- the duties that exist; this table holds only what has been settled.
--
-- The duty hangs off the **country rule**, which is what section 7.8 says and
-- what a waiver's scope requires: an `obligation_waiver` names a policy version,
-- a rule key, a rule version, a country and a duty key, and the verdict compares
-- all five.
--
-- The first version keyed these on the rule version alone, and a review showed
-- that cannot express it: two policy versions carrying the same rule version
-- would share one duty row, so a waiver approved under one of them failed under
-- the other, and rewriting the row to suit the new one broke the old. The
-- country rule is per policy version, so the key and the scope now agree.
--
-- Unlike the rule version's own content, a duty state changes over time -- a
-- deferral becomes an implementation -- so these rows are not append-only. What
-- protects them is that every state still has to produce its evidence, and the
-- only state that can loosen a send is `waived`, which needs a sealed approval
-- that nothing but a person can write.
--
-- One transaction, for the reason the ledger migration gives.

BEGIN;

CREATE TABLE "ReleaseNotesRuleObligation" (
    "countryRuleId" TEXT NOT NULL,
    "obligationKey" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "readinessCheck" TEXT,
    "dueBy" TIMESTAMP(3),
    "warnDaysBefore" INTEGER,
    "waiverApprovalId" TEXT,
    "waiverApprovalType" TEXT,
    "notes" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReleaseNotesRuleObligation_pkey" PRIMARY KEY ("countryRuleId", "obligationKey")
);

CREATE INDEX "ReleaseNotesRuleObligation_waiverApprovalId_idx"
    ON "ReleaseNotesRuleObligation"("waiverApprovalId");

-- Cascade, unlike the rule version's own foreign key: a duty state is about one
-- policy version's rule, so a draft thrown away takes its duty states with it.
-- What must not disappear is the rule version, which a waiver names.
ALTER TABLE "ReleaseNotesRuleObligation"
    ADD CONSTRAINT "ReleaseNotesRuleObligation_countryRule_fkey"
    FOREIGN KEY ("countryRuleId")
    REFERENCES "ReleaseNotesCountryRule"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The pair, not the id alone. `EmailSendApproval` carries a unique on
-- (id, approvalType) for exactly this: a waiver has to be an approval of type
-- `obligation_waiver`, and naming only the id would let a `risk_accepted`
-- override stand in for one. The type column is held to that single value by
-- the CHECK below, so the pair cannot name anything else.
ALTER TABLE "ReleaseNotesRuleObligation"
    ADD CONSTRAINT "ReleaseNotesRuleObligation_waiver_fkey"
    FOREIGN KEY ("waiverApprovalId", "waiverApprovalType")
    REFERENCES "EmailSendApproval"("id", "approvalType")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReleaseNotesRuleObligation" ADD CONSTRAINT "ReleaseNotesRuleObligation_state_check"
    CHECK ("state" IN ('implemented', 'deferred', 'waived'));

ALTER TABLE "ReleaseNotesRuleObligation" ADD CONSTRAINT "ReleaseNotesRuleObligation_waiverApprovalType_check"
    CHECK ("waiverApprovalType" IS NULL OR "waiverApprovalType" = 'obligation_waiver');

-- Each state's evidence, and only its own. A row carrying another state's
-- evidence is one a reader would have to guess about: an `implemented` duty
-- with a deadline says nothing about whether it is done, and a `waived` one
-- naming a readiness check invites somebody to think the check is what settled
-- it rather than the approval.
ALTER TABLE "ReleaseNotesRuleObligation" ADD CONSTRAINT "ReleaseNotesRuleObligation_evidence_check"
    CHECK (
        ("state" = 'implemented'
            AND "readinessCheck" IS NOT NULL AND length(btrim("readinessCheck")) > 0
            AND "dueBy" IS NULL AND "warnDaysBefore" IS NULL
            AND "waiverApprovalId" IS NULL AND "waiverApprovalType" IS NULL)
        OR ("state" = 'deferred'
            AND "dueBy" IS NOT NULL AND "warnDaysBefore" IS NOT NULL
            AND "readinessCheck" IS NULL
            AND "waiverApprovalId" IS NULL AND "waiverApprovalType" IS NULL)
        OR ("state" = 'waived'
            AND "waiverApprovalId" IS NOT NULL AND "waiverApprovalType" IS NOT NULL
            AND "readinessCheck" IS NULL
            AND "dueBy" IS NULL AND "warnDaysBefore" IS NULL)
    );

-- A deferral carries its warning window, and the window is a window. Section
-- 7.7 asks a deferred duty for a date *and* a device that stops the date being
-- forgotten, and the first version let the second be NULL -- which reads as "no
-- warning" and passes, so the row that most needs a reminder is the one that can
-- be stored without one. The clause above makes it required for `deferred`; this
-- one keeps it absent everywhere else and positive where it is present.
ALTER TABLE "ReleaseNotesRuleObligation" ADD CONSTRAINT "ReleaseNotesRuleObligation_warnDaysBefore_check"
    CHECK ("warnDaysBefore" IS NULL OR "warnDaysBefore" > 0);

ALTER TABLE "ReleaseNotesRuleObligation" ADD CONSTRAINT "ReleaseNotesRuleObligation_notes_check"
    CHECK (length(btrim("notes")) > 0);

-- ## What the trigger holds (the seal, and the scope)
--
-- A waiver may only be named while it is sealed. An unsealed approval is one
-- somebody is still writing, and a duty that pointed at it would be settled by
-- a decision not yet made; the verdict checks the same thing at send time
-- (`obligationsVerdict()`), and this is so the row cannot be written that way in
-- the first place.
--
-- The scope too, and not only the seal. An `obligation_waiver`'s scope names a
-- policy version, a rule key, a rule version, a country and an obligation key
-- (section 7.8), and the foreign key only holds the pair (id, type). So an
-- approval waiving Singapore's subject label could be named by Korea's
-- fourteen-day notice, and the row would read `waived` -- which the verdict
-- refuses at send time, but the stored state and the admin screen would both
-- say a duty was waived that nobody waived. A review found exactly that.
--
-- Every member is compared, and `IS DISTINCT FROM` so a NULL on either side is
-- a mismatch rather than a comparison that answers nothing. The duty's own rule
-- is read through `countryRuleId`, which is where its scope actually lives.
--
-- Revocation is deliberately *not* checked here. A revoked waiver has to stay
-- named: the duty goes back to unsettled and the rule stops sending, which is
-- what a revocation is for, and deleting the link would erase the record of
-- what had been decided. Section 7.8 says the admin screen shows it as it is.
CREATE FUNCTION "release_notes_rule_obligation_waiver_scope"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    approval RECORD;
    rule RECORD;
BEGIN
    IF NEW."waiverApprovalId" IS NULL THEN
        RETURN NEW;
    END IF;

    EXECUTE pg_catalog.format(
        'SELECT a."sealedAt", a."policyVersionId", a."ruleKey", a."ruleVersion",
                a."country", a."obligationKey"
         FROM %I."EmailSendApproval" a WHERE a."id" = $1 FOR SHARE',
        TG_TABLE_SCHEMA
    ) INTO approval USING NEW."waiverApprovalId";

    IF approval."sealedAt" IS NULL THEN
        RAISE EXCEPTION 'EmailSendApproval % is not sealed, so it cannot waive %.',
            NEW."waiverApprovalId", NEW."obligationKey"
            USING ERRCODE = 'check_violation';
    END IF;

    -- FOR SHARE on the rule as well: the scope compared here has to still be
    -- the scope when this commits, and the rule version is the one a waiver
    -- names.
    EXECUTE pg_catalog.format(
        'SELECT r."policyVersionId", r."countryCode", r."ruleKey", r."ruleVersion"
         FROM %I."ReleaseNotesCountryRule" r WHERE r."id" = $1 FOR SHARE',
        TG_TABLE_SCHEMA
    ) INTO rule USING NEW."countryRuleId";

    IF rule IS NULL THEN
        RAISE EXCEPTION 'ReleaseNotesCountryRule % does not exist.', NEW."countryRuleId"
            USING ERRCODE = 'check_violation';
    END IF;

    IF approval."policyVersionId" IS DISTINCT FROM rule."policyVersionId"
        OR approval."ruleKey" IS DISTINCT FROM rule."ruleKey"
        OR approval."ruleVersion" IS DISTINCT FROM rule."ruleVersion"
        OR approval."country" IS DISTINCT FROM rule."countryCode"
        OR approval."obligationKey" IS DISTINCT FROM NEW."obligationKey"
    THEN
        RAISE EXCEPTION
            'EmailSendApproval % waives %/%/% version %, not %/% of rule % version %.',
            NEW."waiverApprovalId", approval."country", approval."ruleKey",
            approval."obligationKey", approval."ruleVersion",
            rule."countryCode", NEW."obligationKey", rule."ruleKey", rule."ruleVersion"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "release_notes_rule_obligation_waiver_scope"
    BEFORE INSERT OR UPDATE ON "ReleaseNotesRuleObligation"
    FOR EACH ROW EXECUTE FUNCTION "release_notes_rule_obligation_waiver_scope"();

COMMIT;
