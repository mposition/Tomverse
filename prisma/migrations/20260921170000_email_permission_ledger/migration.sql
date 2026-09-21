-- The permission ledger: the facts a basis rests on, the human decisions that
-- override or waive, and what each send decided.
--
-- Contract: docs/policy/email-product-news-redesign-draft.md, sections 5.6, 6,
-- 7.6 and 7.8.
--
-- Nothing here sends anything, reads a provider or changes an existing row.
-- Four new tables and their constraints; the send path still refuses marketing
-- because feature.emailMarketingEnabled is off and no country rule exists yet.

CREATE TABLE "EmailPermissionEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "emailAddress" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "capturedVia" TEXT NOT NULL,
    "sourceEventKey" TEXT NOT NULL,
    "jurisdiction" TEXT,
    "jurisdictionSource" TEXT,
    "policyVersionId" TEXT,
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
    "policyVersionId" TEXT,
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
    "id" TEXT NOT NULL,
    "deliveryId" TEXT,
    "userId" TEXT,
    "phase" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
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
    "policyVersionId" TEXT,
    "suppressionCheckedAt" TIMESTAMP(3),
    "providerSubmittedAt" TIMESTAMP(3),
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailPermissionDecision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmailPermissionDecisionEvidence" (
    "decisionId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "authority" TEXT NOT NULL,

    CONSTRAINT "EmailPermissionDecisionEvidence_pkey" PRIMARY KEY ("decisionId", "eventId", "authority")
);

CREATE UNIQUE INDEX "EmailPermissionEvent_kind_source_event_key" ON "EmailPermissionEvent"("kind", "sourceEventKey");
CREATE INDEX "EmailPermissionEvent_userId_kind_occurredAt_idx" ON "EmailPermissionEvent"("userId", "kind", "occurredAt");
CREATE INDEX "EmailPermissionEvent_emailAddress_kind_occurredAt_idx" ON "EmailPermissionEvent"("emailAddress", "kind", "occurredAt");
CREATE INDEX "EmailPermissionEvent_policyVersionId_idx" ON "EmailPermissionEvent"("policyVersionId");

CREATE INDEX "EmailSendApproval_approvalType_approvedAt_idx" ON "EmailSendApproval"("approvalType", "approvedAt");
CREATE INDEX "EmailSendApproval_policyVersionId_idx" ON "EmailSendApproval"("policyVersionId");

CREATE UNIQUE INDEX "EmailSendApprovalMember_approvalId_userId_key" ON "EmailSendApprovalMember"("approvalId", "userId");
CREATE INDEX "EmailSendApprovalMember_approvalId_addressDigest_idx" ON "EmailSendApprovalMember"("approvalId", "addressDigest");

CREATE INDEX "EmailSendApprovalRevocation_approvalId_revokedAt_idx" ON "EmailSendApprovalRevocation"("approvalId", "revokedAt");

CREATE UNIQUE INDEX "EmailPermissionDecision_delivery_phase" ON "EmailPermissionDecision"("deliveryId", "phase");
CREATE INDEX "EmailPermissionDecision_userId_evaluatedAt_idx" ON "EmailPermissionDecision"("userId", "evaluatedAt");
CREATE INDEX "EmailPermissionDecision_emailAddress_evaluatedAt_idx" ON "EmailPermissionDecision"("emailAddress", "evaluatedAt");
CREATE INDEX "EmailPermissionDecision_overrideApprovalId_idx" ON "EmailPermissionDecision"("overrideApprovalId");
CREATE INDEX "EmailPermissionDecision_policyVersionId_idx" ON "EmailPermissionDecision"("policyVersionId");

CREATE INDEX "EmailPermissionDecisionEvidence_eventId_idx" ON "EmailPermissionDecisionEvidence"("eventId");

ALTER TABLE "EmailPermissionEvent" ADD CONSTRAINT "EmailPermissionEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EmailPermissionEvent" ADD CONSTRAINT "EmailPermissionEvent_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "EmailPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmailSendApproval" ADD CONSTRAINT "EmailSendApproval_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "EmailPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmailSendApprovalMember" ADD CONSTRAINT "EmailSendApprovalMember_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "EmailSendApproval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmailSendApprovalRevocation" ADD CONSTRAINT "EmailSendApprovalRevocation_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "EmailSendApproval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_overrideApprovalId_fkey" FOREIGN KEY ("overrideApprovalId") REFERENCES "EmailSendApproval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "EmailPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmailPermissionDecisionEvidence" ADD CONSTRAINT "EmailPermissionDecisionEvidence_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "EmailPermissionDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailPermissionDecisionEvidence" ADD CONSTRAINT "EmailPermissionDecisionEvidence_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "EmailPermissionEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Closed lists. Each one is also a list in the application, and
-- scripts/check-enum-constraints.mjs compares them on every run.

ALTER TABLE "EmailPermissionEvent" ADD CONSTRAINT "EmailPermissionEvent_kind_check"
    CHECK ("kind" IN ('notice_shown', 'objected', 'relationship_started', 'relationship_ended', 'basis_ended'));

ALTER TABLE "EmailPermissionEvent" ADD CONSTRAINT "EmailPermissionEvent_capturedVia_check"
    CHECK ("capturedVia" IN ('signup_form', 'preference_center', 'unsubscribe_page', 'in_product_notice', 'admin', 'system', 'provider_complaint'));

-- "*" means the address itself; an empty string would be a writer that left
-- the column out rather than a scope anybody chose.
ALTER TABLE "EmailPermissionEvent" ADD CONSTRAINT "EmailPermissionEvent_scopeKey_not_empty_check"
    CHECK (length("scopeKey") > 0);

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
            AND "purposeKey" IS NOT NULL
            AND "ruleKey" IS NULL AND "ruleVersion" IS NULL
            AND "country" IS NULL AND "obligationKey" IS NULL)
    );

ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_phase_check"
    CHECK ("phase" IN ('enqueue', 'send'));

ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_classification_check"
    CHECK ("classification" IN ('transactional', 'service', 'marketing'));

-- An override is a reference plus the kind of decision it was. Half of it is
-- a row that either cannot be resolved or cannot be read.
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

-- Append-only, enforced where it cannot be forgotten.
--
-- The application is not the place for this. An append-only ledger that one
-- stray update can rewrite is not evidence, and the writer who would make that
-- update is the one who did not read the comment saying not to.

CREATE FUNCTION "email_permission_event_append_only"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'EmailPermissionEvent is append-only (%).', TG_OP
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "email_permission_event_append_only"
    BEFORE UPDATE OR DELETE ON "EmailPermissionEvent"
    FOR EACH ROW EXECUTE FUNCTION "email_permission_event_append_only"();

CREATE FUNCTION "email_send_approval_revocation_append_only"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'EmailSendApprovalRevocation is append-only (%).', TG_OP
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "email_send_approval_revocation_append_only"
    BEFORE UPDATE OR DELETE ON "EmailSendApprovalRevocation"
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

-- A verdict is written once. providerSubmittedAt is the one column a later
-- statement may fill, because the value does not exist until the message has
-- been handed over, and it may be filled only once.

CREATE FUNCTION "email_permission_decision_immutable"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'EmailPermissionDecision % cannot be deleted.', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."providerSubmittedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'EmailPermissionDecision % is complete and cannot be changed.', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."providerSubmittedAt" IS NULL THEN
        RAISE EXCEPTION 'EmailPermissionDecision % may only be updated to record provider submission.', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    NEW."deliveryId" := OLD."deliveryId";
    NEW."userId" := OLD."userId";
    NEW."phase" := OLD."phase";
    NEW."purpose" := OLD."purpose";
    NEW."classification" := OLD."classification";
    NEW."emailAddress" := OLD."emailAddress";
    NEW."authorities" := OLD."authorities";
    NEW."legalAllowed" := OLD."legalAllowed";
    NEW."overrideApprovalId" := OLD."overrideApprovalId";
    NEW."overrideType" := OLD."overrideType";
    NEW."blockers" := OLD."blockers";
    NEW."allowed" := OLD."allowed";
    NEW."pinnedDisplayContractHash" := OLD."pinnedDisplayContractHash";
    NEW."requiredDisplayContractHash" := OLD."requiredDisplayContractHash";
    NEW."displayContractSatisfied" := OLD."displayContractSatisfied";
    NEW."countryCandidates" := OLD."countryCandidates";
    NEW."ruleVersions" := OLD."ruleVersions";
    NEW."policyVersionId" := OLD."policyVersionId";
    NEW."suppressionCheckedAt" := OLD."suppressionCheckedAt";
    NEW."evaluatedAt" := OLD."evaluatedAt";
    NEW."createdAt" := OLD."createdAt";

    RETURN NEW;
END;
$$;

CREATE TRIGGER "email_permission_decision_immutable"
    BEFORE UPDATE OR DELETE ON "EmailPermissionDecision"
    FOR EACH ROW EXECUTE FUNCTION "email_permission_decision_immutable"();

CREATE FUNCTION "email_permission_decision_evidence_append_only"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'EmailPermissionDecisionEvidence is append-only (%).', TG_OP
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "email_permission_decision_evidence_append_only"
    BEFORE UPDATE OR DELETE ON "EmailPermissionDecisionEvidence"
    FOR EACH ROW EXECUTE FUNCTION "email_permission_decision_evidence_append_only"();
