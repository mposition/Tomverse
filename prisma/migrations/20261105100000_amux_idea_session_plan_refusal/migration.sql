-- An answer the plan check refuses no longer ends the idea on the spot (owner
-- decision 2026-11-05). One row records why, in the check's own closed words,
-- and holds the idea out of the session queue until the Decision Maker's
-- confirmed proposal or the owner decides: run again, or stop for the operator.
--
-- A row is mirrored as a typed-ask card on the AMUX host, as a v22 question is:
-- "localCardId" names that card once and "localCardClosedAt" records its close.
BEGIN;

CREATE TABLE "AmuxIdeaSessionPlanRefusal" (
  "id" TEXT NOT NULL,
  "ideaId" TEXT NOT NULL,
  "claimId" UUID NOT NULL,
  "chunkIndex" INTEGER NOT NULL,
  "detail" TEXT NOT NULL,
  "schemaRule" TEXT,
  "schemaField" TEXT,
  "schemaUnit" INTEGER,
  "schemaUnitKind" TEXT,
  "state" TEXT NOT NULL DEFAULT 'open',
  "decisionSource" TEXT,
  "decidedByUserId" TEXT,
  "decidedAt" TIMESTAMP(3),
  "localCardId" TEXT,
  "localCardClosedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxIdeaSessionPlanRefusal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AmuxIdeaSessionPlanRefusal_shape_check" CHECK (
    "chunkIndex" >= 0 AND "detail" ~ '^[a-z_]{1,64}$' AND
    ("schemaRule" IS NULL OR "schemaRule" ~ '^[a-z0-9_]{1,64}$') AND
    ("schemaField" IS NULL OR "schemaField" ~ '^[A-Za-z]{1,64}$') AND
    ("schemaUnit" IS NULL OR "schemaUnit" >= 0) AND
    ("schemaUnitKind" IS NULL OR "schemaUnitKind" IN ('node', 'card', 'evidence')) AND
    ("localCardId" IS NULL OR "localCardId" ~ '^[A-Za-z0-9_-]{1,64}$') AND
    ("localCardClosedAt" IS NULL OR "localCardId" IS NOT NULL)
  ),
  CONSTRAINT "AmuxIdeaSessionPlanRefusal_state_check" CHECK (
    ("state" = 'open' AND "decisionSource" IS NULL AND
      "decidedByUserId" IS NULL AND "decidedAt" IS NULL) OR
    ("state" IN ('retry', 'stopped') AND "decidedAt" IS NOT NULL AND
      (("decisionSource" = 'operator' AND "decidedByUserId" IS NOT NULL) OR
       ("decisionSource" = 'dm_confirmed' AND "decidedByUserId" IS NULL)))
  )
);

CREATE UNIQUE INDEX "AmuxIdeaSessionPlanRefusal_claimId_key"
  ON "AmuxIdeaSessionPlanRefusal"("claimId");
CREATE UNIQUE INDEX "AmuxIdeaSessionPlanRefusal_localCardId_key"
  ON "AmuxIdeaSessionPlanRefusal"("localCardId");
CREATE INDEX "AmuxIdeaSessionPlanRefusal_ideaId_chunkIndex_idx"
  ON "AmuxIdeaSessionPlanRefusal"("ideaId", "chunkIndex");
CREATE INDEX "AmuxIdeaSessionPlanRefusal_state_createdAt_idx"
  ON "AmuxIdeaSessionPlanRefusal"("state", "createdAt");
-- An idea waits for one decision at a time.
CREATE UNIQUE INDEX "AmuxIdeaSessionPlanRefusal_one_open_per_idea"
  ON "AmuxIdeaSessionPlanRefusal"("ideaId") WHERE "state" = 'open';

ALTER TABLE "AmuxIdeaSessionPlanRefusal" ADD CONSTRAINT "AmuxIdeaSessionPlanRefusal_ideaId_fkey"
  FOREIGN KEY ("ideaId") REFERENCES "AmuxIdeaSubmission"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AmuxIdeaSessionPlanRefusal" ADD CONSTRAINT "AmuxIdeaSessionPlanRefusal_claimId_fkey"
  FOREIGN KEY ("claimId") REFERENCES "AmuxIdeaSessionAnalysisBudgetClaim"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMIT;
