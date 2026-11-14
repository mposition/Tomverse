-- baseline-check: present-if-relation "AmuxProcessAuditReport"
-- Owner request 2026-11-14: the AMUX process analysis runs on a cadence and
-- its reports sit in Admin › Execution board › Process analysis. One row per
-- report: the deterministic figures the app computed for the window, the
-- box Codex CLI's structured reading of them and of develop, and the
-- Markdown the owner reads. No user content, no secret: the figures are
-- aggregates and card display keys only, and the app masks the model's text
-- before it is stored (lib/amuxProcessAuditCore.ts).
--
-- Additive: one new table, no existing row changes. Rows older than 26 weeks
-- are removed when a new report is stored (lib/amuxProcessAuditStore.ts).
BEGIN;

CREATE TABLE "AmuxProcessAuditReport" (
  "id" TEXT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "windowEnd" TIMESTAMP(3) NOT NULL,
  "developSha" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "model" TEXT,
  "trigger" TEXT NOT NULL,
  "metrics" JSONB NOT NULL,
  "analysis" JSONB NOT NULL,
  "markdown" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AmuxProcessAuditReport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AmuxProcessAuditReport_shape_check" CHECK (
    "windowEnd" > "windowStart" AND
    "developSha" ~ '^[0-9a-f]{40}$' AND
    "channel" IN ('codex-subscription') AND
    ("model" IS NULL OR "model" ~ '^[A-Za-z0-9._:-]{1,80}$') AND
    "trigger" IN ('schedule', 'run_now') AND
    jsonb_typeof("metrics") = 'object' AND
    jsonb_typeof("analysis") = 'object' AND
    char_length("markdown") BETWEEN 1 AND 120000
  )
);

CREATE INDEX "AmuxProcessAuditReport_createdAt_idx" ON "AmuxProcessAuditReport"("createdAt");

COMMIT;
