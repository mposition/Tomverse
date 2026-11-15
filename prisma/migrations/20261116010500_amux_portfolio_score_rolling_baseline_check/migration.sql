-- Owner direction 2026-11-15: an unchanged score never waits at its 28-day
-- baseline for an owner to confirm it again. A system refresh may move the
-- baseline forward with the active window: never earlier than the evidence's
-- own 28 days, never later than 28 days past the snapshot's own computation.
-- `evidenceAsOf` and the active-window rule keep their exact rule, and every
-- existing row already holds this shape. A confirmation still writes the
-- evidence's exact baseline: the guard function (next migration) holds that.
ALTER TABLE "AmuxPortfolioScoreSnapshot"
  DROP CONSTRAINT "AmuxPortfolioScoreSnapshot_shape_check",
  ADD CONSTRAINT "AmuxPortfolioScoreSnapshot_shape_check" CHECK (
    "taskRevision" >= 0 AND "scoreVersion" = 'amux-v4-portfolio-v1' AND
    "scoreTotal" BETWEEN -100 AND 100 AND jsonb_typeof("components") = 'object' AND
    "inputDigest" ~ '^[a-f0-9]{64}$' AND
    "activeStaleAt" >= "evidenceAsOf" + INTERVAL '7 days' AND
    "activeStaleAt" <= LEAST("baselineStaleAt", "computedAt" + INTERVAL '7 days') AND
    "baselineStaleAt" >= "evidenceAsOf" + INTERVAL '28 days' AND
    "baselineStaleAt" <= "computedAt" + INTERVAL '28 days' AND
    "computedAt" >= "evidenceAsOf"
  );
