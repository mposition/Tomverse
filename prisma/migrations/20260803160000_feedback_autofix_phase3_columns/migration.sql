-- Phase 3 columns on the shadow case: fix branch/PR identity, the read-back
-- merge SHA, the staging confirmation SHA and the validated Red→Green proof.
-- All nullable: every existing case predates fix attempts, and Phase 3 stays
-- dark until FEEDBACK_AUTOFIX_ENABLED is set.
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "fixBranch" TEXT;
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "fixPrNumber" INTEGER;
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "fixPrUrl" TEXT;
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "mergeSha" TEXT;
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "stagingSha" TEXT;
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "redGreenProof" JSONB;
