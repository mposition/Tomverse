-- §5 of docs/policy/tomverse-chat-routing.md: RoutingAttempt and an immutable
-- per-attempt ContextManifest, plus the aggregate columns RoutingRun was
-- missing.
--
-- The point of separate tables is that one logical response can produce
-- several attempts -- primary fails pre-token, fallback's Planner fails and is
-- never dispatched, fallback pass-through succeeds -- each with its own model,
-- tokenizer, Planner mode and effective request. Flattened onto the run those
-- overwrite each other; put in a JSON array they cannot carry the constraints
-- below, which are the whole reason the records exist.

ALTER TABLE "RoutingRun"
    ADD COLUMN "initialModelId" TEXT,
    ADD COLUMN "finalModelId" TEXT,
    ADD COLUMN "finalAttemptId" TEXT,
    ADD COLUMN "rerouteCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "fallbackState" TEXT NOT NULL DEFAULT 'none',
    ADD COLUMN "passThroughUsed" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "assistantMessageId" TEXT,
    ADD COLUMN "totalLatencyMs" INTEGER,
    ADD COLUMN "firstTokenMs" INTEGER,
    ADD COLUMN "reservationId" TEXT,
    ADD COLUMN "settlementOutcome" TEXT,
    ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "RoutingRun_finalAttemptId_key" ON "RoutingRun"("finalAttemptId");
CREATE INDEX "RoutingRun_finalModelId_createdAt_idx" ON "RoutingRun"("finalModelId", "createdAt");

ALTER TABLE "RoutingRun"
    ADD CONSTRAINT "RoutingRun_fallbackState_check"
    CHECK ("fallbackState" IN ('none', 'fallback_used', 'exhausted'));

-- A run that took no reroute cannot be in a fallback state, and one that says
-- it fell back must have rerouted at least once.
ALTER TABLE "RoutingRun"
    ADD CONSTRAINT "RoutingRun_fallback_agreement_check"
    CHECK (
        ("fallbackState" = 'none' AND "rerouteCount" = 0)
        OR ("fallbackState" <> 'none' AND "rerouteCount" >= 1)
    );

CREATE TABLE "RoutingAttempt" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT,
    "attemptIndex" INTEGER NOT NULL,
    "modelId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "plannerMode" TEXT NOT NULL DEFAULT 'planned',
    "outcome" TEXT NOT NULL DEFAULT 'pending',
    "failureLayer" TEXT NOT NULL DEFAULT 'none',
    "manifestFinalizedAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "providerRequestId" TEXT,
    "firstVisibleTokenAt" TIMESTAMP(3),
    "actualInputTokens" INTEGER,
    "actualOutputTokens" INTEGER,
    "errorClass" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoutingAttempt_pkey" PRIMARY KEY ("id")
);

-- Also the concurrency control: two writers opening "attempt 2" for one run is
-- a bug, and this makes it an error rather than a silent second row.
CREATE UNIQUE INDEX "RoutingAttempt_runId_attemptIndex_key"
    ON "RoutingAttempt"("runId", "attemptIndex");
CREATE INDEX "RoutingAttempt_outcome_createdAt_idx" ON "RoutingAttempt"("outcome", "createdAt");
CREATE INDEX "RoutingAttempt_modelId_createdAt_idx" ON "RoutingAttempt"("modelId", "createdAt");
CREATE INDEX "RoutingAttempt_userId_createdAt_idx" ON "RoutingAttempt"("userId", "createdAt");

ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "RoutingRun"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RoutingRun"
    ADD CONSTRAINT "RoutingRun_finalAttemptId_fkey"
    FOREIGN KEY ("finalAttemptId") REFERENCES "RoutingAttempt"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_plannerMode_check"
    CHECK ("plannerMode" IN ('planned', 'pass_through'));

-- `pending` is not one of §5's outcomes on purpose: that section enumerates how
-- an attempt ended, and one in flight has not ended. Starting life as
-- `not_dispatched` would leave every dispatched attempt labelled as one that
-- never reached a provider.
ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_outcome_check"
    CHECK ("outcome" IN (
        'pending', 'not_dispatched', 'failed_pre_token', 'failed_post_token',
        'cancelled', 'succeeded'
    ));

ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_failureLayer_check"
    CHECK ("failureLayer" IN (
        'planner', 'adapter', 'manifest', 'billing', 'provider', 'stream', 'none'
    ));

-- ROUTE-06, as a constraint rather than a query somebody remembers to run:
-- "Dispatch is prohibited unless manifest finalization and the attempt
-- reference both succeed." A dispatched attempt therefore has a finalized
-- manifest, and the finalization is not after the dispatch it authorised.
ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_dispatch_requires_finalized_manifest_check"
    CHECK (
        "dispatchedAt" IS NULL
        OR ("manifestFinalizedAt" IS NOT NULL AND "manifestFinalizedAt" <= "dispatchedAt")
    );

-- §5: "A not_dispatched attempt is retained for reliability analysis but does
-- not count as a provider attempt and cannot be billed as provider usage."
ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_not_dispatched_check"
    CHECK (
        "outcome" <> 'not_dispatched'
        OR (
            "dispatchedAt" IS NULL
            AND "providerRequestId" IS NULL
            AND "firstVisibleTokenAt" IS NULL
            AND "actualInputTokens" IS NULL
            AND "actualOutputTokens" IS NULL
        )
    );

-- A failure names its layer and a success does not, so neither is inferred
-- from the other's absence. An attempt still in flight has not failed either.
ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_failureLayer_agreement_check"
    CHECK (
        ("outcome" IN ('pending', 'succeeded', 'cancelled') AND "failureLayer" = 'none')
        OR "outcome" NOT IN ('pending', 'succeeded', 'cancelled')
    );

-- A visible token means the provider was reached.
ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_visible_token_requires_dispatch_check"
    CHECK ("firstVisibleTokenAt" IS NULL OR "dispatchedAt" IS NOT NULL);

CREATE TABLE "ContextManifest" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "userId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "sourceRefs" JSONB NOT NULL,
    "summaryVersion" TEXT,
    "inclusionRange" JSONB,
    "truncationPoints" JSONB,
    "tokenizerVersion" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "contextWindowTokens" INTEGER NOT NULL,
    "plannerVersion" TEXT,
    "templateVersion" TEXT,
    "adapterVersion" TEXT,
    "structuredOptionsHash" TEXT,
    "effectiveRequestHash" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "notDispatchedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContextManifest_pkey" PRIMARY KEY ("id")
);

-- One manifest per attempt, never shared. A fallback model may receive
-- different context, different tokenization and a different effective request,
-- so a manifest two attempts both pointed at would describe neither.
CREATE UNIQUE INDEX "ContextManifest_attemptId_key" ON "ContextManifest"("attemptId");
CREATE INDEX "ContextManifest_state_createdAt_idx" ON "ContextManifest"("state", "createdAt");
CREATE INDEX "ContextManifest_userId_createdAt_idx" ON "ContextManifest"("userId", "createdAt");

ALTER TABLE "ContextManifest"
    ADD CONSTRAINT "ContextManifest_attemptId_fkey"
    FOREIGN KEY ("attemptId") REFERENCES "RoutingAttempt"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContextManifest"
    ADD CONSTRAINT "ContextManifest_state_check"
    CHECK ("state" IN ('draft', 'finalized', 'not_dispatched'));

-- Finalization is the moment the manifest becomes evidence, so everything
-- §5 step 4 adds has to be present -- a finalized manifest missing its
-- effective-request hash proves nothing about what was sent.
ALTER TABLE "ContextManifest"
    ADD CONSTRAINT "ContextManifest_finalized_completeness_check"
    CHECK (
        "state" <> 'finalized'
        OR (
            "finalizedAt" IS NOT NULL
            AND "plannerVersion" IS NOT NULL
            AND "adapterVersion" IS NOT NULL
            AND "effectiveRequestHash" IS NOT NULL
        )
    );

ALTER TABLE "ContextManifest"
    ADD CONSTRAINT "ContextManifest_finalizedAt_agreement_check"
    CHECK (("state" = 'finalized') = ("finalizedAt" IS NOT NULL));

-- An abandoned draft says why. "not_dispatched with no reason" is the state
-- §6 exists to make impossible to record by accident.
ALTER TABLE "ContextManifest"
    ADD CONSTRAINT "ContextManifest_not_dispatched_reason_check"
    CHECK ("state" <> 'not_dispatched' OR "notDispatchedReason" IS NOT NULL);

-- The context limit check, on the row that holds both halves. A manifest whose
-- own token count exceeds the window it was built for is the over-limit
-- request ESTIMATE-03 has zero tolerance for.
ALTER TABLE "ContextManifest"
    ADD CONSTRAINT "ContextManifest_within_window_check"
    CHECK ("tokenCount" >= 0 AND "contextWindowTokens" > 0 AND "tokenCount" <= "contextWindowTokens");

-- Immutability, as a trigger because no CHECK can compare a row to its own
-- previous value.
--
-- Total rather than field-by-field on purpose: an allowlist of still-editable
-- columns is a list somebody extends, and the first extension is the one that
-- makes the hash stop meaning anything. A finalized manifest is finished.
CREATE OR REPLACE FUNCTION "context_manifest_finalized_is_immutable"()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD."finalizedAt" IS NOT NULL THEN
        RAISE EXCEPTION
            'ContextManifest % is finalized and cannot be modified', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    -- The binding is fixed at creation, not at finalization. A manifest's
    -- tokenizer, token count and window were chosen for one attempt's model;
    -- moving even a draft to another attempt would attach context sized for
    -- one model to a different one, which is the exact hazard that makes the
    -- manifest attempt-scoped in the first place.
    IF NEW."attemptId" IS DISTINCT FROM OLD."attemptId" THEN
        RAISE EXCEPTION
            'ContextManifest % cannot be moved to another attempt', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "context_manifest_finalized_is_immutable_trigger"
    BEFORE UPDATE ON "ContextManifest"
    FOR EACH ROW
    EXECUTE FUNCTION "context_manifest_finalized_is_immutable"();
