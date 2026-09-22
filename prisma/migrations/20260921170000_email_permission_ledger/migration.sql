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

-- The anchor the two-year notice counts from, and where the date came from.
--
-- The policy names exactly one value: the owner decided that for this cohort
-- the signup date is *deemed* to be the anchor, and `signup_date_deemed` is
-- what says so (draft section 7.7). "signup" is not the same claim -- it reads
-- as a fact about consent rather than as a decision to treat a date as one,
-- which is precisely the distinction that decision was careful about. Both
-- fixtures stored it until 2026-09-22 and the column took it.
--
-- A second value is a decision, not an addition: a member whose anchor is a
-- real consent date belongs to a cohort that did not need deeming.
ALTER TABLE "EmailSendApprovalMember" ADD CONSTRAINT "EmailSendApprovalMember_noticeAnchorSource_check"
    CHECK ("noticeAnchorSource" IN ('signup_date_deemed'));

-- Which authority cited a row. Two exist: the receiver's and the Australian
-- sender's (draft section 4.2). An open string here would let a verdict rest
-- on an authority no rule defines, permanently and unreadably.
ALTER TABLE "EmailPermissionDecisionEvidence" ADD CONSTRAINT "EmailPermissionDecisionEvidence_authority_check"
    CHECK ("authority" IN ('recipient', 'au_sender'));

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
            AND "purposeKey" IS NOT NULL
            AND "ruleKey" IS NULL AND "ruleVersion" IS NULL
            AND "country" IS NULL AND "obligationKey" IS NULL)
    );

-- Which purposes an override may cover, on its own so it can be checked.
--
-- Inside the composite constraint above the list was invisible to
-- scripts/check-enum-constraints.mjs, which reads one closed list per
-- constraint. The code's six purposes and the database's could have drifted
-- apart silently, which is the exact failure that check exists to catch.
ALTER TABLE "EmailSendApproval" ADD CONSTRAINT "EmailSendApproval_purposeKey_check"
    CHECK ("purposeKey" IS NULL OR "purposeKey" IN (
        '*', 'security', 'billing', 'service_status',
        'product_updates', 'newsletter', 'promotions'
    ));

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

-- "is an array" was not enough for `authorities`.
--
-- A verdict could seal with `["au_sender"]` -- strings rather than the
-- objects every reader expects -- and the evidence trigger's lookup for
-- `a->>'authority'` would find nothing in it, so no evidence could ever be
-- attached to a verdict shaped that way. Every element has to be an object
-- carrying an authority the list knows.
ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_json_shape_check"
    CHECK (
        jsonb_typeof("authorities") = 'array'
        AND jsonb_typeof("blockers") = 'array'
        AND NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements("authorities") AS a
             WHERE jsonb_typeof(a) <> 'object'
                OR a->>'authority' IS NULL
                OR a->>'authority' NOT IN ('recipient', 'au_sender')
        )
    );

-- allowed is derived, so it is computed here too. Two places saying it is the
-- point: the application can be wrong about one row, and this refuses to store
-- the row it was wrong about.
-- `jsonb_array_length` raises on anything that is not an array, and Postgres
-- does not promise to evaluate constraints in any order. An object in
-- `blockers` would otherwise come back as a function error from this
-- constraint rather than as the shape violation it is, so the caller would be
-- told the wrong thing about their row.
--
-- The whole equality sits inside the array branch, and the other branch is
-- NULL rather than FALSE. A CHECK that evaluates to NULL passes, so a
-- malformed `blockers` breaks `json_shape_check` and only that -- which is
-- what makes the test for one of them a test for one of them. `ELSE FALSE`
-- was the first attempt and it made every malformed row violate both;
-- putting only the inner value at NULL does not work either, because
-- `FALSE AND NULL` is FALSE and the row would still be refused here.
ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_allowed_derivation_check"
    CHECK (
        CASE
            WHEN jsonb_typeof("blockers") = 'array' THEN
                "allowed" = (
                    ("legalAllowed" OR "overrideApprovalId" IS NOT NULL)
                    AND jsonb_array_length("blockers") = 0
                )
            ELSE NULL
        END
    );

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
--
-- `deliveryId IS NOT NULL` is deliberately **not** here, and it was, briefly.
-- A persisted CHECK is re-evaluated on every later write, and the later write
-- this row takes is the foreign key's own `SET NULL` when the message is
-- purged. Holding the condition here would have made a sent verdict refuse to
-- detach -- so the purge would fail, and the retention job would stop on the
-- rows that had actually been sent. Having had a delivery at the moment of
-- submission is a fact about that moment, so the transition trigger checks it
-- there, where it stays true afterwards.
ALTER TABLE "EmailPermissionDecision" ADD CONSTRAINT "EmailPermissionDecision_submission_check"
    CHECK (
        "providerSubmittedAt" IS NULL
        OR (
            "phase" = 'send'
            AND "allowed" = TRUE
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
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT old_value IS NOT NULL AND new_value IS NULL;
$$;

CREATE FUNCTION "email_permission_event_append_only"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
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
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    sealed TIMESTAMP(3);
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'EmailSendApprovalRevocation is append-only (%).', TG_OP
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT a."sealedAt" INTO sealed
        FROM public."EmailSendApproval" a
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
SET search_path = pg_catalog, pg_temp
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
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    approval_id TEXT;
    sealed TIMESTAMP(3);
BEGIN
    approval_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."approvalId" ELSE NEW."approvalId" END;

    SELECT a."sealedAt" INTO sealed
        FROM public."EmailSendApproval" a
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
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    approval_type TEXT;
BEGIN
    SELECT a."approvalType" INTO approval_type
        FROM public."EmailSendApproval" a
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
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    approval_id TEXT;
    sealed TIMESTAMP(3);
BEGIN
    approval_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."approvalId" ELSE NEW."approvalId" END;

    SELECT a."sealedAt" INTO sealed
        FROM public."EmailSendApproval" a
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
SET search_path = pg_catalog, pg_temp
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

    -- The half of the submission contract a persisted CHECK cannot hold.
    -- A message cannot be handed over for a delivery that is already gone,
    -- and once it has been the row may still detach when that delivery is
    -- purged -- which is why this lives here and not in the constraint.
    IF submitting AND OLD."deliveryId" IS NULL THEN
        RAISE EXCEPTION 'EmailPermissionDecision % has no delivery to submit.', OLD."id"
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
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NEW."deliveryId" IS NULL THEN
        RAISE EXCEPTION 'EmailPermissionDecision is taken for a delivery and must name one.'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

-- The seal is a database invariant, not a verdict-path one.
--
-- Revocation, scope and cohort belong to the path S9 builds, under the locks
-- it holds. Whether the approval was ever closed does not: an unsealed
-- approval is a draft being assembled, and a verdict that overrode one
-- recorded a decision nobody had finished making. The ordering matters for
-- the same reason -- an approval sealed after the send was not in force when
-- the message went out.
CREATE FUNCTION "email_permission_decision_override_is_sealed"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    sealed TIMESTAMP(3);
BEGIN
    IF NEW."overrideApprovalId" IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT a."sealedAt" INTO sealed
        FROM public."EmailSendApproval" a
        WHERE a."id" = NEW."overrideApprovalId"
        FOR SHARE;

    IF sealed IS NULL THEN
        RAISE EXCEPTION 'EmailSendApproval % is not sealed and cannot override a send.',
            NEW."overrideApprovalId"
            USING ERRCODE = 'check_violation';
    END IF;

    IF sealed > NEW."evaluatedAt" THEN
        RAISE EXCEPTION 'EmailSendApproval % was sealed after this verdict was taken.',
            NEW."overrideApprovalId"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "email_permission_decision_override_is_sealed"
    BEFORE INSERT ON "EmailPermissionDecision"
    FOR EACH ROW EXECUTE FUNCTION "email_permission_decision_override_is_sealed"();

CREATE TRIGGER "email_permission_decision_needs_delivery"
    BEFORE INSERT ON "EmailPermissionDecision"
    FOR EACH ROW EXECUTE FUNCTION "email_permission_decision_needs_delivery"();

-- Evidence is append-only and closes with its verdict. The same statement-end
-- check as the cohort, for the same reason: a data-modifying CTE that seals
-- the verdict and inserts evidence in one statement sees the verdict unsealed.

CREATE FUNCTION "email_permission_decision_evidence_append_only"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    sealed TIMESTAMP(3);
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'EmailPermissionDecisionEvidence is append-only (%).', TG_OP
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT d."sealedAt" INTO sealed
        FROM public."EmailPermissionDecision" d
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

-- Evidence has to be about the person the verdict is about.
--
-- Until 2026-09-22 the foreign keys and the XOR check were the whole of it,
-- which meant a verdict for one account could cite another account's notice or
-- consent and then be sealed -- permanent, unreadable false evidence, in the
-- one table whose entire value is that it is neither. The fixtures proved it
-- was reachable: they seeded three different addresses and the insert
-- succeeded.
--
-- What is compared is what the two rows both know: the normalised address, the
-- account when both rows name one, and -- for a permission event -- that its
-- scope covers what the verdict decided. The authority has to be one the
-- verdict actually applied, or the row cites a basis nothing weighed.
--
-- What is deliberately *not* compared here is the approval's seal, revocation,
-- scope and cohort. Those belong to the verdict-taking path (draft section
-- 7.6) which S9 builds, under the locks that path holds; re-deriving them from
-- a trigger on this table would be a second implementation of the rule that
-- could disagree with the first.

CREATE FUNCTION "email_permission_decision_evidence_consistent"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    d_user TEXT;
    d_address TEXT;
    d_purpose TEXT;
    d_classification TEXT;
    d_authorities JSONB;
    d_evaluated TIMESTAMP(3);
    s_user TEXT;
    s_address TEXT;
    s_scope TEXT;
    s_occurred TIMESTAMP(3);
BEGIN
    SELECT d."userId", lower(d."emailAddress"), d."purpose", d."classification",
           d."authorities", d."evaluatedAt"
      INTO d_user, d_address, d_purpose, d_classification, d_authorities, d_evaluated
      FROM public."EmailPermissionDecision" d
     WHERE d."id" = NEW."decisionId"
       FOR SHARE;

    IF NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(d_authorities) AS a
         WHERE a->>'authority' = NEW."authority"
    ) THEN
        RAISE EXCEPTION 'EmailPermissionDecision % did not apply authority %.',
            NEW."decisionId", NEW."authority"
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."eventId" IS NOT NULL THEN
        SELECT e."userId", lower(e."emailAddress"), e."scopeKey", e."occurredAt"
          INTO s_user, s_address, s_scope, s_occurred
          FROM public."EmailPermissionEvent" e
         WHERE e."id" = NEW."eventId";

        IF s_scope <> '*' AND s_scope <> d_purpose AND s_scope <> d_classification THEN
            RAISE EXCEPTION 'Permission event % is scoped to %, which the verdict did not decide.',
                NEW."eventId", s_scope
                USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        SELECT c."userId", lower(c."emailAddress"), c."purpose", c."occurredAt"
          INTO s_user, s_address, s_scope, s_occurred
          FROM public."ConsentRecord" c
         WHERE c."id" = NEW."consentRecordId";

        IF s_scope <> d_purpose THEN
            RAISE EXCEPTION 'Consent record % is about %, which the verdict did not decide.',
                NEW."consentRecordId", s_scope
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF s_occurred > d_evaluated THEN
        RAISE EXCEPTION 'Evidence for decision % happened after the verdict was taken.',
            NEW."decisionId"
            USING ERRCODE = 'check_violation';
    END IF;

    IF s_address IS DISTINCT FROM d_address THEN
        RAISE EXCEPTION 'Evidence for decision % is about a different address.',
            NEW."decisionId"
            USING ERRCODE = 'check_violation';
    END IF;

    IF d_user IS NOT NULL AND s_user IS NOT NULL AND s_user <> d_user THEN
        RAISE EXCEPTION 'Evidence for decision % is about a different account.',
            NEW."decisionId"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "email_permission_decision_evidence_consistent"
    BEFORE INSERT ON "EmailPermissionDecisionEvidence"
    FOR EACH ROW EXECUTE FUNCTION "email_permission_decision_evidence_consistent"();

CREATE FUNCTION "email_permission_decision_evidence_seal_final"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    sealed TIMESTAMP(3);
BEGIN
    SELECT d."sealedAt" INTO sealed
        FROM public."EmailPermissionDecision" d
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


-- ConsentRecord, which this ledger now cites.
--
-- Its own comment has said "append-only: never updated, never deleted with
-- the account" since 20260821090000, and nothing enforced it. That was
-- survivable while it only described itself; it stopped being survivable
-- when a sealed verdict began citing it as evidence, because an UPDATE to a
-- cited row's address or purpose changes what that verdict rested on, after
-- the verdict was closed against exactly that possibility.
--
-- The one update it accepts is the same one the ledger accepts: the foreign
-- key's SET NULL when the account goes, which the registry records as this
-- table's anonymisation.

CREATE FUNCTION "consent_record_append_only"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'ConsentRecord is append-only (DELETE).'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NOT "email_ledger_only_detach"(OLD."userId", NEW."userId") THEN
        RAISE EXCEPTION 'ConsentRecord is append-only (UPDATE).'
            USING ERRCODE = 'check_violation';
    END IF;

    IF ROW(NEW."id", NEW."emailAddress", NEW."purpose", NEW."action",
           NEW."occurredAt", NEW."jurisdiction", NEW."jurisdictionSource",
           NEW."policyVersionId", NEW."capturedVia", NEW."evidence",
           NEW."ipHash", NEW."userAgentHash", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."emailAddress", OLD."purpose", OLD."action",
           OLD."occurredAt", OLD."jurisdiction", OLD."jurisdictionSource",
           OLD."policyVersionId", OLD."capturedVia", OLD."evidence",
           OLD."ipHash", OLD."userAgentHash", OLD."createdAt") THEN
        RAISE EXCEPTION 'ConsentRecord accepts no change but detaching its account.'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "consent_record_append_only"
    BEFORE UPDATE OR DELETE ON "ConsentRecord"
    FOR EACH ROW EXECUTE FUNCTION "consent_record_append_only"();

-- TRUNCATE, and why there is no trigger for it.
--
-- The row triggers above refuse UPDATE and DELETE. TRUNCATE is neither: it
-- fires no row trigger, and `TRUNCATE ... CASCADE` on a table these point
-- at reaches them through their foreign keys. That is a real gap and this
-- migration does not close it, because the two ways to close it are both
-- wrong here.
--
-- A `BEFORE TRUNCATE` trigger was written and removed. `EmailPermissionEvent`
-- and `EmailPermissionDecision` carry foreign keys to `User`, and
-- `EmailPermissionDecision` one to `EmailDelivery`, so a cascade from either
-- reaches this ledger -- and 84 of the 138 DB integration suites reset
-- themselves by truncating exactly those two tables. The trigger broke all
-- of them. Converting every suite to DELETE is a change to how this
-- repository's tests are built, which is not a feature slice's to make.
--
-- Revoking TRUNCATE from the runtime role is the lever that actually fits,
-- and it reaches every table in the schema, so it belongs with whoever owns
-- the database roles. `AdminAuditLog`, which has the same append-only claim
-- and the same exposure, has no TRUNCATE trigger either
-- (20260918090000_admin_audit_log_append_only).
--
-- What is closed here is the reachable vector: no code in this repository
-- may issue a TRUNCATE against these tables outside a fixture, and
-- `npm run check:protected-table-writers` refuses one.

COMMIT;
