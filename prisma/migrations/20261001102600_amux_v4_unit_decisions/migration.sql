-- AMUX v4 owner decision ledger, additive and dark. It does not enable an
-- idea writer, card registration, promotion, worker claim, or model call.
-- Existing v1-v3 approval rows are not reused or changed.

BEGIN;

CREATE UNIQUE INDEX "AmuxIdeaDraftUnit_id_ideaId_actorUserId_chunkIndex_key"
    ON "AmuxIdeaDraftUnit"("id", "ideaId", "actorUserId", "chunkIndex");

CREATE TABLE "AmuxIdeaUnitDecision" (
    "id" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "draftUnitId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "prepareRequestId" UUID NOT NULL,
    "consumeRequestId" UUID,
    "action" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "ownerSessionDigest" TEXT NOT NULL,
    "ownerSessionDigestKeyId" TEXT NOT NULL,
    "unitDigest" TEXT NOT NULL,
    "unitDigestKeyId" TEXT NOT NULL,
    "confirmationDigest" TEXT NOT NULL,
    "confirmationDigestKeyId" TEXT NOT NULL,
    "sourcePreviewId" TEXT NOT NULL,
    "sourcePreviewDigest" TEXT NOT NULL,
    "sourcePreviewDigestKeyId" TEXT NOT NULL,
    "baseNodeId" TEXT,
    "baseNodeRevision" INTEGER,
    "baseNodeDigest" TEXT,
    "baseNodeDigestKeyId" TEXT,
    "baseWorkItemId" TEXT,
    "baseWorkItemRevision" INTEGER,
    "baseWorkItemDigest" TEXT,
    "baseWorkItemDigestKeyId" TEXT,
    "resolvedNodeId" TEXT,
    "registeredWorkItemId" TEXT,
    "linkedNodeId" TEXT,
    "linkedWorkItemId" TEXT,
    "preparedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "outcomeUnknownAt" TIMESTAMP(3),
    "outcomeUnknownConsumeRequestId" UUID,
    "outcomeUnknownAuditLogId" TEXT,
    "outcomeUnknownResolvedAt" TIMESTAMP(3),
    "outcomeUnknownResolution" TEXT,
    "outcomeUnknownResolvedAuditLogId" TEXT,
    "prepareAuditLogId" TEXT NOT NULL,
    "finalAuditLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxIdeaUnitDecision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxIdeaUnitDecision_action_check" CHECK (
        "action" IN ('create_node', 'select_existing_node', 'register_card',
                     'link_existing_card', 'link_existing_node', 'reject_unit')
    ),
    CONSTRAINT "AmuxIdeaUnitDecision_state_check" CHECK (
        "state" IN ('prepared', 'consumed', 'cancelled', 'invalidated', 'expired')
    ),
    CONSTRAINT "AmuxIdeaUnitDecision_chunk_index_check" CHECK ("chunkIndex" >= 0),
    CONSTRAINT "AmuxIdeaUnitDecision_digest_check" CHECK (
        "ownerSessionDigest" ~ '^[a-f0-9]{64}$' AND length("ownerSessionDigestKeyId") > 0 AND
        "unitDigest" ~ '^[a-f0-9]{64}$' AND length("unitDigestKeyId") > 0 AND
        "confirmationDigest" ~ '^[a-f0-9]{64}$' AND length("confirmationDigestKeyId") > 0 AND
        "sourcePreviewDigest" ~ '^[a-f0-9]{64}$' AND length("sourcePreviewDigestKeyId") > 0
    ),
    CONSTRAINT "AmuxIdeaUnitDecision_base_node_shape_check" CHECK (
        ("baseNodeId" IS NULL AND "baseNodeRevision" IS NULL AND
         "baseNodeDigest" IS NULL AND "baseNodeDigestKeyId" IS NULL) OR
        ("baseNodeId" IS NOT NULL AND "baseNodeRevision" IS NOT NULL AND "baseNodeRevision" >= 0 AND
         "baseNodeDigest" IS NOT NULL AND "baseNodeDigest" ~ '^[a-f0-9]{64}$' AND
         "baseNodeDigestKeyId" IS NOT NULL AND length("baseNodeDigestKeyId") > 0)
    ),
    CONSTRAINT "AmuxIdeaUnitDecision_base_card_shape_check" CHECK (
        ("baseWorkItemId" IS NULL AND "baseWorkItemRevision" IS NULL AND
         "baseWorkItemDigest" IS NULL AND "baseWorkItemDigestKeyId" IS NULL) OR
        ("baseWorkItemId" IS NOT NULL AND "baseWorkItemRevision" IS NOT NULL AND "baseWorkItemRevision" >= 0 AND
         "baseWorkItemDigest" IS NOT NULL AND "baseWorkItemDigest" ~ '^[a-f0-9]{64}$' AND
         "baseWorkItemDigestKeyId" IS NOT NULL AND length("baseWorkItemDigestKeyId") > 0)
    ),
    CONSTRAINT "AmuxIdeaUnitDecision_clock_check" CHECK (
        "expiresAt" = "preparedAt" + INTERVAL '15 minutes' AND
        (("state" = 'prepared' AND "consumedAt" IS NULL AND "consumeRequestId" IS NULL AND "finalAuditLogId" IS NULL) OR
         ("state" = 'consumed' AND "consumedAt" IS NOT NULL AND "consumedAt" >= "preparedAt" AND
          "consumedAt" < "expiresAt" AND "consumeRequestId" IS NOT NULL AND "finalAuditLogId" IS NOT NULL) OR
         ("state" IN ('cancelled', 'invalidated', 'expired') AND "consumedAt" IS NULL AND
          "consumeRequestId" IS NULL AND "finalAuditLogId" IS NOT NULL))
    ),
    CONSTRAINT "AmuxIdeaUnitDecision_unknown_clock_check" CHECK (
        ("outcomeUnknownAt" IS NULL AND "outcomeUnknownConsumeRequestId" IS NULL AND
         "outcomeUnknownAuditLogId" IS NULL AND "outcomeUnknownResolvedAt" IS NULL AND
         "outcomeUnknownResolution" IS NULL AND "outcomeUnknownResolvedAuditLogId" IS NULL) OR
        ("outcomeUnknownAt" IS NOT NULL AND "outcomeUnknownConsumeRequestId" IS NOT NULL AND
         "outcomeUnknownAuditLogId" IS NOT NULL AND
         (("outcomeUnknownResolvedAt" IS NULL AND "outcomeUnknownResolution" IS NULL AND
           "outcomeUnknownResolvedAuditLogId" IS NULL AND "state" = 'prepared') OR
          ("outcomeUnknownResolvedAt" IS NOT NULL AND
           "outcomeUnknownResolvedAt" >= "outcomeUnknownAt" AND
           "outcomeUnknownResolution" = 'no_commit' AND
           "outcomeUnknownResolvedAuditLogId" IS NOT NULL)))
    ),
    CONSTRAINT "AmuxIdeaUnitDecision_audit_distinct_check" CHECK (
        ("finalAuditLogId" IS NULL OR "prepareAuditLogId" <> "finalAuditLogId") AND
        ("outcomeUnknownAuditLogId" IS NULL OR
         ("prepareAuditLogId" <> "outcomeUnknownAuditLogId" AND
          ("finalAuditLogId" IS NULL OR "finalAuditLogId" <> "outcomeUnknownAuditLogId"))) AND
        ("outcomeUnknownResolvedAuditLogId" IS NULL OR
         ("prepareAuditLogId" <> "outcomeUnknownResolvedAuditLogId" AND
          ("finalAuditLogId" IS NULL OR "finalAuditLogId" <> "outcomeUnknownResolvedAuditLogId") AND
          ("outcomeUnknownAuditLogId" IS NULL OR
           "outcomeUnknownAuditLogId" <> "outcomeUnknownResolvedAuditLogId")))
    ),
    CONSTRAINT "AmuxIdeaUnitDecision_request_distinct_check" CHECK (
        ("consumeRequestId" IS NULL OR "consumeRequestId" <> "prepareRequestId") AND
        ("outcomeUnknownConsumeRequestId" IS NULL OR
         ("outcomeUnknownConsumeRequestId" <> "prepareRequestId" AND
          ("consumeRequestId" IS NULL OR "outcomeUnknownConsumeRequestId" <> "consumeRequestId")))
    ),
    CONSTRAINT "AmuxIdeaUnitDecision_action_base_check" CHECK (
        ("action" IN ('select_existing_node', 'link_existing_node', 'register_card') AND "baseNodeId" IS NOT NULL) OR
        ("action" = 'link_existing_card' AND "baseWorkItemId" IS NOT NULL) OR
        ("action" IN ('create_node', 'reject_unit'))
    ),
    CONSTRAINT "AmuxIdeaUnitDecision_result_shape_check" CHECK (
        ("state" <> 'consumed' AND "resolvedNodeId" IS NULL AND "registeredWorkItemId" IS NULL AND
         "linkedNodeId" IS NULL AND "linkedWorkItemId" IS NULL) OR
        ("state" = 'consumed' AND (
            ("action" = 'create_node' AND "resolvedNodeId" IS NOT NULL AND
             "registeredWorkItemId" IS NULL AND "linkedNodeId" IS NULL AND "linkedWorkItemId" IS NULL) OR
            ("action" IN ('select_existing_node', 'link_existing_node') AND
             "linkedNodeId" IS NOT NULL AND "linkedNodeId" = "baseNodeId" AND
             "resolvedNodeId" IS NULL AND "registeredWorkItemId" IS NULL AND "linkedWorkItemId" IS NULL) OR
            ("action" = 'register_card' AND "registeredWorkItemId" IS NOT NULL AND
             "resolvedNodeId" IS NULL AND "linkedNodeId" IS NULL AND "linkedWorkItemId" IS NULL) OR
            ("action" = 'link_existing_card' AND
             "linkedWorkItemId" IS NOT NULL AND "linkedWorkItemId" = "baseWorkItemId" AND
             "resolvedNodeId" IS NULL AND "registeredWorkItemId" IS NULL AND "linkedNodeId" IS NULL) OR
            ("action" = 'reject_unit' AND "resolvedNodeId" IS NULL AND
             "registeredWorkItemId" IS NULL AND "linkedNodeId" IS NULL AND "linkedWorkItemId" IS NULL)
        ))
    )
);

CREATE UNIQUE INDEX "AmuxIdeaUnitDecision_prepareRequestId_key"
    ON "AmuxIdeaUnitDecision"("prepareRequestId");
CREATE UNIQUE INDEX "AmuxIdeaUnitDecision_consumeRequestId_key"
    ON "AmuxIdeaUnitDecision"("consumeRequestId");
CREATE UNIQUE INDEX "AmuxIdeaUnitDecision_prepareAuditLogId_key"
    ON "AmuxIdeaUnitDecision"("prepareAuditLogId");
CREATE UNIQUE INDEX "AmuxIdeaUnitDecision_finalAuditLogId_key"
    ON "AmuxIdeaUnitDecision"("finalAuditLogId");
CREATE UNIQUE INDEX "AmuxIdeaUnitDecision_resolvedNodeId_key"
    ON "AmuxIdeaUnitDecision"("resolvedNodeId");
CREATE UNIQUE INDEX "AmuxIdeaUnitDecision_registeredWorkItemId_key"
    ON "AmuxIdeaUnitDecision"("registeredWorkItemId");
CREATE UNIQUE INDEX "AmuxIdeaUnitDecision_outcomeUnknownConsumeRequestId_key"
    ON "AmuxIdeaUnitDecision"("outcomeUnknownConsumeRequestId");
CREATE UNIQUE INDEX "AmuxIdeaUnitDecision_outcomeUnknownAuditLogId_key"
    ON "AmuxIdeaUnitDecision"("outcomeUnknownAuditLogId");
CREATE UNIQUE INDEX "AmuxIdeaUnitDecision_outcomeUnknownResolvedAuditLogId_key"
    ON "AmuxIdeaUnitDecision"("outcomeUnknownResolvedAuditLogId");
CREATE UNIQUE INDEX "AmuxIdeaUnitDecision_one_prepared_per_unit"
    ON "AmuxIdeaUnitDecision"("draftUnitId") WHERE "state" = 'prepared';
CREATE UNIQUE INDEX "AmuxIdeaUnitDecision_one_consumed_per_unit"
    ON "AmuxIdeaUnitDecision"("draftUnitId") WHERE "state" = 'consumed';
CREATE INDEX "AmuxIdeaUnitDecision_ideaId_state_expiresAt_idx"
    ON "AmuxIdeaUnitDecision"("ideaId", "state", "expiresAt");
CREATE INDEX "AmuxIdeaUnitDecision_draftUnitId_state_idx"
    ON "AmuxIdeaUnitDecision"("draftUnitId", "state");
CREATE INDEX "AmuxIdeaUnitDecision_sourcePreviewId_idx"
    ON "AmuxIdeaUnitDecision"("sourcePreviewId");

ALTER TABLE "AmuxIdeaUnitDecision"
    ADD CONSTRAINT "AmuxIdeaUnitDecision_ideaId_actorUserId_fkey"
    FOREIGN KEY ("ideaId", "actorUserId") REFERENCES "AmuxIdeaSubmission"("id", "actorUserId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "AmuxIdeaUnitDecision_draftUnitId_ideaId_actorUserId_chunkI_fkey"
    FOREIGN KEY ("draftUnitId", "ideaId", "actorUserId", "chunkIndex")
    REFERENCES "AmuxIdeaDraftUnit"("id", "ideaId", "actorUserId", "chunkIndex")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "AmuxIdeaUnitDecision_sourcePreviewId_ideaId_chunkIndex_fkey"
    FOREIGN KEY ("sourcePreviewId", "ideaId", "chunkIndex")
    REFERENCES "AmuxIdeaTransferPreview"("id", "ideaId", "chunkIndex")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "AmuxIdeaUnitDecision_prepareAuditLogId_fkey"
    FOREIGN KEY ("prepareAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "AmuxIdeaUnitDecision_finalAuditLogId_fkey"
    FOREIGN KEY ("finalAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "AmuxIdeaUnitDecision_outcomeUnknownAuditLogId_fkey"
    FOREIGN KEY ("outcomeUnknownAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "AmuxIdeaUnitDecision_outcomeUnknownResolvedAuditLogId_fkey"
    FOREIGN KEY ("outcomeUnknownResolvedAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AmuxIdeaUnitDecision"
    ADD CONSTRAINT "AmuxIdeaUnitDecision_baseNodeId_fkey"
    FOREIGN KEY ("baseNodeId") REFERENCES "AmuxPortfolioNode"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "AmuxIdeaUnitDecision_resolvedNodeId_fkey"
    FOREIGN KEY ("resolvedNodeId") REFERENCES "AmuxPortfolioNode"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "AmuxIdeaUnitDecision_linkedNodeId_fkey"
    FOREIGN KEY ("linkedNodeId") REFERENCES "AmuxPortfolioNode"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "AmuxIdeaUnitDecision_baseWorkItemId_fkey"
    FOREIGN KEY ("baseWorkItemId") REFERENCES "AmuxWorkItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "AmuxIdeaUnitDecision_registeredWorkItemId_fkey"
    FOREIGN KEY ("registeredWorkItemId") REFERENCES "AmuxWorkItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "AmuxIdeaUnitDecision_linkedWorkItemId_fkey"
    FOREIGN KEY ("linkedWorkItemId") REFERENCES "AmuxWorkItem"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The initial receipt is never a consumed decision. The row can only move
-- forward once; unknown outcome freezes it until an explicit read-back marks
-- it resolved. This trigger is not an authorization grant to a live writer.
CREATE FUNCTION amux_v4_unit_source_matches(decision public."AmuxIdeaUnitDecision")
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    unit_state text;
    unit_kind text;
    unit_digest text;
    unit_key_id text;
    unit_expires_at timestamp(3);
    preview_state text;
    preview_digest text;
    preview_key_id text;
    current_preview_id text;
BEGIN
    SELECT u."state", u."unitKind", u."bodyDigest", u."bodyDigestKeyId", u."expiresAt",
           p."state", p."payloadDigest", p."payloadDigestKeyId", c."currentPreviewId"
      INTO unit_state, unit_kind, unit_digest, unit_key_id, unit_expires_at,
           preview_state, preview_digest, preview_key_id, current_preview_id
      FROM public."AmuxIdeaDraftUnit" u
      JOIN public."AmuxIdeaAnalysisChunk" c
        ON c."ideaId" = u."ideaId" AND c."chunkIndex" = u."chunkIndex"
      JOIN public."AmuxIdeaTransferPreview" p
        ON p."id" = decision."sourcePreviewId" AND p."ideaId" = u."ideaId" AND
           p."chunkIndex" = u."chunkIndex"
     WHERE u."id" = decision."draftUnitId" AND u."ideaId" = decision."ideaId" AND
           u."actorUserId" = decision."actorUserId" AND u."chunkIndex" = decision."chunkIndex"
     FOR SHARE OF u, c, p;
    RETURN unit_state = 'proposed' AND unit_expires_at > (clock_timestamp() AT TIME ZONE 'UTC') AND
           unit_digest = decision."unitDigest" AND unit_key_id = decision."unitDigestKeyId" AND
           preview_state = 'completed' AND current_preview_id = decision."sourcePreviewId" AND
           preview_digest = decision."sourcePreviewDigest" AND
           preview_key_id = decision."sourcePreviewDigestKeyId" AND
           ((unit_kind = 'node' AND decision."action" IN
             ('create_node', 'select_existing_node', 'link_existing_node', 'reject_unit')) OR
            (unit_kind = 'card' AND decision."action" IN
             ('register_card', 'link_existing_card', 'reject_unit')));
END;
$$;

CREATE FUNCTION amux_v4_unit_audit_matches(
    audit_id text, decision_id text, actor_id text,
    expected_action text, expected_system_actor text
) RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    audit_action text;
    audit_target_type text;
    audit_target_id text;
    audit_actor_id text;
    audit_entry_hash text;
    audit_system_actor text;
BEGIN
    SELECT a."action", a."targetType", a."targetId", a."actorUserId",
           a."entryHash", a."metadata"->>'systemActor'
      INTO audit_action, audit_target_type, audit_target_id, audit_actor_id,
           audit_entry_hash, audit_system_actor
      FROM public."AdminAuditLog" a WHERE a."id" = audit_id FOR SHARE;
    RETURN audit_action = expected_action AND audit_target_type = 'AmuxIdeaUnitDecision' AND
           audit_target_id = decision_id AND audit_entry_hash ~ '^[a-f0-9]{64}$' AND
           ((expected_system_actor IS NULL AND audit_actor_id = actor_id AND audit_system_actor IS NULL) OR
            (expected_system_actor IS NOT NULL AND audit_actor_id IS NULL AND
             audit_system_actor = expected_system_actor));
END;
$$;

CREATE FUNCTION amux_v4_unit_decision_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    db_now timestamp(3) := clock_timestamp() AT TIME ZONE 'UTC';
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'unit decision deletion is forbidden'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_no_delete_check';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW."state" <> 'prepared' OR NEW."consumeRequestId" IS NOT NULL OR
           NEW."finalAuditLogId" IS NOT NULL OR NEW."outcomeUnknownAt" IS NOT NULL OR
           NEW."outcomeUnknownConsumeRequestId" IS NOT NULL OR
           NEW."outcomeUnknownAuditLogId" IS NOT NULL OR
           NEW."outcomeUnknownResolvedAt" IS NOT NULL OR
           NEW."outcomeUnknownResolution" IS NOT NULL OR
           NEW."outcomeUnknownResolvedAuditLogId" IS NOT NULL THEN
            RAISE EXCEPTION 'decision must begin prepared'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_initial_state_check';
        END IF;
        IF amux_v4_unit_source_matches(NEW) IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION 'decision source is unavailable or mismatched'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_unit_binding_check';
        END IF;
        IF EXISTS (SELECT 1 FROM public."AmuxIdeaUnitDecision" d
                   WHERE d."draftUnitId" = NEW."draftUnitId" AND d."state" = 'consumed') THEN
            RAISE EXCEPTION 'unit has already been decided'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_already_consumed_check';
        END IF;
        IF amux_v4_unit_audit_matches(NEW."prepareAuditLogId", NEW."id", NEW."actorUserId",
              'amux.v4.unit.prepare', NULL) IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION 'prepare audit is unavailable or mismatched'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_prepare_audit_check';
        END IF;
        NEW."preparedAt" := db_now;
        NEW."expiresAt" := db_now + INTERVAL '15 minutes';
        RETURN NEW;
    END IF;

    IF OLD."state" <> 'prepared' THEN
        RAISE EXCEPTION 'terminal decision cannot be changed'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_terminal_immutable_check';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."ideaId" IS DISTINCT FROM OLD."ideaId" OR
       NEW."draftUnitId" IS DISTINCT FROM OLD."draftUnitId" OR NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId" OR
       NEW."chunkIndex" IS DISTINCT FROM OLD."chunkIndex" OR
       NEW."prepareRequestId" IS DISTINCT FROM OLD."prepareRequestId" OR
       NEW."action" IS DISTINCT FROM OLD."action" OR NEW."ownerSessionDigest" IS DISTINCT FROM OLD."ownerSessionDigest" OR
       NEW."ownerSessionDigestKeyId" IS DISTINCT FROM OLD."ownerSessionDigestKeyId" OR
       NEW."unitDigest" IS DISTINCT FROM OLD."unitDigest" OR NEW."unitDigestKeyId" IS DISTINCT FROM OLD."unitDigestKeyId" OR
       NEW."confirmationDigest" IS DISTINCT FROM OLD."confirmationDigest" OR
       NEW."confirmationDigestKeyId" IS DISTINCT FROM OLD."confirmationDigestKeyId" OR
       NEW."sourcePreviewId" IS DISTINCT FROM OLD."sourcePreviewId" OR
       NEW."sourcePreviewDigest" IS DISTINCT FROM OLD."sourcePreviewDigest" OR
       NEW."sourcePreviewDigestKeyId" IS DISTINCT FROM OLD."sourcePreviewDigestKeyId" OR
       NEW."baseNodeId" IS DISTINCT FROM OLD."baseNodeId" OR NEW."baseNodeRevision" IS DISTINCT FROM OLD."baseNodeRevision" OR
       NEW."baseNodeDigest" IS DISTINCT FROM OLD."baseNodeDigest" OR
       NEW."baseNodeDigestKeyId" IS DISTINCT FROM OLD."baseNodeDigestKeyId" OR
       NEW."baseWorkItemId" IS DISTINCT FROM OLD."baseWorkItemId" OR
       NEW."baseWorkItemRevision" IS DISTINCT FROM OLD."baseWorkItemRevision" OR
       NEW."baseWorkItemDigest" IS DISTINCT FROM OLD."baseWorkItemDigest" OR
       NEW."baseWorkItemDigestKeyId" IS DISTINCT FROM OLD."baseWorkItemDigestKeyId" OR
       NEW."prepareAuditLogId" IS DISTINCT FROM OLD."prepareAuditLogId" OR
       NEW."preparedAt" IS DISTINCT FROM OLD."preparedAt" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR
       NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'prepared confirmation snapshot is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_snapshot_immutable_check';
    END IF;
    IF NEW."outcomeUnknownAt" IS DISTINCT FROM OLD."outcomeUnknownAt" THEN
        IF OLD."outcomeUnknownAt" IS NOT NULL OR NEW."outcomeUnknownAt" IS NULL OR
           NEW."outcomeUnknownConsumeRequestId" IS NULL OR NEW."outcomeUnknownAuditLogId" IS NULL THEN
            RAISE EXCEPTION 'unknown outcome observation is immutable'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_unknown_immutable_check';
        END IF;
        IF amux_v4_unit_audit_matches(NEW."outcomeUnknownAuditLogId", NEW."id", NEW."actorUserId",
              'amux.v4.unit.outcome_unknown', 'tomverse-amux-orchestrator') IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION 'unknown outcome audit is unavailable or mismatched'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_unknown_audit_check';
        END IF;
        NEW."outcomeUnknownAt" := db_now;
    END IF;
    IF OLD."outcomeUnknownAt" IS NOT NULL AND
       (NEW."outcomeUnknownConsumeRequestId" IS DISTINCT FROM OLD."outcomeUnknownConsumeRequestId" OR
        NEW."outcomeUnknownAuditLogId" IS DISTINCT FROM OLD."outcomeUnknownAuditLogId") THEN
        RAISE EXCEPTION 'unknown attempt identity is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_unknown_immutable_check';
    END IF;
    IF NEW."outcomeUnknownResolvedAt" IS DISTINCT FROM OLD."outcomeUnknownResolvedAt" THEN
        IF OLD."outcomeUnknownAt" IS NULL OR OLD."outcomeUnknownResolvedAt" IS NOT NULL OR
           NEW."outcomeUnknownResolvedAt" IS NULL OR
           NEW."outcomeUnknownResolution" IS DISTINCT FROM 'no_commit' OR
           NEW."outcomeUnknownResolvedAuditLogId" IS NULL THEN
            RAISE EXCEPTION 'unknown outcome resolution is invalid'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_unknown_resolution_check';
        END IF;
        IF EXISTS (SELECT 1 FROM public."AmuxWorkItem" w
                   WHERE w."v4SourceApprovalId" = NEW."id") OR
           EXISTS (SELECT 1 FROM public."AmuxPortfolioNodeRevision" r
                   WHERE r."decisionId" = NEW."id") THEN
            RAISE EXCEPTION 'an applied effect cannot be resolved as no-commit'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_unknown_effect_check';
        END IF;
        IF amux_v4_unit_audit_matches(NEW."outcomeUnknownResolvedAuditLogId", NEW."id", NEW."actorUserId",
              'amux.v4.unit.no_commit_confirmed', NULL) IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION 'unknown outcome resolution audit is unavailable or mismatched'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_unknown_resolution_audit_check';
        END IF;
        NEW."outcomeUnknownResolvedAt" := db_now;
    END IF;
    IF OLD."outcomeUnknownResolvedAt" IS NOT NULL AND
       (NEW."outcomeUnknownResolution" IS DISTINCT FROM OLD."outcomeUnknownResolution" OR
        NEW."outcomeUnknownResolvedAuditLogId" IS DISTINCT FROM OLD."outcomeUnknownResolvedAuditLogId") THEN
        RAISE EXCEPTION 'unknown outcome resolution is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_unknown_resolution_check';
    END IF;
    IF OLD."outcomeUnknownAt" IS NOT NULL AND OLD."outcomeUnknownResolvedAt" IS NULL AND
       NEW."state" IS DISTINCT FROM OLD."state" THEN
        RAISE EXCEPTION 'unknown outcome blocks decision consumption'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_unknown_freeze_check';
    END IF;
    IF NEW."state" = 'consumed' THEN
        IF db_now >= OLD."expiresAt" OR NEW."consumeRequestId" IS NULL OR NEW."finalAuditLogId" IS NULL OR
           OLD."outcomeUnknownResolvedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'consumption is expired or unconfirmed'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_consume_boundary_check';
        END IF;
        IF amux_v4_unit_source_matches(NEW) IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION 'source changed after approval'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_consume_source_check';
        END IF;
        IF amux_v4_unit_audit_matches(NEW."finalAuditLogId", NEW."id", NEW."actorUserId",
              'amux.v4.unit.consume', NULL) IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION 'consume audit is unavailable or mismatched'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_final_audit_check';
        END IF;
        IF NEW."action" = 'register_card' AND NOT EXISTS (
            SELECT 1 FROM public."AmuxWorkItem" w WHERE w."id" = NEW."registeredWorkItemId" AND
                w."sourceSystem" = 'admin-idea-v4' AND w."v4SourceApprovalId" = NEW."id"
        ) THEN
            RAISE EXCEPTION 'registered card is not bound to this decision'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_card_result_check';
        END IF;
        IF NEW."action" = 'create_node' AND NOT EXISTS (
            SELECT 1 FROM public."AmuxPortfolioNodeRevision" r
             WHERE r."nodeId" = NEW."resolvedNodeId" AND r."decisionId" = NEW."id"
        ) THEN
            RAISE EXCEPTION 'created node is not bound to this decision'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_node_result_check';
        END IF;
        NEW."consumedAt" := db_now;
    ELSIF NEW."state" = 'expired' THEN
        IF db_now < OLD."expiresAt" OR NEW."finalAuditLogId" IS NULL THEN
            RAISE EXCEPTION 'expiry is early or unaudited'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_expiry_boundary_check';
        END IF;
        IF amux_v4_unit_audit_matches(NEW."finalAuditLogId", NEW."id", NEW."actorUserId",
              'amux.v4.unit.expire', 'tomverse-amux-orchestrator') IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION 'expiry audit is unavailable or mismatched'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_final_audit_check';
        END IF;
    ELSIF NEW."state" IN ('cancelled', 'invalidated') THEN
        IF NEW."finalAuditLogId" IS NULL THEN
            RAISE EXCEPTION 'closure must be audited'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_closure_audit_check';
        END IF;
        IF amux_v4_unit_audit_matches(NEW."finalAuditLogId", NEW."id", NEW."actorUserId",
              CASE NEW."state" WHEN 'cancelled' THEN 'amux.v4.unit.cancel' ELSE 'amux.v4.unit.invalidate' END,
              CASE NEW."state" WHEN 'cancelled' THEN NULL ELSE 'tomverse-amux-orchestrator' END)
              IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION 'closure audit is unavailable or mismatched'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_final_audit_check';
        END IF;
    ELSIF NEW."state" <> 'prepared' THEN
        RAISE EXCEPTION 'decision transition is invalid'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_transition_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaUnitDecision_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "AmuxIdeaUnitDecision"
FOR EACH ROW EXECUTE FUNCTION amux_v4_unit_decision_guard();

CREATE FUNCTION amux_v4_unit_decision_no_truncate()
RETURNS trigger LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public, pg_temp
SET row_security = off AS $$
BEGIN
    -- A fixed transaction snapshot can miss a row committed before TRUNCATE
    -- acquires ACCESS EXCLUSIVE. Only READ COMMITTED may use the empty-table
    -- exception; this VOLATILE trigger query takes a fresh snapshot after
    -- the table lock. row_security=off errors rather than hiding rows.
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'unit decision truncation requires a fresh snapshot'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_no_truncate_check';
    END IF;
    -- Unrelated test-fixture TRUNCATE ... CASCADE includes this dark empty
    -- table. It loses no evidence while empty; a populated table is immutable.
    IF EXISTS (SELECT 1 FROM public."AmuxIdeaUnitDecision" LIMIT 1) THEN
        RAISE EXCEPTION 'unit decision truncation is forbidden'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaUnitDecision_no_truncate_check';
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "AmuxIdeaUnitDecision_no_truncate"
BEFORE TRUNCATE ON "AmuxIdeaUnitDecision"
FOR EACH STATEMENT EXECUTE FUNCTION amux_v4_unit_decision_no_truncate();

COMMIT;
