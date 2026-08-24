-- The model lifecycle work queue.
--
-- .github/audits/model-lifecycle-email-2026-08-22.md §9 (ML-01, ML-02, ML-03).
--
-- Discovery already worked. What did not exist was anywhere to put the answer:
-- `newCandidates` is populated only when no ProviderModelCatalogEntry row
-- exists yet and the same scan writes that row, so a model was named in exactly
-- one daily report and never again, and nothing in the tree could read the
-- table afterwards. Measured over 21 July - 22 August 2026 that lost seven
-- first-party models, one of them for twenty-eight days.
--
-- Kept apart from ProviderModelCatalogEntry because the two answer different
-- questions and only one of them is overwritten every morning. The catalogue
-- row is what the provider said today; this is what we decided, and nothing but
-- a person changes it.
--
-- Additive: two new tables, no existing row read or written.

CREATE TABLE "ModelLifecycleWorkItem" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiModel" TEXT NOT NULL,
    "modelId" TEXT,
    "catalogEntryId" TEXT,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'discovered',
    "severity" TEXT NOT NULL DEFAULT 'normal',
    "predecessorModelId" TEXT,
    "replacementModelId" TEXT,
    "recommendation" TEXT,
    "confidence" TEXT,
    "evidence" JSONB,
    "unknowns" JSONB,
    "blockers" JSONB,
    "pendingValidations" JSONB,
    "reviewerId" TEXT,
    "reviewerEmail" TEXT,
    "decision" TEXT,
    "decisionReason" TEXT,
    "decidedAt" TIMESTAMP(3),
    "ownerEmail" TEXT,
    "dueAt" TIMESTAMP(3),
    "deferredUntil" TIMESTAMP(3),
    "linkedIssueUrl" TEXT,
    "linkedPrUrl" TEXT,
    "linkedDeploymentId" TEXT,
    "implementationEvidence" JSONB,
    "validationEvidence" JSONB,
    "communicationRequired" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelLifecycleWorkItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ModelLifecycleWorkItemEvent" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorEmail" TEXT,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "note" TEXT,
    "evidence" JSONB,

    CONSTRAINT "ModelLifecycleWorkItemEvent_pkey" PRIMARY KEY ("id")
);

-- Adding a model and later retiring it are two decisions at two times, so the
-- action is part of the identity. Two open "add"s for one model are not.
CREATE UNIQUE INDEX "ModelLifecycleWorkItem_provider_apiModel_action_key"
    ON "ModelLifecycleWorkItem"("provider", "apiModel", "action");

CREATE INDEX "ModelLifecycleWorkItem_status_severity_firstSeenAt_idx"
    ON "ModelLifecycleWorkItem"("status", "severity", "firstSeenAt");

CREATE INDEX "ModelLifecycleWorkItem_ownerEmail_dueAt_idx"
    ON "ModelLifecycleWorkItem"("ownerEmail", "dueAt");

CREATE INDEX "ModelLifecycleWorkItem_modelId_idx"
    ON "ModelLifecycleWorkItem"("modelId");

CREATE INDEX "ModelLifecycleWorkItemEvent_workItemId_occurredAt_idx"
    ON "ModelLifecycleWorkItemEvent"("workItemId", "occurredAt");

ALTER TABLE "ModelLifecycleWorkItemEvent"
    ADD CONSTRAINT "ModelLifecycleWorkItemEvent_workItemId_fkey"
    FOREIGN KEY ("workItemId") REFERENCES "ModelLifecycleWorkItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- --------------------------------------------------------------------------
-- The closed lists, and the two invariants that are not enum-shaped.
--
-- schema.prisma cannot express either, so both live here. The state machine in
-- lib/modelLifecycleWorkItemCore.ts holds the same status list and
-- scripts/check-enum-constraints.mjs compares the two on every run.
-- --------------------------------------------------------------------------

ALTER TABLE "ModelLifecycleWorkItem" ADD CONSTRAINT "ModelLifecycleWorkItem_action_check"
    CHECK ("action" IN ('add', 'upgrade', 'replace', 'retire', 'monitor', 'no_action'));

ALTER TABLE "ModelLifecycleWorkItem" ADD CONSTRAINT "ModelLifecycleWorkItem_status_check"
    CHECK ("status" IN (
        'discovered', 'awaiting_decision', 'approved', 'rejected', 'deferred',
        'implementation_pending', 'validation_pending', 'rollout_pending',
        'communication_pending', 'completed', 'closed_no_action'
    ));

ALTER TABLE "ModelLifecycleWorkItem" ADD CONSTRAINT "ModelLifecycleWorkItem_severity_check"
    CHECK ("severity" IN ('critical', 'high', 'normal'));

ALTER TABLE "ModelLifecycleWorkItem" ADD CONSTRAINT "ModelLifecycleWorkItem_confidence_check"
    CHECK ("confidence" IS NULL OR "confidence" IN ('high', 'medium', 'low'));

ALTER TABLE "ModelLifecycleWorkItem" ADD CONSTRAINT "ModelLifecycleWorkItem_decision_check"
    CHECK ("decision" IS NULL OR "decision" IN ('approve', 'reject', 'defer'));

-- A decision without its reason is a decision nobody can review later, which is
-- the state this whole table exists to end.
ALTER TABLE "ModelLifecycleWorkItem" ADD CONSTRAINT "ModelLifecycleWorkItem_decision_reason_check"
    CHECK ("decision" IS NULL OR ("decisionReason" IS NOT NULL AND "decidedAt" IS NOT NULL));

-- `approved` is what unlocks implementation, so it may not be reached without
-- one. Stated here as well as in the transition rules because the constraint
-- survives a caller that bypasses them.
ALTER TABLE "ModelLifecycleWorkItem" ADD CONSTRAINT "ModelLifecycleWorkItem_approved_needs_decision_check"
    CHECK ("status" <> 'approved' OR "decision" = 'approve');

-- The two terminal shapes, and nothing carrying both. A completed item has
-- completedAt; a refused one has closedAt.
ALTER TABLE "ModelLifecycleWorkItem" ADD CONSTRAINT "ModelLifecycleWorkItem_completed_at_check"
    CHECK (("status" = 'completed') = ("completedAt" IS NOT NULL));

ALTER TABLE "ModelLifecycleWorkItem" ADD CONSTRAINT "ModelLifecycleWorkItem_closed_at_check"
    CHECK (("status" IN ('rejected', 'closed_no_action')) = ("closedAt" IS NOT NULL));

ALTER TABLE "ModelLifecycleWorkItemEvent" ADD CONSTRAINT "ModelLifecycleWorkItemEvent_toStatus_check"
    CHECK ("toStatus" IN (
        'discovered', 'awaiting_decision', 'approved', 'rejected', 'deferred',
        'implementation_pending', 'validation_pending', 'rollout_pending',
        'communication_pending', 'completed', 'closed_no_action'
    ));

ALTER TABLE "ModelLifecycleWorkItemEvent" ADD CONSTRAINT "ModelLifecycleWorkItemEvent_fromStatus_check"
    CHECK ("fromStatus" IS NULL OR "fromStatus" IN (
        'discovered', 'awaiting_decision', 'approved', 'rejected', 'deferred',
        'implementation_pending', 'validation_pending', 'rollout_pending',
        'communication_pending', 'completed', 'closed_no_action'
    ));
