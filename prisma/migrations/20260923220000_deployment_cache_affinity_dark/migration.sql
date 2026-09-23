-- What a deployment's prompt cache does, and where a conversation has been
-- landing. Added dark.
--
-- Same condition as the tables before it: nothing reads or writes either, and
-- `npm run check:dark-tables` holds that.
--
-- ---------------------------------------------------------------------------
-- Why two facts instead of one probability
-- ---------------------------------------------------------------------------
--
-- The routing ADR asks for `P(cache_hit | session, deployment)` folded into an
-- effective cost. That is not what this is, for two reasons.
--
-- Folding a saving into cost is a change to the objective function, which is
-- lexicographic by decision. A probability multiplied by a price is a weighted
-- sum whichever name it is given.
--
-- And the probability cannot be computed from anything this schema holds. A
-- cache hit needs a byte-identical prefix; no table here records a prefix or a
-- digest of one, deliberately, because a prefix digest is derived from what
-- the person wrote. So the number would be a prior with a decimal point on it.
--
-- What is recorded is what can be observed: whether a provider's cache was
-- verified and what its window is, and which deployment a conversation's turns
-- last went to. Those two answer "is the last serve inside the window", which
-- is a comparison of clocks and not a prediction.
--
-- ---------------------------------------------------------------------------
-- These columns do not decide whether a request carries a cache marker
-- ---------------------------------------------------------------------------
--
-- That decision is lib/anthropicPromptCaching.ts and stays there. It gates on
-- the registry's provider identity, because `createAnthropic()` also builds
-- MiniMax's client and a marker written for "the Anthropic provider" would
-- reach an endpoint whose caching semantics were never verified. A dispatcher
-- consulting a column here instead would be a second answer to that question,
-- and the two would drift apart without either saying so.
--
-- Rollback: drop the table and the five columns. Nothing else is read.

-- ---------------------------------------------------------------------------
-- 1. Cache capability on the deployment
-- ---------------------------------------------------------------------------

ALTER TABLE "ModelDeployment"
    ADD COLUMN "promptCacheSupport" TEXT NOT NULL DEFAULT 'unproven',
    ADD COLUMN "promptCacheMinPrefixTokens" INTEGER,
    ADD COLUMN "promptCacheTtlSeconds" INTEGER,
    ADD COLUMN "promptCacheVerifiedAt" TIMESTAMP(3),
    ADD COLUMN "promptCacheEvidenceRef" TEXT;

-- `unproven` is the default and is a third answer, not a synonym for either of
-- the others. A deployment nobody has checked is not "no cache" -- treating it
-- as such writes off a saving nobody measured -- and it is not a cache either.
--
-- The last two split on who sends what. A ranking that could not tell them
-- apart would be assuming a marker either is or is not needed:
-- `verified_automatic` is a provider caching a repeated prefix on its own, and
-- `verified_explicit` is one where the request must carry a marker and the
-- write costs a premium.
--
-- The word `automatic` means something else in lib/anthropicPromptCaching.ts,
-- which says "automatic prompt caching" about a path that sends a top-level
-- cache_control marker. That path is `verified_explicit` here. An Anthropic
-- deployment written as `verified_automatic` because of that sentence reads as
-- one needing no marker and paying no write premium.
ALTER TABLE "ModelDeployment"
    ADD CONSTRAINT "ModelDeployment_promptCacheSupport_check"
    CHECK ("promptCacheSupport" IN (
        'unproven',
        'verified_absent',
        'verified_automatic',
        'verified_explicit'
    ));

ALTER TABLE "ModelDeployment"
    ADD CONSTRAINT "ModelDeployment_prompt_cache_figures_sane_check"
    CHECK (
        ("promptCacheTtlSeconds" IS NULL OR "promptCacheTtlSeconds" > 0)
        AND ("promptCacheMinPrefixTokens" IS NULL OR "promptCacheMinPrefixTokens" >= 0)
    );

-- The `IS NOT NULL` before each regex is not redundant. A CHECK passes when
-- its expression is TRUE *or NULL*, and `NULL ~ '...'` is NULL: without it, a
-- verified row with no evidence reference at all evaluated
-- FALSE OR NULL OR FALSE and the database accepted the row the validator
-- calls malformed. The rule for any branch here is that a comparison against
-- a nullable column must be one that cannot itself be NULL.
--
-- The blank test is a character class rather than btrim, because btrim
-- strips only U+0020 while JavaScript's trim() strips every Unicode space.
-- The two definitions disagreed: an evidence reference of one tab satisfied
-- length(btrim(...)) > 0 here and was refused by the validator, so the row
-- the database accepted was one the application called malformed. Both sides
-- now name the same six characters.
--
-- An unproven deployment carries no figures and no verification, because a
-- figure is the result of the check that has not happened. A number sitting
-- beside 'unproven' is one nobody can say the origin of, and it would be read
-- as measured.
--
-- Every other state is a claim that somebody checked, so it names when and
-- what. Without both, "verified" is a word rather than a record.
--
-- A cache found absent has no window: a window for a cache that does not exist
-- is the contradiction this stops. A cache found present must have one, or it
-- cannot be aged and would be believed forever -- the failure
-- QuotaCapacityState stops with its refill time.
ALTER TABLE "ModelDeployment"
    ADD CONSTRAINT "ModelDeployment_prompt_cache_evidence_check"
    CHECK (
        (
            "promptCacheSupport" = 'unproven'
            AND "promptCacheTtlSeconds" IS NULL
            AND "promptCacheMinPrefixTokens" IS NULL
            AND "promptCacheVerifiedAt" IS NULL
            AND "promptCacheEvidenceRef" IS NULL
        )
        OR (
            "promptCacheSupport" = 'verified_absent'
            AND "promptCacheTtlSeconds" IS NULL
            AND "promptCacheMinPrefixTokens" IS NULL
            AND "promptCacheVerifiedAt" IS NOT NULL
            AND "promptCacheEvidenceRef" IS NOT NULL
            AND "promptCacheEvidenceRef" ~ E'[^ \\t\\n\\r\\f\\v]'
        )
        OR (
            "promptCacheSupport" IN ('verified_automatic', 'verified_explicit')
            AND "promptCacheTtlSeconds" IS NOT NULL
            AND "promptCacheVerifiedAt" IS NOT NULL
            AND "promptCacheEvidenceRef" IS NOT NULL
            AND "promptCacheEvidenceRef" ~ E'[^ \\t\\n\\r\\f\\v]'
        )
    );

-- The evidence reference is a path or an identifier, not a transcript. The
-- cap is what stops it becoming somewhere to paste the prefix that was
-- tested, which is the content this table is built to not hold.
ALTER TABLE "ModelDeployment"
    ADD CONSTRAINT "ModelDeployment_promptCacheEvidenceRef_length_check"
    CHECK ("promptCacheEvidenceRef" IS NULL OR length("promptCacheEvidenceRef") <= 512);

-- ---------------------------------------------------------------------------
-- 2. Where a conversation has been landing
-- ---------------------------------------------------------------------------
--
-- One row per conversation and logical model. The logical model is part of the
-- key because a person can switch models inside one conversation, and the two
-- prefixes are cached separately by separate providers; a single row per
-- conversation would have the second model overwrite the first's affinity and
-- then report it as the place to go back to.
--
-- There is no prefix digest, and there will not be one here. It would make the
-- window answer sharper, and it is derived from what the person wrote --
-- routing telemetry stays content-free for the reason ComparisonReviewRun
-- does. A digest also confirms a guess: given a candidate prefix, it says
-- whether that is what was sent.
CREATE TABLE "DeploymentCacheAffinity" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "logicalModelId" TEXT NOT NULL,
    "modelDeploymentId" TEXT NOT NULL,
    "lastServedAt" TIMESTAMP(3) NOT NULL,
    "servedTurns" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeploymentCacheAffinity_pkey" PRIMARY KEY ("id")
);

-- A row exists because a turn landed somewhere. Zero would be a row about an
-- event that did not happen.
ALTER TABLE "DeploymentCacheAffinity"
    ADD CONSTRAINT "DeploymentCacheAffinity_servedTurns_positive_check"
    CHECK ("servedTurns" >= 1);

CREATE UNIQUE INDEX "DeploymentCacheAffinity_conversationId_logicalModelId_key"
    ON "DeploymentCacheAffinity"("conversationId", "logicalModelId");
CREATE INDEX "DeploymentCacheAffinity_modelDeploymentId_lastServedAt_idx"
    ON "DeploymentCacheAffinity"("modelDeploymentId", "lastServedAt");

-- Cascade on both sides, for the same reason and not by default. Without the
-- conversation the row is an affinity for a thread that no longer exists, and
-- it still names that thread's id; without the deployment it points at a
-- placement that is gone. Neither survivor says anything true, and the
-- conversation one would be a half-anonymisation after a person deletes.
ALTER TABLE "DeploymentCacheAffinity"
    ADD CONSTRAINT "DeploymentCacheAffinity_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "DeploymentCacheAffinity"
    ADD CONSTRAINT "DeploymentCacheAffinity_modelDeploymentId_fkey"
    FOREIGN KEY ("modelDeploymentId") REFERENCES "ModelDeployment"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT;
