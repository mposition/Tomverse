-- baseline-check: present-if-relation "AmuxDmOwnerSettlement"
-- Owner decision 2026-11-13: every card that waits in the AMUX owner queue is
-- put to the Decision Maker. A stopped v22 Task with an open human escalation
-- that no other Decision Maker path holds becomes one settlement row, filed
-- by the relay as a typed-ask card. The Decision Maker picks one way to
-- settle it; the app applies a reversible one (retry, complete, close,
-- remake) behind the DM approver switch, and records an approval of a review
-- pull request for the next stage to act on. The human escalation stays open
-- beside it: whichever answers first wins.
--
-- Additive: one new table, no existing row changes. Its id is a version 8
-- UUID derived from the escalation, so the relay's card writes tell it apart
-- from every other question id (all version 4) without reading another table.
-- The pull request's binding is named, not referenced: the engineering
-- binding table's writers stay its own, and the next stage reads the binding
-- again before it acts.
BEGIN;

CREATE TABLE "AmuxDmOwnerSettlement" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "escalationId" TEXT NOT NULL,
  "attemptId" TEXT,
  "kind" TEXT NOT NULL,
  "taskStatus" TEXT NOT NULL,
  "bindingId" TEXT,
  "state" TEXT NOT NULL DEFAULT 'open',
  "decision" TEXT,
  "answerSource" TEXT,
  "requestId" TEXT,
  "approvedHeadSha" TEXT,
  "approvedDiffDigest" TEXT,
  "remakeIdeaId" TEXT,
  "cancelReason" TEXT,
  "handoffReason" TEXT,
  "handoffAt" TIMESTAMP(3),
  "decidedAt" TIMESTAMP(3),
  "localCardId" TEXT,
  "localCardClosedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxDmOwnerSettlement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AmuxDmOwnerSettlement_shape_check" CHECK (
    -- A lowercase version 8 UUID: the local AMUX files a question only under
    -- a lowercase UUID, and version 8 marks it as a settlement's.
    "id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
    "kind" IN ('t2_pr', 'stopped') AND
    "taskStatus" IN ('review', 'blocked') AND
    (("kind" = 't2_pr') = ("bindingId" IS NOT NULL)) AND
    ("kind" <> 't2_pr' OR "attemptId" IS NOT NULL) AND
    ("bindingId" IS NULL OR "bindingId" ~ '^[A-Za-z0-9_-]{1,64}$') AND
    ("answerSource" IS NULL OR "answerSource" IN ('dm', 'dm_confirmed')) AND
    ("requestId" IS NULL OR "requestId" ~ '^[A-Za-z0-9_-]{1,64}$') AND
    ("approvedHeadSha" IS NULL OR "approvedHeadSha" ~ '^[0-9a-f]{40}$') AND
    ("approvedDiffDigest" IS NULL OR "approvedDiffDigest" ~ '^[0-9a-f]{64}$') AND
    (("approvedHeadSha" IS NULL) = ("approvedDiffDigest" IS NULL)) AND
    ("remakeIdeaId" IS NULL OR "remakeIdeaId" ~ '^[A-Za-z0-9_-]{1,64}$') AND
    ("cancelReason" IS NULL OR "cancelReason" ~ '^[a-z_]{1,64}$') AND
    (("handoffReason" IS NULL) = ("handoffAt" IS NULL)) AND
    ("handoffReason" IS NULL OR "handoffReason" ~ '^[a-z_]{1,64}$') AND
    ("localCardId" IS NULL OR "localCardId" ~ '^[A-Za-z0-9_-]{1,64}$') AND
    -- A handed-off settlement's card closes too: the person decides elsewhere.
    ("localCardClosedAt" IS NULL OR ("localCardId" IS NOT NULL AND
      ("state" <> 'open' OR "handoffAt" IS NOT NULL)))
  ),
  CONSTRAINT "AmuxDmOwnerSettlement_state_check" CHECK (
    ("state" = 'open' AND "decision" IS NULL AND "answerSource" IS NULL AND
      "decidedAt" IS NULL AND "cancelReason" IS NULL AND
      "approvedHeadSha" IS NULL AND "remakeIdeaId" IS NULL) OR
    ("state" = 'applied' AND "answerSource" IS NOT NULL AND "requestId" IS NOT NULL AND
      "decidedAt" IS NOT NULL AND "cancelReason" IS NULL AND "handoffAt" IS NULL AND
      (("kind" = 'stopped' AND "decision" IN ('retry', 'complete', 'close', 'remake')) OR
       ("kind" = 't2_pr' AND "decision" IN ('approve', 'retry', 'close'))) AND
      -- An approval names the exact change it approved, and only an approval does.
      (("decision" = 'approve') = ("approvedHeadSha" IS NOT NULL)) AND
      (("decision" = 'remake') = ("remakeIdeaId" IS NOT NULL))) OR
    -- A remake whose idea was filed before the Task moved keeps the idea's id.
    ("state" = 'cancelled' AND "decision" IS NULL AND "cancelReason" IS NOT NULL AND
      "approvedHeadSha" IS NULL)
  ),
  CONSTRAINT "AmuxDmOwnerSettlement_taskId_fkey" FOREIGN KEY ("taskId")
    REFERENCES "AmuxWorkItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxDmOwnerSettlement_escalationId_fkey" FOREIGN KEY ("escalationId")
    REFERENCES "AmuxHumanEscalation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxDmOwnerSettlement_attemptId_fkey" FOREIGN KEY ("attemptId")
    REFERENCES "AmuxExecutionAttempt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- One settlement per escalation: a card is asked about once per stop.
CREATE UNIQUE INDEX "AmuxDmOwnerSettlement_escalationId_key"
  ON "AmuxDmOwnerSettlement"("escalationId");
CREATE UNIQUE INDEX "AmuxDmOwnerSettlement_localCardId_key"
  ON "AmuxDmOwnerSettlement"("localCardId");
CREATE INDEX "AmuxDmOwnerSettlement_state_createdAt_idx"
  ON "AmuxDmOwnerSettlement"("state", "createdAt");
CREATE INDEX "AmuxDmOwnerSettlement_taskId_createdAt_idx"
  ON "AmuxDmOwnerSettlement"("taskId", "createdAt");

COMMIT;
