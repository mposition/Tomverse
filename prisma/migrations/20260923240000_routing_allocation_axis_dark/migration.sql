-- How a candidate was picked, as its own axis. Added dark.
--
-- Two nullable columns on a live table. Nothing writes them, and
-- `npm run check:dark-tables` holds that for the column names as well as for
-- the dark tables beside them.
--
-- ---------------------------------------------------------------------------
-- Why not `RoutingRun.mode`
-- ---------------------------------------------------------------------------
--
-- `mode` answers "was this decision acted on". Its only value is `shadow`,
-- meaning the router computed a ranking and the person's own selection stayed
-- authoritative.
--
-- Allocation answers a different question: given that a ranking was computed,
-- was the top of it taken, or was something else taken on purpose. A shadow
-- run can be either, and so can a live one.
--
-- Folding them would produce a value like `shadow_explore` whose two halves
-- have to be pulled apart again by every reader, and the first reader to get
-- that wrong reports an exploration rate over the wrong denominator. So this
-- is a second column rather than more values in the first.
--
-- ---------------------------------------------------------------------------
-- Why the seed grain sits beside it
-- ---------------------------------------------------------------------------
--
-- The ADR's own first risk is that a per-request seed breaks cache affinity: a
-- conversation that re-rolls its allocation every turn never returns to the
-- placement holding its prefix, and the saving disappears with nothing
-- reporting a failure.
--
-- DeploymentCacheAffinity records where turns landed. This records what the
-- allocator was seeded on. Neither alone says whether affinity was broken on
-- purpose or by accident; together they do.
--
-- ---------------------------------------------------------------------------
-- Why both are nullable and neither defaults
-- ---------------------------------------------------------------------------
--
-- Every existing row was written before an allocator existed, and no backfill
-- can say what it would have done. A default of 'deterministic' would read as
-- "we took the top candidate" on runs where nobody chose anything, which is
-- the invented attribution the rest of this work refuses.
--
-- Nullable also keeps the existing writer working untouched: it names neither
-- column, so it keeps inserting rows the way it does today.
--
-- Rollback: drop the two columns and the constraint. Nothing reads them.

ALTER TABLE "RoutingRun"
    ADD COLUMN "allocationMode" TEXT,
    ADD COLUMN "allocationSeedGrain" TEXT;

-- The two closed lists, each as its own constraint.
--
-- Separate from the shape rule below, and written in the plain
-- `"col" IS NULL OR "col" IN (...)` form, because that is the form
-- `npm run check:enum-constraints` reads. A list folded into a multi-branch
-- OR is a list the gate cannot see, and an unseen list is one the application
-- can drift away from -- which is the whole failure that check exists for.
ALTER TABLE "RoutingRun"
    ADD CONSTRAINT "RoutingRun_allocationMode_check"
    CHECK (
        "allocationMode" IS NULL
        OR "allocationMode" IN ('deterministic', 'explore_bounded')
    );

ALTER TABLE "RoutingRun"
    ADD CONSTRAINT "RoutingRun_allocationSeedGrain_check"
    CHECK (
        "allocationSeedGrain" IS NULL
        OR "allocationSeedGrain" IN ('request', 'session')
    );

-- Which combinations of the two are a record of something.
--
-- Both null is a run from before the allocator. `deterministic` rolled
-- nothing, so there was no seed to name. `explore_bounded` must name its
-- grain: an exploration whose seed went unrecorded cannot be replayed, and
-- nothing can say afterwards whether it was moving conversations off the
-- placements holding their prefixes.
--
-- One constraint rather than two so that a grain without a mode is refused as
-- well. A grain alone would be a seed for a choice nobody recorded.
ALTER TABLE "RoutingRun"
    ADD CONSTRAINT "RoutingRun_allocation_axis_check"
    CHECK (
        ("allocationMode" IS NULL AND "allocationSeedGrain" IS NULL)
        OR ("allocationMode" = 'deterministic' AND "allocationSeedGrain" IS NULL)
        OR ("allocationMode" = 'explore_bounded' AND "allocationSeedGrain" IS NOT NULL)
    );

-- Counting exploration rate scans by mode over a window. Partial, because the
-- rows that matter are the ones that recorded an allocation and, until the
-- allocator ships, that is none of them.
CREATE INDEX "RoutingRun_allocationMode_createdAt_idx"
    ON "RoutingRun"("allocationMode", "createdAt")
    WHERE "allocationMode" IS NOT NULL;
