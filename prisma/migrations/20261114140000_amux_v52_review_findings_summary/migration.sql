-- A rejected v52 review keeps a short, redacted summary of its findings so the
-- owner decides retry, higher-grade recovery or close from Admin (owner
-- decision 2026-11-14). Nullable: earlier records keep only their job id, and
-- the append-only trigger stays as it is, so no existing row is rewritten.
ALTER TABLE "AmuxV52ReviewRecord" ADD COLUMN "findingsSummary" TEXT;

ALTER TABLE "AmuxV52ReviewRecord"
  ADD CONSTRAINT "AmuxV52ReviewRecord_findings_summary_check"
  CHECK ("findingsSummary" IS NULL OR
    char_length("findingsSummary") BETWEEN 1 AND 2000);
