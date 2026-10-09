-- Durable Auto stop latch. It stores only closed operational aggregates and
-- incident codes; no prompt, digest, user, conversation or attachment data.
CREATE TABLE "PromptRefinerProductOperationalGuard" (
  "id" TEXT PRIMARY KEY,
  "state" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "baselineAt" TIMESTAMPTZ(3) NOT NULL,
  "pausedAt" TIMESTAMPTZ(3),
  "reasonCode" TEXT,
  "sampleSize" INTEGER NOT NULL,
  "p90LatencyMs" INTEGER,
  "fallbackCount" INTEGER,
  "lastTransitionAuditLogId" TEXT NOT NULL UNIQUE REFERENCES
    "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "transitionedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "PromptRefinerProductOperationalGuard_id_check"
    CHECK ("id" = 'auto'),
  CONSTRAINT "PromptRefinerProductOperationalGuard_state_check"
    CHECK ("state" IN ('active', 'paused')),
  CONSTRAINT "PromptRefinerProductOperationalGuard_generation_check"
    CHECK ("generation" > 0),
  CONSTRAINT "PromptRefinerProductOperationalGuard_reason_check"
    CHECK ("reasonCode" IS NULL OR "reasonCode" IN (
      'latency_p90_exceeded', 'original_fallback_rate_exceeded',
      'critical_safety_failure', 'unknown_dispatch_or_cost', 'audit_failure'
    )),
  CONSTRAINT "PromptRefinerProductOperationalGuard_counts_check"
    CHECK ("sampleSize" >= 0 AND
      ("p90LatencyMs" IS NULL OR "p90LatencyMs" >= 0) AND
      ("fallbackCount" IS NULL OR "fallbackCount" >= 0)),
  CONSTRAINT "PromptRefinerProductOperationalGuard_shape_check" CHECK (
    ("state" = 'active' AND "pausedAt" IS NULL AND "reasonCode" IS NULL
      AND "sampleSize" = 0 AND "p90LatencyMs" IS NULL
      AND "fallbackCount" IS NULL)
    OR
    ("state" = 'paused' AND "pausedAt" IS NOT NULL
      AND "reasonCode" IS NOT NULL)
  ),
  CONSTRAINT "PromptRefinerProductOperationalGuard_threshold_check" CHECK (
    ("reasonCode" = 'latency_p90_exceeded' AND "sampleSize" = 100
      AND "p90LatencyMs" > 6000 AND "fallbackCount" IS NOT NULL)
    OR
    ("reasonCode" = 'original_fallback_rate_exceeded' AND "sampleSize" = 100
      AND "fallbackCount" > 5 AND "p90LatencyMs" IS NOT NULL)
    OR
    ("reasonCode" IN ('critical_safety_failure',
      'unknown_dispatch_or_cost', 'audit_failure')
      AND "sampleSize" >= 0)
    OR "reasonCode" IS NULL
  ),
  CONSTRAINT "PromptRefinerProductOperationalGuard_time_check"
    CHECK ("transitionedAt" >= "baselineAt" AND
      ("pausedAt" IS NULL OR "pausedAt" >= "baselineAt"))
);

CREATE FUNCTION "guard_prompt_refiner_product_operational_guard"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'prompt_refiner_product_operational_guard_delete_forbidden';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'active' OR NEW."generation" <> 1 THEN
      RAISE EXCEPTION 'prompt_refiner_product_operational_guard_initial_invalid';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."lastTransitionAuditLogId" IS NOT DISTINCT FROM OLD."lastTransitionAuditLogId"
    OR NEW."transitionedAt" <= OLD."transitionedAt" THEN
    RAISE EXCEPTION 'prompt_refiner_product_operational_guard_transition_invalid';
  END IF;
  IF OLD."state" = 'active' AND NEW."state" = 'paused' THEN
    IF NEW."generation" IS DISTINCT FROM OLD."generation"
      OR NEW."baselineAt" IS DISTINCT FROM OLD."baselineAt" THEN
      RAISE EXCEPTION 'prompt_refiner_product_operational_guard_pause_invalid';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."state" = 'paused' AND NEW."state" = 'active' THEN
    IF NEW."generation" IS DISTINCT FROM OLD."generation" + 1
      OR NEW."baselineAt" IS DISTINCT FROM NEW."transitionedAt" THEN
      RAISE EXCEPTION 'prompt_refiner_product_operational_guard_resume_invalid';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'prompt_refiner_product_operational_guard_transition_invalid';
END $$;

CREATE TRIGGER "PromptRefinerProductOperationalGuard_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "PromptRefinerProductOperationalGuard"
  FOR EACH ROW EXECUTE FUNCTION "guard_prompt_refiner_product_operational_guard"();

CREATE FUNCTION "forbid_prompt_refiner_product_operational_guard_truncate"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'prompt_refiner_product_operational_guard_truncate_forbidden';
END $$;

CREATE TRIGGER "PromptRefinerProductOperationalGuard_truncate_guard"
  BEFORE TRUNCATE ON "PromptRefinerProductOperationalGuard"
  FOR EACH STATEMENT EXECUTE FUNCTION
    "forbid_prompt_refiner_product_operational_guard_truncate"();
