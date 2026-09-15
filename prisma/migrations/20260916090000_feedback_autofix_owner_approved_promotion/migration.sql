-- Owner-approved promotion columns on the auto-fix case
-- (docs/policy/trace-feedback-automation.md §9.3): the fix run's attempt id,
-- the reviewed head and
-- change manifest, the fix report, the owner's approval bound to that head and
-- manifest, and the server's own observations of the develop merge, staging,
-- the main promotion PR and production.
-- All nullable and additive: every existing case predates promotion, and
-- Phase 3 stays dark until FEEDBACK_AUTOFIX_ENABLED is set.
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "fixAttemptId" TEXT;
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "fixHeadSha" TEXT;
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "fixManifestDigest" TEXT;
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "fixManifest" JSONB;
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "fixReport" JSONB;
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "approvedHeadSha" TEXT;
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "approvedManifestDigest" TEXT;
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "stagingDeploymentId" TEXT;
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "stagingFirstSeenAt" TIMESTAMP(3);
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "stagingVerifiedAt" TIMESTAMP(3);
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "productionBranch" TEXT;
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "productionPrNumber" INTEGER;
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "productionPrUrl" TEXT;
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "productionPrHeadSha" TEXT;
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "productionMergeSha" TEXT;
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "productionDeploymentId" TEXT;
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "productionFirstSeenAt" TIMESTAMP(3);
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "productionVerifiedAt" TIMESTAMP(3);
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "promotionObservedAt" TIMESTAMP(3);
ALTER TABLE "FeedbackAutoFixCase" ADD COLUMN "promotionObservation" TEXT;
