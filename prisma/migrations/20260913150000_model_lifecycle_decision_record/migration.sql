-- Structured operator decisions on the model lifecycle history.
--
-- The discovery queue records an operator's exclusion, reopen and adoption as
-- a decision with a chosen reason, the operator's own words and the automatic
-- analysis as it was shown -- in separate columns. Before this the panel wrote
-- the analysis sentence into `note`, so an automatic suggestion read back as
-- the reason a person gave.
--
-- Additive and nullable: existing events are steps or free-text notes and keep
-- every column they had. Nothing is backfilled -- an old note cannot be split
-- into analysis and reason after the fact.

ALTER TABLE "ModelLifecycleWorkItemEvent"
    ADD COLUMN "decision" TEXT,
    ADD COLUMN "reasonCode" TEXT,
    ADD COLUMN "operatorReason" TEXT,
    ADD COLUMN "analysisSnapshot" TEXT;

-- WORK_ITEM_EVENT_DECISIONS in lib/modelLifecycleWorkItemCore.ts.
ALTER TABLE "ModelLifecycleWorkItemEvent" ADD CONSTRAINT "ModelLifecycleWorkItemEvent_decision_check"
    CHECK ("decision" IS NULL OR "decision" IN ('adopt', 'exclude', 'reopen'));

-- WORK_ITEM_EXCLUSION_REASONS in lib/modelLifecycleWorkItemCore.ts.
ALTER TABLE "ModelLifecycleWorkItemEvent" ADD CONSTRAINT "ModelLifecycleWorkItemEvent_reasonCode_check"
    CHECK ("reasonCode" IS NULL OR "reasonCode" IN (
        'served_by_better_model', 'duplicate_alias', 'no_product_path',
        'insufficient_advantage', 'unstable_provider', 'other'
    ));

-- The shape each decision must have -- the same rules as
-- workItemDecisionRecordRefusal and transitionWorkItems -- so a caller that
-- bypasses them still cannot write an exclusion without a reason, a reason
-- without an exclusion, a reopen or adoption nobody explained, a blank or
-- oversized reason, or a decision on the wrong step.
ALTER TABLE "ModelLifecycleWorkItemEvent" ADD CONSTRAINT "ModelLifecycleWorkItemEvent_decision_shape_check"
    CHECK (
        ("decision" IS NOT DISTINCT FROM 'exclude') = ("reasonCode" IS NOT NULL)
        -- A decision names the person who made it; automation creates, never decides.
        AND ("decision" IS NULL OR btrim(coalesce("actorEmail", '')) <> '')
        AND ("operatorReason" IS NULL OR (btrim("operatorReason") <> '' AND char_length("operatorReason") <= 1000))
        AND ("decision" IS NOT NULL OR ("operatorReason" IS NULL AND "analysisSnapshot" IS NULL))
        -- An exclusion or adoption without the analysis it was made against is
        -- the half-record the snapshot column exists to prevent. A reopen has
        -- none: its reason is the operator's, and it acts on no analysis.
        AND ("decision" NOT IN ('exclude', 'adopt') OR "decision" IS NULL OR btrim(coalesce("analysisSnapshot", '')) <> '')
        AND ("decision" IS DISTINCT FROM 'reopen' OR "analysisSnapshot" IS NULL)
        AND ("reasonCode" IS DISTINCT FROM 'other' OR "operatorReason" IS NOT NULL)
        AND ("decision" IS DISTINCT FROM 'reopen' OR "operatorReason" IS NOT NULL)
        AND ("decision" IS DISTINCT FROM 'adopt' OR "operatorReason" IS NOT NULL)
        AND ("decision" IS DISTINCT FROM 'exclude' OR (
            "toStatus" = 'closed_no_action'
            AND "fromStatus" IN ('discovered', 'awaiting_decision', 'deferred')
        ))
        -- An adoption is its own record, written after the walk that reaches
        -- the registry: it names the state the item stands in, and moves nothing.
        AND ("decision" IS DISTINCT FROM 'adopt' OR (
            "fromStatus" IS NOT DISTINCT FROM "toStatus"
            AND "toStatus" IN ('validation_pending', 'rollout_pending', 'communication_pending')
        ))
        AND ("decision" IS DISTINCT FROM 'reopen' OR ("fromStatus" IS NOT DISTINCT FROM 'closed_no_action' AND "toStatus" = 'discovered'))
    );
