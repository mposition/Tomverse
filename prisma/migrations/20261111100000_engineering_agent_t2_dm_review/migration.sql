-- The Decision Maker card a T2 draft was put to for advice
-- (lib/engineeringAgentT2DmReviewService.ts). Additive: one new table, no
-- existing row changes. The answer stays in the Decision Maker records.
-- A row names the filed card, or records once that no card could be written
-- for the draft (so it is not read again); never both, never neither.
CREATE TABLE "EngineeringAgentDmReview" (
  "workItemId" TEXT NOT NULL,
  "localCardId" TEXT,
  "unfilableAt" TIMESTAMP(3),
  "localCardClosedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EngineeringAgentDmReview_pkey" PRIMARY KEY ("workItemId"),
  CONSTRAINT "EngineeringAgentDmReview_card_or_unfilable_check"
    CHECK (("localCardId" IS NULL) <> ("unfilableAt" IS NULL)),
  CONSTRAINT "EngineeringAgentDmReview_closed_card_check"
    CHECK ("localCardClosedAt" IS NULL OR "localCardId" IS NOT NULL)
);

CREATE UNIQUE INDEX "EngineeringAgentDmReview_localCardId_key" ON "EngineeringAgentDmReview"("localCardId");

ALTER TABLE "EngineeringAgentDmReview" ADD CONSTRAINT "EngineeringAgentDmReview_workItemId_fkey"
  FOREIGN KEY ("workItemId") REFERENCES "EngineeringAgentWorkItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
