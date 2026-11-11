-- The Decision Maker card a T2 draft was put to for advice
-- (lib/engineeringAgentT2DmReviewService.ts). Additive: one new table, no
-- existing row changes. The answer stays in the Decision Maker records.
CREATE TABLE "EngineeringAgentDmReview" (
  "workItemId" TEXT NOT NULL,
  "localCardId" TEXT NOT NULL,
  "localCardClosedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EngineeringAgentDmReview_pkey" PRIMARY KEY ("workItemId")
);

CREATE UNIQUE INDEX "EngineeringAgentDmReview_localCardId_key" ON "EngineeringAgentDmReview"("localCardId");

ALTER TABLE "EngineeringAgentDmReview" ADD CONSTRAINT "EngineeringAgentDmReview_workItemId_fkey"
  FOREIGN KEY ("workItemId") REFERENCES "EngineeringAgentWorkItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
