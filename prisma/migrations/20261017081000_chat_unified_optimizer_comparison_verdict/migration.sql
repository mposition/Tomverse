-- An aggregate, case-blind verdict is durable even when promotion is refused.
-- It is deliberately separate from the promotion receipt and grants no
-- runtime, paid-call, external-dispatch or Engineering Publisher authority.
CREATE TABLE "ChatUnifiedOptimizerComparisonVerdict" (
  "cycleId" UUID NOT NULL PRIMARY KEY,
  "candidateId" UUID NOT NULL UNIQUE,
  "requestId" UUID NOT NULL UNIQUE,
  "requestDigest" TEXT NOT NULL,
  "candidateDigest" TEXT NOT NULL,
  "pointerRevision" INTEGER NOT NULL,
  "incumbentKind" TEXT NOT NULL,
  "incumbentDigest" TEXT NOT NULL,
  "evidenceRef" TEXT NOT NULL,
  "summaryDigest" TEXT NOT NULL,
  "protocolDigest" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "reasonCodes" TEXT[] NOT NULL,
  "auditLogId" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "ChatUnifiedOptimizerComparisonVerdict_content_check" CHECK (
    "requestDigest" ~ '^[0-9a-f]{64}$'
    AND "candidateDigest" ~ '^[0-9a-f]{64}$'
    AND "incumbentDigest" ~ '^[0-9a-f]{64}$'
    AND "summaryDigest" ~ '^[0-9a-f]{64}$'
    AND "protocolDigest" ~ '^[0-9a-f]{64}$'
    AND "pointerRevision" >= 0
    AND "incumbentKind" IN ('legacy_path', 'active_frozen_bundle')
    AND "evidenceRef" ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,191}$'
    AND "decision" IN ('eligible_signal', 'retain_incumbent',
      'insufficient_evidence')
    AND cardinality("reasonCodes") BETWEEN 0 AND 12
    AND array_position("reasonCodes", NULL) IS NULL
    AND (cardinality("reasonCodes") = 0 OR
      array_to_string("reasonCodes", '|') ~
        '^[a-z][a-z0-9_]{0,63}([|][a-z][a-z0-9_]{0,63})*$')
    AND (("decision" = 'eligible_signal' AND
      cardinality("reasonCodes") = 0) OR
      ("decision" <> 'eligible_signal' AND
      cardinality("reasonCodes") > 0))
  )
);

ALTER TABLE "ChatUnifiedOptimizerComparisonVerdict"
  ADD CONSTRAINT "ChatUnifiedOptimizerComparisonVerdict_cycleId_fkey"
    FOREIGN KEY ("cycleId") REFERENCES "ChatUnifiedOptimizerCycle"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ChatUnifiedOptimizerComparisonVerdict_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "ChatUnifiedOptimizerCandidate"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ChatUnifiedOptimizerComparisonVerdict_auditLogId_fkey"
    FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "ChatUnifiedOptimizerComparisonVerdict_decision_createdAt_idx"
  ON "ChatUnifiedOptimizerComparisonVerdict"("decision", "createdAt");

CREATE FUNCTION "chat_unified_optimizer_comparison_verdict_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001',
    MESSAGE = 'chat_unified_optimizer_comparison_verdict_immutable';
END;
$$;
CREATE TRIGGER "chat_unified_optimizer_comparison_verdict_immutable"
  BEFORE UPDATE OR DELETE ON "ChatUnifiedOptimizerComparisonVerdict"
  FOR EACH ROW EXECUTE FUNCTION
    "chat_unified_optimizer_comparison_verdict_immutable"();
