-- The layer above EmailEvent: the decision to make an announcement, who
-- approved it, and what they approved.
--
-- Contract: .github/audits/model-lifecycle-email-2026-08-22.md section 12.2,
-- EM-01, EM-06.
--
-- Kept apart from EmailEvent deliberately. Approval is a property of the
-- campaign, not of the outbox, and adding draft/pending_approval to
-- EmailEvent.status would put approval vocabulary in the table that also holds
-- login codes -- whose status CHECK both lanes depend on.
--
-- Only the columns this release writes. EmailEvent already carries three fields
-- nothing ever wrote (audienceSpec, expansionCursor, and half its statuses),
-- which is the defect EM-01 names; scheduling, work-item links and effective
-- dates arrive with the code that uses them.

CREATE TABLE "EmailCampaign" (
    "id"                 TEXT NOT NULL,
    "category"           TEXT NOT NULL,
    "templateKey"        TEXT NOT NULL,
    "status"             TEXT NOT NULL DEFAULT 'draft',
    "locales"            JSONB NOT NULL,
    "audienceSpec"       JSONB NOT NULL,
    -- language -> TemplateVersion.id, pinned at approval (EM-06). Null until
    -- approved: a draft has nothing to pin, and pinning early would freeze copy
    -- somebody is still editing.
    "templateVersionIds" JSONB,
    "approvalId"         TEXT,
    "approvedAt"         TIMESTAMP(3),
    "createdByEmail"     TEXT NOT NULL,
    "cancelledAt"        TIMESTAMP(3),
    "cancelReason"       TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailCampaign_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailCampaign_status_createdAt_idx" ON "EmailCampaign"("status", "createdAt");
CREATE INDEX "EmailCampaign_templateKey_idx" ON "EmailCampaign"("templateKey");

ALTER TABLE "EmailCampaign" ADD CONSTRAINT "EmailCampaign_status_check"
    CHECK ("status" IN (
        'draft', 'pending_approval', 'approved', 'running', 'completed',
        'cancelled', 'halted'
    ));

ALTER TABLE "EmailCampaign" ADD CONSTRAINT "EmailCampaign_category_check"
    CHECK ("category" IN (
        'model_launch', 'model_upgrade', 'model_retirement', 'model_migration',
        'model_incident', 'other'
    ));

-- An approved campaign has both halves of its approval or neither. A row with
-- an approval id and no pinned versions would send whatever the code says
-- today, which is the whole failure EM-06 describes.
ALTER TABLE "EmailCampaign" ADD CONSTRAINT "EmailCampaign_approval_completeness_check"
    CHECK (
        "status" IN ('draft', 'pending_approval', 'cancelled')
        OR ("approvalId" IS NOT NULL AND "approvedAt" IS NOT NULL AND "templateVersionIds" IS NOT NULL)
    );

CREATE TABLE "EmailCampaignWave" (
    "id"            TEXT NOT NULL,
    "campaignId"    TEXT NOT NULL,
    "kind"          TEXT NOT NULL,
    "sequence"      INTEGER NOT NULL,
    "eventId"       TEXT,
    "status"        TEXT NOT NULL DEFAULT 'pending',
    "recipientCap"  INTEGER,
    "dryRun"        BOOLEAN NOT NULL DEFAULT false,
    "expandedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailCampaignWave_pkey" PRIMARY KEY ("id")
);

-- One wave per kind per position. A campaign that sent two "reminder 1" waves
-- has told the same people twice, and the second one is indistinguishable from
-- the first afterwards.
CREATE UNIQUE INDEX "EmailCampaignWave_campaignId_kind_sequence_key"
    ON "EmailCampaignWave"("campaignId", "kind", "sequence");
CREATE INDEX "EmailCampaignWave_status_createdAt_idx"
    ON "EmailCampaignWave"("status", "createdAt");

ALTER TABLE "EmailCampaignWave" ADD CONSTRAINT "EmailCampaignWave_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "EmailCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmailCampaignWave" ADD CONSTRAINT "EmailCampaignWave_status_check"
    CHECK ("status" IN (
        'pending', 'expanding', 'expanded', 'sending', 'done', 'cancelled',
        'halted'
    ));

ALTER TABLE "EmailCampaignWave" ADD CONSTRAINT "EmailCampaignWave_kind_check"
    CHECK ("kind" IN ('launch', 'notice', 'reminder', 'final_reminder', 'completion'));

-- A cap of zero reaches nobody, which is a thing somebody may mean; a negative
-- cap is a typo that would otherwise read as "no cap" after arithmetic.
ALTER TABLE "EmailCampaignWave" ADD CONSTRAINT "EmailCampaignWave_recipient_cap_check"
    CHECK ("recipientCap" IS NULL OR "recipientCap" >= 0);

-- A wave that has expanded has an event to have expanded into.
ALTER TABLE "EmailCampaignWave" ADD CONSTRAINT "EmailCampaignWave_expanded_has_event_check"
    CHECK ("status" IN ('pending', 'cancelled') OR "eventId" IS NOT NULL);
