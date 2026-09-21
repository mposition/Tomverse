-- The permission ledger: the facts a basis rests on, the human decisions that
-- override or waive, and what each send decided.
--
-- Contract: docs/policy/email-product-news-redesign-draft.md, sections 5.6, 6,
-- 7.6 and 7.8. Data model: docs/policy/email-notifications.md section 10.2.1.
--
-- Nothing here sends anything, reads a provider or changes an existing row.
-- Six new tables and their constraints; the send path still refuses marketing
-- because feature.emailMarketingEnabled is off and no country rule exists yet.
--
-- One transaction. Prisma does not wrap a migration file for us, and this one
-- is six tables, twenty constraints, nine functions and eight triggers: a
-- failure in the middle would leave a ledger that is half enforced, which is
-- worse than no ledger at all because it looks like one. Nothing here needs to
-- run outside a transaction -- no CONCURRENTLY, no database-level statement.

BEGIN;

CREATE TABLE "EmailPermissionEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "emailAddress" TEXT NOT NULL,
    "addressNormalizationVersion" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "capturedVia" TEXT NOT NULL,
    "sourceEventKey" TEXT NOT NULL,
    "jurisdiction" TEXT,
    "jurisdictionSource" TEXT,
    "policyVersionId" TEXT NOT NULL,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailPermissionEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmailSendApproval" (
    "id" TEXT NOT NULL,
    "approvalType" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "approvedByEmail" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "reviewCondition" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "ruleKey" TEXT,
    "ruleVersion" INTEGER,
    "country" TEXT,
    "obligationKey" TEXT,
    "purposeKey" TEXT,
    "sealedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSendApproval_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmailSendApprovalMember" (
    "id" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "addressDigest" TEXT NOT NULL,
    "addressNormalizationVersion" TEXT NOT NULL,
    "noticeAnchorAt" TIMESTAMP(3) NOT NULL,
    "noticeAnchorSource" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSendApprovalMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmailSendApprovalRevocation" (
    "id" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "revokedById" TEXT NOT NULL,
    "revokedByEmail" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSendApprovalRevocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmailPermissionDecision" (
    "deliveryId" TEXT,
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "phase" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "addressNormalizationVersion" TEXT NOT NULL,
    "authorities" JSONB NOT NULL,
    "legalAllowed" BOOLEAN NOT NULL,
    "overrideApprovalId" TEXT,
    "overrideType" TEXT,
    "blockers" JSONB NOT NULL,
    "allowed" BOOLEAN NOT NULL,
    "pinnedDisplayContractHash" TEXT,
    "requiredDisplayContractHash" TEXT,
    "displayContractSatisfied" BOOLEAN,
    "countryCandidates" JSONB,
    "ruleVersions" JSONB,
    "policyVersionId" TEXT NOT NULL,
    "suppressionCheckedAt" TIMESTAMP(3),
    "providerSubmittedAt" TIMESTAMP(3),
    "sealedAt" TIMESTAMP(3),
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailPermissionDecision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmailPermissionDecisionEvidence" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "eventId" TEXT,
    "consentRecordId" TEXT,
    "authority" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailPermissionDecisionEvidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailPermissionEvent_kind_source_event_key" ON "EmailPermissionEvent"("kind", "sourceEventKey");
CREATE INDEX "EmailPermissionEvent_userId_kind_occurredAt_idx" ON "EmailPermissionEvent"("userId", "kind", "occurredAt");
CREATE INDEX "EmailPermissionEvent_emailAddress_kind_occurredAt_idx" ON "EmailPermissionEvent"("emailAddress", "kind", "occurredAt");
CREATE INDEX "EmailPermissionEvent_policyVersionId_idx" ON "EmailPermissionEvent"("policyVersionId");

CREATE UNIQUE INDEX "EmailSendApproval_id_type_key" ON "EmailSendApproval"("id", "approvalType");
CREATE INDEX "EmailSendApproval_approvalType_approvedAt_idx" ON "EmailSendApproval"("approvalType", "approvedAt");
CREATE INDEX "EmailSendApproval_policyVersionId_idx" ON "EmailSendApproval"("policyVersionId");

CREATE UNIQUE INDEX "EmailSendApprovalMember_approvalId_userId_key" ON "EmailSendApprovalMember"("approvalId", "userId");
CREATE INDEX "EmailSendApprovalMember_approvalId_addressDigest_idx" ON "EmailSendApprovalMember"("approvalId", "addressDigest");
CREATE INDEX "EmailSendApprovalMember_userId_idx" ON "EmailSendApprovalMember"("userId");

CREATE INDEX "EmailSendApprovalRevocation_approvalId_revokedAt_idx" ON "EmailSendApprovalRevocation"("approvalId", "revokedAt");

CREATE UNIQUE INDEX "EmailPermissionDecision_delivery_phase" ON "EmailPermissionDecision"("deliveryId", "phase");
CREATE INDEX "EmailPermissionDecision_userId_evaluatedAt_idx" ON "EmailPermissionDecision"("userId", "evaluatedAt");
CREATE INDEX "EmailPermissionDecision_emailAddress_evaluatedAt_idx" ON "EmailPermissionDecision"("emailAddress", "evaluatedAt");
CREATE INDEX "EmailPermissionDecision_overrideApprovalId_idx" ON "EmailPermissionDecision"("overrideApprovalId");
CREATE INDEX "EmailPermissionDecision_policyVersionId_idx" ON "EmailPermissionDecision"("policyVersionId");

CREATE UNIQUE INDEX "EmailPermissionDecisionEvidence_event_key" ON "EmailPermissionDecisionEvidence"("decisionId", "authority", "eventId");
CREATE UNIQUE INDEX "EmailPermissionDecisionEvidence_consent_key" ON "EmailPermissionDecisionEvidence"("decisionId", "authority", "consentRecordId");
CREATE INDEX "EmailPermissionDecisionEvidence_eventId_idx" ON "EmailPermissionDecisionEvidence"("eventId");
CREATE INDEX "EmailPermissionDecisionEvidence_consentRecordId_idx" ON "EmailPermissionDecisionEvidence"("consentRecordId");

ALTER TABLE "EmailPermissionEvent" ADD CONSTRAINT "EmailPermissionEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EmailPermissionEvent" ADD CONSTRAINT "EmailPermissionEvent_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "EmailPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmailSendApproval" ADD CONSTRAINT "EmailSendApproval_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "EmailPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmailSendApprovalMember" ADD CONSTRAINT "EmailSendApprovalMember_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "EmailSendApproval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmailSendApprovalRevocation" ADD CONSTRAINT "EmailSendApprovalRevocation_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "EmailSendApproval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "EmailDelivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_overrideApprovalId_overrideType_fkey" FOREIGN KEY ("overrideApprovalId", "overrideType") REFERENCES "EmailSendApproval"("id", "approvalType") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "EmailPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmailPermissionDecisionEvidence" ADD CONSTRAINT "EmailPermissionDecisionEvidence_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "EmailPermissionDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailPermissionDecisionEvidence" ADD CONSTRAINT "EmailPermissionDecisionEvidence_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "EmailPermissionEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmailPermissionDecisionEvidence" ADD CONSTRAINT "EmailPermissionDecisionEvidence_consentRecordId_fkey" FOREIGN KEY ("consentRecordId") REFERENCES "ConsentRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Closed lists. Each one is also a list in the application, and
-- scripts/check-enum-constraints.mjs compares them on every run.

ALTER TABLE "EmailPermissionEvent" ADD CONSTRAINT "EmailPermissionEvent_kind_check"
    CHECK ("kind" IN ('notice_shown', 'objected', 'relationship_started', 'relationship_ended', 'basis_ended'));

ALTER TABLE "EmailPermissionEvent" ADD CONSTRAINT "EmailPermissionEvent_capturedVia_check"
    CHECK ("capturedVia" IN ('signup_form', 'preference_center', 'unsubscribe_page', 'in_product_notice', 'admin', 'system', 'provider_complaint'));

-- What a fact can be about: one purpose, one classification, or the address
-- itself.
--
-- "not empty" was not a closed set, and this table is append-only: a typo goes
-- in once and stays forever, readable by nothing. A fact scoped to
-- 'product_udpates' is a fact no verdict will ever find, and no later write can
-- correct it.
ALTER TABLE "EmailPermissionEvent" ADD CONSTRAINT "EmailPermissionEvent_scopeKey_check"
    CHECK ("scopeKey" IN (
        '*',
        'transactional', 'service', 'marketing',
        'security', 'billing', 'service_status',
        'product_updates', 'newsletter', 'promotions'
    ));

ALTER TABLE "EmailSendApproval" ADD CONSTRAINT "EmailSendApproval_approvalType_check"
    CHECK ("approvalType" IN ('risk_accepted', 'obligation_waiver'));

-- The two kinds need different scopes, and a row carrying the other kind's
-- scope is one the verdict would compare against the wrong four columns. A
-- waiver names exactly which obligation of which country rule it waives; an
-- override names the purpose it covers and has no obligation at all.
ALTER TABLE "EmailSendApproval" ADD CONSTRAINT "EmailSendApproval_scope_check"
    CHECK (
        ("approvalType" = 'obligation_waiver'
            AND "ruleKey" IS NOT NULL AND "ruleVersion" IS NOT NULL
            AND "country" IS NOT NULL AND "obligationKey" IS NOT NULL
            AND "purposeKey" IS NULL)
        OR
        ("approvalType" = 'risk_accepted'
            AND "purposeKey" IN (
                '*', 'security', 'billing', 'service_status',
                'product_updates', 'newsletter', 'promotions'
            )
            AND "ruleKey" IS NULL AND "ruleVersion" IS NULL
            AND "country" IS NULL AND "obligationKey" IS NULL)
    );

-- An approval cannot be closed before it was given. Without this, sealing with
-- a backdated timestamp would make the seal look like part of the approval
-- rather than a later act, and the one writer who got it wrong would leave a
-- row nobody could tell from a correct one.
ALTER TABLE "EmailSendApproval" ADD CONSTRAINT "EmailSendApproval_sealedAt_order_check"
    CHECK ("sealedAt" IS NULL OR ("sealedAt" >= "approvedAt" AND "sealedAt" >= "createdAt"));

ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_phase_check"
    CHECK ("phase" IN ('enqueue', 'send'));

ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_classification_check"
    CHECK ("classification" IN ('transactional', 'service', 'marketing'));

-- The purpose, and the pair.
--
-- Closing the classification alone left two holes. An unregistered purpose
-- stored a permanent verdict about mail this product does not send; and
-- 'product_updates' with classification 'service' stored a verdict saying the
-- marketing switches did not apply to marketing mail. The second is the exact
-- defect the S0 amendment removed from the classification table, and a row
-- here could have reintroduced it one verdict at a time.
--
-- The pairs are lib/emailPreferenceCore.ts's EMAIL_PURPOSE_CLASSIFICATION, and
-- tests/emailPurposeClassification.test.mjs holds the two together.
ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_purpose_check"
    CHECK ("purpose" IN ('security', 'billing', 'service_status', 'product_updates', 'newsletter', 'promotions'));

ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_purpose_classification_check"
    CHECK (
        ("classification" = 'transactional' AND "purpose" IN ('security', 'billing'))
        OR ("classification" = 'service' AND "purpose" = 'service_status')
        OR ("classification" = 'marketing' AND "purpose" IN ('product_updates', 'newsletter', 'promotions'))
    );

-- An override is a reference plus the kind of decision it was. Half of it is
-- a row that either cannot be resolved or cannot be read. The composite
-- foreign key above makes the pair name a real approval of that exact type.
ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_override_pair_check"
    CHECK (("overrideApprovalId" IS NULL) = ("overrideType" IS NULL));

ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_overrideType_check"
    CHECK ("overrideType" IS NULL OR "overrideType" IN ('risk_accepted'));

-- Section 5.6 rule 2: the verdict keeps the refusal. A row that both used an
-- override and claims the authorities allowed it is the row that lets the next
-- reader take a business decision for a consent.
ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_override_keeps_refusal_check"
    CHECK ("overrideApprovalId" IS NULL OR "legalAllowed" = FALSE);

ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_json_shape_check"
    CHECK (jsonb_typeof("authorities") = 'array' AND jsonb_typeof("blockers") = 'array');

-- allowed is derived, so it is computed here too. Two places saying it is the
-- point: the application can be wrong about one row, and this refuses to store
-- the row it was wrong about.
ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_allowed_derivation_check"
    CHECK ("allowed" = (("legalAllowed" OR "overrideApprovalId" IS NOT NULL) AND jsonb_array_length("blockers") = 0));

ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_sealedAt_order_check"
    CHECK ("sealedAt" IS NULL OR "sealedAt" >= "createdAt");

-- What a provider submission means, written down.
--
-- "After the evidence closed" was not enough on its own: it let an enqueue
-- verdict record a submission, and it let a refused one. Neither can happen --
-- the message is handed over once, at send, only when the verdict allowed it
-- and only after suppression was read -- so a row saying otherwise is a row
-- about a send that did not occur, sitting in the ledger a regulator reads.
--
-- The timestamps are ordered for the same reason. `suppressionCheckedAt` is
-- the gap section 7.4 is about; if it could sit after the handover the gap
-- would be unmeasurable, which is the one thing this column exists for.
ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_submission_check"
    CHECK (
        "providerSubmittedAt" IS NULL
        OR (
            "phase" = 'send'
            AND "allowed" = TRUE
            AND "deliveryId" IS NOT NULL
            AND "sealedAt" IS NOT NULL
            AND "suppressionCheckedAt" IS NOT NULL
            AND "suppressionCheckedAt" >= "evaluatedAt"
            AND "sealedAt" >= "evaluatedAt"
            AND "providerSubmittedAt" >= "sealedAt"
            AND "providerSubmittedAt" >= "suppressionCheckedAt"
        )
    );

-- Exactly one source per evidence row. A row citing both would be one fact in
-- two ledgers, which is the thing the three-layer split exists to prevent; a
-- row citing neither is a claim with nothing behind it.
ALTER TABLE "EmailPermissionDecisionEvidence" ADD CONSTRAINT "EmailPermissionDecisionEvidence_one_source_check"
    CHECK (("eventId" IS NULL) <> ("consentRecordId" IS NULL));

-- Append-only, enforced where it cannot be forgotten.
--
-- The application is not the place for this. An append-only ledger that one
-- stray update can rewrite is not evidence, and the writer who would make that
-- update is the one who did not read the comment saying not to.
--
-- The one update each of these two tables must accept is the foreign key's
-- own: `ON DELETE SET NULL` from User is performed as an UPDATE of the
-- referencing row, and a blanket refusal would make deleting an account fail
-- as soon as it had a single ledger row. That transition -- userId losing its
-- value, nothing else moving -- is exactly the anonymisation the registry
-- records, so it is the only one allowed.

CREATE FUNCTION "email_ledger_only_detach"(old_value TEXT, new_value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT old_value IS NOT NULL AND new_value IS NULL;
$$;

CREATE FUNCTION "email_permission_event_append_only"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'EmailPermissionEvent is append-only (DELETE).'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NOT "email_ledger_only_detach"(OLD."userId", NEW."userId") THEN
        RAISE EXCEPTION 'EmailPermissionEvent is append-only (UPDATE).'
            USING ERRCODE = 'check_violation';
    END IF;

    IF ROW(NEW."id", NEW."emailAddress", NEW."addressNormalizationVersion", NEW."kind",
           NEW."scopeKey", NEW."occurredAt", NEW."capturedVia", NEW."sourceEventKey",
           NEW."jurisdiction", NEW."jurisdictionSource", NEW."policyVersionId",
           NEW."evidence", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."emailAddress", OLD."addressNormalizationVersion", OLD."kind",
           OLD."scopeKey", OLD."occurredAt", OLD."capturedVia", OLD."sourceEventKey",
           OLD."jurisdiction", OLD."jurisdictionSource", OLD."policyVersionId",
           OLD."evidence", OLD."createdAt") THEN
        RAISE EXCEPTION 'EmailPermissionEvent accepts no change but detaching its account.'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "email_permission_event_append_only"
    BEFORE UPDATE OR DELETE ON "EmailPermissionEvent"
    FOR EACH ROW EXECUTE FUNCTION "email_permission_event_append_only"();

-- A withdrawal is append-only, and it can only withdraw something that was
-- given. An approval is not given until it is sealed -- before that it is a
-- draft being assembled inside one transaction -- so a revocation of an
-- unsealed row, or one dated before the seal, describes an act that could not
-- have happened. The ordering matters beyond tidiness: "was this approval live
-- when that message went out" is answered by comparing the send against
-- `revokedAt`, and a timestamp that precedes the approval makes every such
-- comparison wrong in the same direction.
CREATE FUNCTION "email_send_approval_revocation_append_only"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    sealed TIMESTAMP(3);
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'EmailSendApprovalRevocation is append-only (%).', TG_OP
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT a."sealedAt" INTO sealed
        FROM "EmailSendApproval" a
        WHERE a."id" = NEW."approvalId"
        FOR SHARE;

    IF sealed IS NULL THEN
        RAISE EXCEPTION 'EmailSendApproval % is not sealed, so there is nothing to withdraw.',
            NEW."approvalId"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."revokedAt" < sealed THEN
        RAISE EXCEPTION 'EmailSendApprovalRevocation cannot precede the seal of approval %.',
            NEW."approvalId"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "email_send_approval_revocation_append_only"
    BEFORE INSERT OR UPDATE OR DELETE ON "EmailSendApprovalRevocation"
    FOR EACH ROW EXECUTE FUNCTION "email_send_approval_revocation_append_only"();

-- Sealing. Before sealedAt is set the row is a draft being assembled inside one
-- transaction; the moment it is set, the approval and its whole membership stop
-- moving. The only update a sealed-free row may take is the one that seals it,
-- and that update may not change anything else -- otherwise "seal it" becomes a
-- way to edit an approval and close it in the same statement.

CREATE FUNCTION "email_send_approval_seal"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."sealedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'EmailSendApproval % is sealed and cannot be deleted.', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD."sealedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'EmailSendApproval % is sealed and cannot be changed.', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."sealedAt" IS NULL THEN
        RAISE EXCEPTION 'EmailSendApproval % may only be updated to seal it.', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF ROW(NEW."id", NEW."approvalType", NEW."approvedById", NEW."approvedByEmail",
           NEW."approvedAt", NEW."reason", NEW."reviewCondition", NEW."policyVersionId",
           NEW."ruleKey", NEW."ruleVersion", NEW."country", NEW."obligationKey",
           NEW."purposeKey", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."approvalType", OLD."approvedById", OLD."approvedByEmail",
           OLD."approvedAt", OLD."reason", OLD."reviewCondition", OLD."policyVersionId",
           OLD."ruleKey", OLD."ruleVersion", OLD."country", OLD."obligationKey",
           OLD."purposeKey", OLD."createdAt") THEN
        RAISE EXCEPTION 'EmailSendApproval % may not change while being sealed.', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "email_send_approval_seal"
    BEFORE UPDATE OR DELETE ON "EmailSendApproval"
    FOR EACH ROW EXECUTE FUNCTION "email_send_approval_seal"();

-- A row-level BEFORE trigger on the child is not enough on its own.
--
-- A data-modifying CTE runs its sub-statement and the main query against the
-- same snapshot, so
--
--     WITH s AS (UPDATE "EmailSendApproval" SET "sealedAt" = now()
--                WHERE id = $1 RETURNING id)
--     INSERT INTO "EmailSendApprovalMember" ... SELECT ... FROM s
--
-- would read the parent as still unsealed and let the member through. The
-- BEFORE trigger stays -- it is what refuses the ordinary case with a clear
-- message and the right lock -- and a constraint trigger fires at the end of
-- the statement, when the parent's final state is visible, to refuse what the
-- snapshot hid.

CREATE FUNCTION "email_send_approval_member_seal"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    approval_id TEXT;
    sealed TIMESTAMP(3);
BEGIN
    approval_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."approvalId" ELSE NEW."approvalId" END;

    SELECT a."sealedAt" INTO sealed
        FROM "EmailSendApproval" a
        WHERE a."id" = approval_id
        FOR SHARE;

    IF sealed IS NOT NULL THEN
        RAISE EXCEPTION 'EmailSendApproval % is sealed; its membership cannot change (%).',
            approval_id, TG_OP
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'UPDATE' AND NEW."approvalId" IS DISTINCT FROM OLD."approvalId" THEN
        RAISE EXCEPTION 'A cohort member cannot move between approvals.'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "email_send_approval_member_seal"
    BEFORE INSERT OR UPDATE OR DELETE ON "EmailSendApprovalMember"
    FOR EACH ROW EXECUTE FUNCTION "email_send_approval_member_seal"();

-- Only an override has a cohort.
--
-- A `risk_accepted` approval is scoped by *who*: the accounts named in this
-- table, compared digest by digest (section 5.6). An `obligation_waiver` is
-- scoped by *what*: a rule version, a country and an obligation key (section
-- 7.8). Letting a waiver carry members would be a second way to scope one that
-- nothing reads and no verdict would honour -- a list that looks like it
-- narrows a decision and does not.

CREATE FUNCTION "email_send_approval_member_is_override"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    approval_type TEXT;
BEGIN
    SELECT a."approvalType" INTO approval_type
        FROM "EmailSendApproval" a
        WHERE a."id" = NEW."approvalId";

    IF approval_type <> 'risk_accepted' THEN
        RAISE EXCEPTION 'EmailSendApproval % is a % and is scoped by rule rather than by cohort.',
            NEW."approvalId", approval_type
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "email_send_approval_member_is_override"
    BEFORE INSERT OR UPDATE ON "EmailSendApprovalMember"
    FOR EACH ROW EXECUTE FUNCTION "email_send_approval_member_is_override"();

CREATE FUNCTION "email_send_approval_member_seal_final"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    approval_id TEXT;
    sealed TIMESTAMP(3);
BEGIN
    approval_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."approvalId" ELSE NEW."approvalId" END;

    SELECT a."sealedAt" INTO sealed
        FROM "EmailSendApproval" a
        WHERE a."id" = approval_id;

    IF sealed IS NOT NULL THEN
        RAISE EXCEPTION 'EmailSendApproval % was sealed by this statement; its membership cannot change (%).',
            approval_id, TG_OP
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "email_send_approval_member_seal_final"
    AFTER INSERT OR UPDATE OR DELETE ON "EmailSendApprovalMember"
    DEFERRABLE INITIALLY IMMEDIATE
    FOR EACH ROW EXECUTE FUNCTION "email_send_approval_member_seal_final"();

-- A verdict is written once. Three updates exist and each may happen once:
-- the account detaching, the evidence set closing, and the provider
-- submission being recorded. Everything else raises rather than being quietly
-- restored -- a write that silently does nothing looks like it worked, and the
-- caller carries on believing a row says something it does not.

CREATE FUNCTION "email_permission_decision_immutable"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    detaching BOOLEAN;
    detaching_delivery BOOLEAN;
    sealing BOOLEAN;
    submitting BOOLEAN;
    moved INTEGER;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'EmailPermissionDecision % cannot be deleted.', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    detaching := "email_ledger_only_detach"(OLD."userId", NEW."userId");
    detaching_delivery := "email_ledger_only_detach"(OLD."deliveryId", NEW."deliveryId");
    sealing := OLD."sealedAt" IS NULL AND NEW."sealedAt" IS NOT NULL;
    submitting := OLD."providerSubmittedAt" IS NULL AND NEW."providerSubmittedAt" IS NOT NULL;

    moved := (CASE WHEN detaching THEN 1 ELSE 0 END)
           + (CASE WHEN detaching_delivery THEN 1 ELSE 0 END)
           + (CASE WHEN sealing THEN 1 ELSE 0 END)
           + (CASE WHEN submitting THEN 1 ELSE 0 END);

    IF moved <> 1 THEN
        RAISE EXCEPTION 'EmailPermissionDecision % takes exactly one of: detaching its account, detaching its delivery, sealing, recording provider submission.', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF ROW(NEW."id", NEW."phase", NEW."purpose", NEW."classification",
           NEW."emailAddress", NEW."addressNormalizationVersion", NEW."authorities",
           NEW."legalAllowed", NEW."overrideApprovalId", NEW."overrideType",
           NEW."blockers", NEW."allowed", NEW."pinnedDisplayContractHash",
           NEW."requiredDisplayContractHash", NEW."displayContractSatisfied",
           NEW."countryCandidates", NEW."ruleVersions", NEW."policyVersionId",
           NEW."suppressionCheckedAt", NEW."evaluatedAt", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."phase", OLD."purpose", OLD."classification",
           OLD."emailAddress", OLD."addressNormalizationVersion", OLD."authorities",
           OLD."legalAllowed", OLD."overrideApprovalId", OLD."overrideType",
           OLD."blockers", OLD."allowed", OLD."pinnedDisplayContractHash",
           OLD."requiredDisplayContractHash", OLD."displayContractSatisfied",
           OLD."countryCandidates", OLD."ruleVersions", OLD."policyVersionId",
           OLD."suppressionCheckedAt", OLD."evaluatedAt", OLD."createdAt") THEN
        RAISE EXCEPTION 'EmailPermissionDecision % may not change any other column.', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NOT detaching AND NEW."userId" IS DISTINCT FROM OLD."userId" THEN
        RAISE EXCEPTION 'EmailPermissionDecision % may not change its account.', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NOT detaching_delivery AND NEW."deliveryId" IS DISTINCT FROM OLD."deliveryId" THEN
        RAISE EXCEPTION 'EmailPermissionDecision % may not change its delivery.', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NOT sealing AND NEW."sealedAt" IS DISTINCT FROM OLD."sealedAt" THEN
        RAISE EXCEPTION 'EmailPermissionDecision % is already sealed.', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NOT submitting AND NEW."providerSubmittedAt" IS DISTINCT FROM OLD."providerSubmittedAt" THEN
        RAISE EXCEPTION 'EmailPermissionDecision % has already recorded provider submission.', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "email_permission_decision_immutable"
    BEFORE UPDATE OR DELETE ON "EmailPermissionDecision"
    FOR EACH ROW EXECUTE FUNCTION "email_permission_decision_immutable"();

-- A verdict is taken for a delivery, so it has one when it is written.
--
-- The column is nullable for one reason only: a delivery is purged on its own
-- schedule and the foreign key detaches the verdict rather than taking it with
-- it. Nullable at INSERT is a different thing -- it would let a verdict exist
-- about no particular message, and it would let the (deliveryId, phase) unique
-- index stop constraining, because Postgres does not compare nulls. A refusal
-- that produces no delivery is EmailCampaignRecipient's row, not this one.

CREATE FUNCTION "email_permission_decision_needs_delivery"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."deliveryId" IS NULL THEN
        RAISE EXCEPTION 'EmailPermissionDecision is taken for a delivery and must name one.'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "email_permission_decision_needs_delivery"
    BEFORE INSERT ON "EmailPermissionDecision"
    FOR EACH ROW EXECUTE FUNCTION "email_permission_decision_needs_delivery"();

-- Evidence is append-only and closes with its verdict. The same statement-end
-- check as the cohort, for the same reason: a data-modifying CTE that seals
-- the verdict and inserts evidence in one statement sees the verdict unsealed.

CREATE FUNCTION "email_permission_decision_evidence_append_only"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    sealed TIMESTAMP(3);
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'EmailPermissionDecisionEvidence is append-only (%).', TG_OP
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT d."sealedAt" INTO sealed
        FROM "EmailPermissionDecision" d
        WHERE d."id" = NEW."decisionId"
        FOR SHARE;

    IF sealed IS NOT NULL THEN
        RAISE EXCEPTION 'EmailPermissionDecision % is sealed; its evidence cannot grow.', NEW."decisionId"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "email_permission_decision_evidence_append_only"
    BEFORE INSERT OR UPDATE OR DELETE ON "EmailPermissionDecisionEvidence"
    FOR EACH ROW EXECUTE FUNCTION "email_permission_decision_evidence_append_only"();

CREATE FUNCTION "email_permission_decision_evidence_seal_final"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    sealed TIMESTAMP(3);
BEGIN
    SELECT d."sealedAt" INTO sealed
        FROM "EmailPermissionDecision" d
        WHERE d."id" = NEW."decisionId";

    IF sealed IS NOT NULL THEN
        RAISE EXCEPTION 'EmailPermissionDecision % was sealed by this statement; its evidence cannot grow.', NEW."decisionId"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "email_permission_decision_evidence_seal_final"
    AFTER INSERT ON "EmailPermissionDecisionEvidence"
    DEFERRABLE INITIALLY IMMEDIATE
    FOR EACH ROW EXECUTE FUNCTION "email_permission_decision_evidence_seal_final"();

COMMIT;
