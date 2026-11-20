-- Owner decision 2026-11-14: a score whose confirmed assessments are unchanged
-- may keep its active window open past seven days from the evidence, but never
-- past that evidence's 28-day baseline and never more than seven days past the
-- snapshot's own computation. `evidenceAsOf` and `baselineStaleAt` keep their
-- exact rule. Who may write an extended row is the guard function's question
-- (next migration): only the system score refresher, under the same assessments.
ALTER TABLE "AmuxPortfolioScoreSnapshot"
  DROP CONSTRAINT "AmuxPortfolioScoreSnapshot_shape_check",
  ADD CONSTRAINT "AmuxPortfolioScoreSnapshot_shape_check" CHECK (
    "taskRevision" >= 0 AND "scoreVersion" = 'amux-v4-portfolio-v1' AND
    "scoreTotal" BETWEEN -100 AND 100 AND jsonb_typeof("components") = 'object' AND
    "inputDigest" ~ '^[a-f0-9]{64}$' AND
    "activeStaleAt" >= "evidenceAsOf" + INTERVAL '7 days' AND
    "activeStaleAt" <= LEAST("baselineStaleAt", "computedAt" + INTERVAL '7 days') AND
    "baselineStaleAt" = "evidenceAsOf" + INTERVAL '28 days' AND
    "computedAt" >= "evidenceAsOf"
  );
