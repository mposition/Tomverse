-- Dark v25 aggregate cells keep the same invocation-time role vocabulary.
-- NULL is reserved for a folded parent cell; no rows are backfilled.
ALTER TABLE "AmuxCliUsageAggregateCell"
  ADD CONSTRAINT "AmuxCliUsageAggregateCell_workerRole_check" CHECK (
    "workerRole" IS NULL OR "workerRole" IN ('design', 'implement', 'test',
      'review', 'verify', 'investigate', 'operate', 'idea_analysis')
  );
