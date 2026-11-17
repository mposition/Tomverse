-- Owner decision 2026-11-16: the legacy plain-line review findings summary is
-- no longer cut to 2,000 characters; a rejected review keeps its findings
-- (the sealed findings document is the current store, up to 4 MiB). Only the
-- upper bound of the CHECK goes: the summary stays non-empty when present.
-- Rollback: drop and add the constraint again with 2000 (no row over it
-- exists before this change).
ALTER TABLE "AmuxV52ReviewRecord"
  DROP CONSTRAINT "AmuxV52ReviewRecord_findings_summary_check",
  ADD CONSTRAINT "AmuxV52ReviewRecord_findings_summary_check" CHECK ((("findingsSummary" IS NULL) OR ((char_length("findingsSummary") >= 1))));
