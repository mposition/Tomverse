-- Why each candidate was or was not chosen, frozen at decision time.
--
-- Dark, on the same condition as the tables before it: nothing reads or writes
-- it, and `npm run check:dark-tables` holds that.
--
-- ---------------------------------------------------------------------------
-- What this replaces, and why a count was not enough
-- ---------------------------------------------------------------------------
--
-- `RoutingRun.rejectedByReason` stores a count per reason. The comment on the
-- code that builds it says which models were refused is "stable catalogue
-- information a reader can reconstruct", and that is not true: candidates come
-- from the runtime registry (`runtimeModels.filter(...)` in the chat route),
-- where `enabled`, `catalogDeleted`, `minimumPlan`, the context window and
-- backend readiness all move, and the health and credit verdicts are that
-- moment's state. Nothing about a past decision can be rebuilt from a count.
--
-- One row per candidate, and the eligible ones are recorded too. An earlier
-- draft of this table held only rejections, which left it unable to say why a
-- model that passed every filter still lost -- the question the table exists
-- for. `verdict` and a nullable `reason` carry both, with a CHECK so the two
-- cannot disagree.
--
-- There is deliberately no per-run cap. Any cut drops the lowest-ranked and the
-- newest deployments first, which are exactly the candidates somebody is
-- asking about. Size is controlled where it belongs -- at config publish time,
-- by an approved ceiling on the active routing snapshot -- rather than by
-- discarding evidence at run time.
--
-- Content-free: identifiers, a fixed reason, a rank. No prompt, no balance, no
-- provider text. `RoutingRun` is content-free for the same reason and this
-- keeps that true of its children.
--
-- Cascade on the run, matching `RoutingAttempt`: the verdicts describe one
-- decision and have no meaning without it.
--
-- Rollback: drop the table. Nothing else is read or written.

CREATE TABLE "RoutingCandidateVerdict" (
    "id" TEXT NOT NULL,
    "routingRunId" TEXT NOT NULL,
    "logicalModelId" TEXT NOT NULL,
    "modelDeploymentId" TEXT,
    "verdict" TEXT NOT NULL,
    "reason" TEXT,
    "rank" INTEGER,
    "rankBucket" INTEGER,
    "decisionInputSnapshotId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutingCandidateVerdict_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RoutingCandidateVerdict"
    ADD CONSTRAINT "RoutingCandidateVerdict_verdict_check"
    CHECK ("verdict" IN ('eligible', 'rejected'));

-- The eleven reasons the candidate filter can give. Mirrors
-- CANDIDATE_REJECTIONS in lib/routerCandidates.ts; a reason the list does not
-- know would be a refusal nobody could interpret.
ALTER TABLE "RoutingCandidateVerdict"
    ADD CONSTRAINT "RoutingCandidateVerdict_reason_check"
    CHECK (
        "reason" IS NULL
        OR "reason" IN (
            'disabled',
            'plan',
            'image_input_unsupported',
            'web_search_unsupported',
            'web_search_unverified',
            'web_search_cost_unbounded',
            'context_window_undeclared',
            'context_exceeded',
            'unhealthy',
            'region_unavailable',
            'insufficient_credits'
        )
    );

-- A rejection says why; an eligible candidate has no why to give. Without
-- this, a row could claim both or neither and a report would count it twice or
-- not at all.
ALTER TABLE "RoutingCandidateVerdict"
    ADD CONSTRAINT "RoutingCandidateVerdict_reason_matches_verdict_check"
    CHECK (
        ("verdict" = 'rejected' AND "reason" IS NOT NULL)
        OR ("verdict" = 'eligible' AND "reason" IS NULL)
    );

-- A rank is where a candidate came among those that survived. A rejected
-- candidate was never ranked, and giving it a rank would place it in an order
-- it was not in.
ALTER TABLE "RoutingCandidateVerdict"
    ADD CONSTRAINT "RoutingCandidateVerdict_rank_matches_verdict_check"
    CHECK (
        ("verdict" = 'rejected' AND "rank" IS NULL AND "rankBucket" IS NULL)
        OR "verdict" = 'eligible'
    );

ALTER TABLE "RoutingCandidateVerdict"
    ADD CONSTRAINT "RoutingCandidateVerdict_rank_positive_check"
    CHECK (
        ("rank" IS NULL OR "rank" >= 1)
        AND ("rankBucket" IS NULL OR "rankBucket" >= 0)
    );

-- One verdict per candidate per run. Two rows for one candidate are two
-- answers to one question, and a report would take whichever it read first.
--
-- Two partial indexes rather than one over three columns, because PostgreSQL
-- treats NULLs as distinct in a unique index: with a single index, two rows
-- for the same model and no deployment would both be accepted, which is
-- exactly the duplicate this is meant to stop and the common case while
-- deployments do not yet exist.
CREATE UNIQUE INDEX "RoutingCandidateVerdict_run_model_key"
    ON "RoutingCandidateVerdict"("routingRunId", "logicalModelId")
    WHERE "modelDeploymentId" IS NULL;
CREATE UNIQUE INDEX "RoutingCandidateVerdict_run_deployment_key"
    ON "RoutingCandidateVerdict"("routingRunId", "logicalModelId", "modelDeploymentId")
    WHERE "modelDeploymentId" IS NOT NULL;

CREATE INDEX "RoutingCandidateVerdict_routingRunId_verdict_idx"
    ON "RoutingCandidateVerdict"("routingRunId", "verdict");
CREATE INDEX "RoutingCandidateVerdict_reason_idx"
    ON "RoutingCandidateVerdict"("reason");

ALTER TABLE "RoutingCandidateVerdict"
    ADD CONSTRAINT "RoutingCandidateVerdict_routingRunId_fkey"
    FOREIGN KEY ("routingRunId") REFERENCES "RoutingRun"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
