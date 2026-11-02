-- The idea lane (owner decision 2026-11-02): an owner idea is implemented by
-- one GitHub Actions job running Claude Code, which opens a draft PR into
-- develop. Each claim of an idea is one row; a run that reports nothing before
-- its lease ends is retried by the next claim, up to the lane's attempt limit
-- (lib/amux/ideaLaneCore.ts). The rows hold no idea text.

-- CreateTable
CREATE TABLE "AmuxIdeaLaneAttempt" (
    "id" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "prNumber" INTEGER,

    CONSTRAINT "AmuxIdeaLaneAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AmuxIdeaLaneAttempt_ideaId_claimedAt_idx" ON "AmuxIdeaLaneAttempt"("ideaId", "claimedAt");

-- CreateIndex
CREATE INDEX "AmuxIdeaLaneAttempt_claimedAt_idx" ON "AmuxIdeaLaneAttempt"("claimedAt");

-- AddForeignKey
ALTER TABLE "AmuxIdeaLaneAttempt" ADD CONSTRAINT "AmuxIdeaLaneAttempt_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "AmuxIdeaSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An outcome is one of the fixed words the result route accepts, it comes
-- with its finish time, and only an opened PR carries a number.
ALTER TABLE "AmuxIdeaLaneAttempt" ADD CONSTRAINT "AmuxIdeaLaneAttempt_outcome_check"
    CHECK (("outcome" IS NULL) = ("finishedAt" IS NULL)
      AND ("outcome" IS NULL OR "outcome" IN ('pr_open', 'no_change', 'cli_failed',
        'workflow_edit', 'secret_in_diff', 'push_failed', 'job_failed'))
      AND (("outcome" = 'pr_open') = ("prNumber" IS NOT NULL AND "prNumber" > 0)));
