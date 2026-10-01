-- AMUX v4 non-runnable hierarchy and card metadata, phase B. This migration
-- adds nullable fields to existing cards but updates no row and opens no writer.
-- The legacy executionBrief pair remains unchanged. v4 encrypted brief and
-- title columns are separate so retention cannot silently erase legacy data.

BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE "AmuxWorkItem" IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM "AmuxWorkItem" WHERE "sourceSystem" = 'admin-idea-v4') THEN
        RAISE EXCEPTION 'pre-existing admin-idea-v4 rows; phase B requires none';
    END IF;
END $$;

CREATE TABLE "AmuxPortfolioNode" (
    "id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "parentId" TEXT,
    "state" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "titleCiphertext" BYTEA,
    "descriptionCiphertext" BYTEA,
    "contentKeyId" TEXT,
    "contentKeyVersion" INTEGER,
    "contentDigest" TEXT NOT NULL,
    "contentDigestKeyId" TEXT NOT NULL,
    "approvedByUserId" TEXT NOT NULL,
    "authorizationAuditLogId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxPortfolioNode_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxPortfolioNode_level_check" CHECK (
        "level" IN ('initiative', 'epic', 'feature')
    ),
    CONSTRAINT "AmuxPortfolioNode_state_check" CHECK (
        "state" IN ('active', 'archived')
    ),
    CONSTRAINT "AmuxPortfolioNode_parent_shape_check" CHECK (
        ("level" = 'initiative' AND "parentId" IS NULL) OR
        ("level" IN ('epic', 'feature') AND "parentId" IS NOT NULL)
    ),
    CONSTRAINT "AmuxPortfolioNode_revision_check" CHECK ("revision" >= 0),
    CONSTRAINT "AmuxPortfolioNode_content_key_check" CHECK (
        "titleCiphertext" IS NOT NULL AND "contentKeyId" IS NOT NULL AND
        length("contentKeyId") > 0 AND "contentKeyVersion" IS NOT NULL AND "contentKeyVersion" > 0
    ),
    CONSTRAINT "AmuxPortfolioNode_digest_check" CHECK (
        "contentDigest" ~ '^[a-f0-9]{64}$' AND length("contentDigestKeyId") > 0
    )
);

CREATE UNIQUE INDEX "AmuxPortfolioNode_authorizationAuditLogId_key"
    ON "AmuxPortfolioNode"("authorizationAuditLogId");
CREATE INDEX "AmuxPortfolioNode_parentId_level_state_idx"
    ON "AmuxPortfolioNode"("parentId", "level", "state");
CREATE INDEX "AmuxPortfolioNode_level_state_createdAt_idx"
    ON "AmuxPortfolioNode"("level", "state", "createdAt");

ALTER TABLE "AmuxPortfolioNode"
    ADD CONSTRAINT "AmuxPortfolioNode_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "AmuxPortfolioNode"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION amux_portfolio_parent_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    parent_level text;
    parent_state text;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW."id" IS DISTINCT FROM OLD."id" OR
           NEW."level" IS DISTINCT FROM OLD."level" OR
           NEW."parentId" IS DISTINCT FROM OLD."parentId" OR
           NEW."revision" IS DISTINCT FROM OLD."revision" OR
           NEW."titleCiphertext" IS DISTINCT FROM OLD."titleCiphertext" OR
           NEW."descriptionCiphertext" IS DISTINCT FROM OLD."descriptionCiphertext" OR
           NEW."contentKeyId" IS DISTINCT FROM OLD."contentKeyId" OR
           NEW."contentKeyVersion" IS DISTINCT FROM OLD."contentKeyVersion" OR
           NEW."contentDigest" IS DISTINCT FROM OLD."contentDigest" OR
           NEW."contentDigestKeyId" IS DISTINCT FROM OLD."contentDigestKeyId" OR
           NEW."approvedByUserId" IS DISTINCT FROM OLD."approvedByUserId" OR
           NEW."authorizationAuditLogId" IS DISTINCT FROM OLD."authorizationAuditLogId" OR
           NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
            RAISE EXCEPTION 'portfolio content and identity revision path is closed';
        END IF;
        IF OLD."state" = 'archived' AND NEW."state" = 'active' THEN
            RAISE EXCEPTION 'portfolio reactivation requires a separately approved revision path';
        END IF;
        IF NEW."state" = 'archived' AND OLD."state" <> 'archived' THEN
            IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
                RAISE EXCEPTION 'portfolio archive requires read committed isolation';
            END IF;
            IF EXISTS (SELECT 1 FROM public."AmuxPortfolioNode" child WHERE child."parentId" = NEW."id" AND child."state" = 'active') THEN
                RAISE EXCEPTION 'active child prevents portfolio node archive';
            END IF;
            IF NEW."level" = 'feature' AND EXISTS (
                SELECT 1 FROM public."AmuxWorkItem" card
                WHERE card."parentFeatureNodeId" = NEW."id" AND card."status" NOT IN ('done', 'cancelled')
            ) THEN
                RAISE EXCEPTION 'active cards prevent feature archive';
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."level" = 'initiative' THEN
        IF NEW."parentId" IS NOT NULL THEN
            RAISE EXCEPTION 'initiative cannot have a parent';
        END IF;
        RETURN NEW;
    END IF;

    SELECT "level", "state" INTO parent_level, parent_state
    FROM public."AmuxPortfolioNode" WHERE "id" = NEW."parentId" FOR SHARE;

    IF NEW."level" = 'epic' AND (parent_level IS DISTINCT FROM 'initiative' OR parent_state IS DISTINCT FROM 'active') THEN
        RAISE EXCEPTION 'epic requires an active initiative parent';
    END IF;
    IF NEW."level" = 'feature' AND (parent_level IS DISTINCT FROM 'epic' OR parent_state IS DISTINCT FROM 'active') THEN
        RAISE EXCEPTION 'feature requires an active epic parent';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxPortfolioNode_parent_guard"
BEFORE INSERT OR UPDATE ON "AmuxPortfolioNode"
FOR EACH ROW EXECUTE FUNCTION amux_portfolio_parent_guard();

CREATE TABLE "AmuxPortfolioNodeRevision" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "priorRevision" INTEGER,
    "parentIdAtApproval" TEXT,
    "contentDigest" TEXT NOT NULL,
    "contentDigestKeyId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "authorizationAuditLogId" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxPortfolioNodeRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxPortfolioNodeRevision_revision_check" CHECK (
        "revision" >= 0 AND ("priorRevision" IS NULL OR "priorRevision" < "revision")
    ),
    CONSTRAINT "AmuxPortfolioNodeRevision_digest_check" CHECK (
        "contentDigest" ~ '^[a-f0-9]{64}$' AND length("contentDigestKeyId") > 0
    )
);

CREATE UNIQUE INDEX "AmuxPortfolioNodeRevision_nodeId_revision_key"
    ON "AmuxPortfolioNodeRevision"("nodeId", "revision");
CREATE UNIQUE INDEX "AmuxPortfolioNodeRevision_authorizationAuditLogId_key"
    ON "AmuxPortfolioNodeRevision"("authorizationAuditLogId");
CREATE INDEX "AmuxPortfolioNodeRevision_decisionId_idx"
    ON "AmuxPortfolioNodeRevision"("decisionId");

ALTER TABLE "AmuxPortfolioNodeRevision"
    ADD CONSTRAINT "AmuxPortfolioNodeRevision_nodeId_fkey"
    FOREIGN KEY ("nodeId") REFERENCES "AmuxPortfolioNode"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION amux_portfolio_revision_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    RAISE EXCEPTION 'portfolio revisions are append-only';
END;
$$;

CREATE TRIGGER "AmuxPortfolioNodeRevision_reject_update"
BEFORE UPDATE ON "AmuxPortfolioNodeRevision"
FOR EACH ROW EXECUTE FUNCTION amux_portfolio_revision_append_only();

CREATE TRIGGER "AmuxPortfolioNodeRevision_reject_delete"
BEFORE DELETE ON "AmuxPortfolioNodeRevision"
FOR EACH ROW EXECUTE FUNCTION amux_portfolio_revision_append_only();

CREATE TRIGGER "AmuxPortfolioNodeRevision_reject_truncate"
BEFORE TRUNCATE ON "AmuxPortfolioNodeRevision"
FOR EACH STATEMENT EXECUTE FUNCTION amux_portfolio_revision_append_only();

CREATE FUNCTION amux_portfolio_node_reject_delete()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    RAISE EXCEPTION 'portfolio nodes require archival, not deletion';
END;
$$;

CREATE TRIGGER "AmuxPortfolioNode_reject_delete"
BEFORE DELETE ON "AmuxPortfolioNode"
FOR EACH ROW EXECUTE FUNCTION amux_portfolio_node_reject_delete();

CREATE TRIGGER "AmuxPortfolioNode_reject_truncate"
BEFORE TRUNCATE ON "AmuxPortfolioNode"
FOR EACH STATEMENT EXECUTE FUNCTION amux_portfolio_node_reject_delete();

ALTER TABLE "AmuxWorkItem"
    ADD COLUMN "cardType" TEXT,
    ADD COLUMN "parentFeatureNodeId" TEXT,
    ADD COLUMN "parentStoryCardId" TEXT,
    ADD COLUMN "v4TitleCiphertext" BYTEA,
    ADD COLUMN "v4TitleKeyId" TEXT,
    ADD COLUMN "v4TitleKeyVersion" INTEGER,
    ADD COLUMN "v4TitleDigest" TEXT,
    ADD COLUMN "v4TitleDigestKeyId" TEXT,
    ADD COLUMN "v4BriefCiphertext" BYTEA,
    ADD COLUMN "v4BriefKeyId" TEXT,
    ADD COLUMN "v4BriefKeyVersion" INTEGER,
    ADD COLUMN "v4BriefDigest" TEXT,
    ADD COLUMN "v4BriefDigestKeyId" TEXT,
    ADD COLUMN "v4BriefPurgedAt" TIMESTAMP(3),
    ADD COLUMN "v4TerminalAt" TIMESTAMP(3),
    ADD COLUMN "v4SourceApprovalId" TEXT,
    ADD COLUMN "v22ReceiptId" TEXT,
    ADD COLUMN "taskRole" TEXT,
    ADD COLUMN "executionGrade" TEXT;

ALTER TABLE "AmuxWorkItem"
    ADD CONSTRAINT "AmuxWorkItem_parentFeatureNodeId_fkey"
    FOREIGN KEY ("parentFeatureNodeId") REFERENCES "AmuxPortfolioNode"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
    ADD CONSTRAINT "AmuxWorkItem_parentStoryCardId_fkey"
    FOREIGN KEY ("parentStoryCardId") REFERENCES "AmuxWorkItem"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
    ADD CONSTRAINT "AmuxWorkItem_v4_columns_exclusive_check"
    CHECK (
        "sourceSystem" IS NOT DISTINCT FROM 'admin-idea-v4' OR
        (
            "cardType" IS NULL AND "parentFeatureNodeId" IS NULL AND "parentStoryCardId" IS NULL AND
            "v4TitleCiphertext" IS NULL AND "v4TitleKeyId" IS NULL AND "v4TitleKeyVersion" IS NULL AND
            "v4TitleDigest" IS NULL AND "v4TitleDigestKeyId" IS NULL AND
            "v4BriefCiphertext" IS NULL AND "v4BriefKeyId" IS NULL AND "v4BriefKeyVersion" IS NULL AND
            "v4BriefDigest" IS NULL AND "v4BriefDigestKeyId" IS NULL AND "v4BriefPurgedAt" IS NULL AND
            "v4TerminalAt" IS NULL AND "v4SourceApprovalId" IS NULL AND "v22ReceiptId" IS NULL AND
            "taskRole" IS NULL AND "executionGrade" IS NULL
        )
    ) NOT VALID,
    ADD CONSTRAINT "AmuxWorkItem_v4_phase_b_inert_check"
    CHECK (
        "sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
        ("status" IN ('backlog', 'blocked', 'cancelled') AND "owner" IS NULL AND "claimedAt" IS NULL)
    ) NOT VALID,
    ADD CONSTRAINT "AmuxWorkItem_v4_card_type_check"
    CHECK ("sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR ("cardType" IS NOT NULL AND "cardType" IN ('story', 'task'))) NOT VALID,
    ADD CONSTRAINT "AmuxWorkItem_v4_plaintext_exclusion_check"
    CHECK (
        "sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
        ("description" IS NULL AND "classification" IS NULL AND "dueRaw" IS NULL AND
         "reviewSpecialty" IS NULL AND "executionBrief" IS NULL AND "executionBriefDigest" IS NULL AND
         "projectKey" IS NULL AND "teamKey" IS NULL AND "dueSource" IS NULL AND "requiredRoutingRole" IS NULL)
    ) NOT VALID,
    ADD CONSTRAINT "AmuxWorkItem_v4_source_snapshot_shape_check"
    CHECK (
        "sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
        COALESCE((
            "sourceSnapshot" IS NOT NULL AND jsonb_typeof("sourceSnapshot") = 'object' AND
            "sourceSnapshot" ?& ARRAY['schemaVersion', 'ideaId', 'approvalId'] AND
            ("sourceSnapshot" - 'schemaVersion' - 'ideaId' - 'approvalId') = '{}'::jsonb AND
            jsonb_typeof("sourceSnapshot"->'schemaVersion') = 'string' AND
            jsonb_typeof("sourceSnapshot"->'ideaId') = 'string' AND
            jsonb_typeof("sourceSnapshot"->'approvalId') = 'string' AND
            "sourceSnapshot"->>'schemaVersion' = 'amux-v4' AND
            "sourceSnapshot"->>'ideaId' ~ '^[A-Za-z0-9_-]{8,80}$' AND
            "sourceSnapshot"->>'approvalId' ~ '^[A-Za-z0-9_-]{8,80}$'
        ), false)
    ) NOT VALID,
    ADD CONSTRAINT "AmuxWorkItem_v4_story_unowned_check"
    CHECK (
        "sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR "cardType" IS DISTINCT FROM 'story' OR
        ("status" NOT IN ('todo', 'doing', 'review') AND "owner" IS NULL AND "claimedAt" IS NULL AND "parentStoryCardId" IS NULL)
    ) NOT VALID,
    ADD CONSTRAINT "AmuxWorkItem_v4_brief_digest_check"
    CHECK (
        "sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR "cardType" IS DISTINCT FROM 'task' OR
        ("v4BriefDigest" IS NOT NULL AND "v4BriefDigest" ~ '^[a-f0-9]{64}$' AND
         "v4BriefDigestKeyId" IS NOT NULL AND length("v4BriefDigestKeyId") > 0)
    ) NOT VALID,
    ADD CONSTRAINT "AmuxWorkItem_v4_title_digest_check"
    CHECK (
        "sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
        ("v4TitleDigest" IS NOT NULL AND "v4TitleDigest" ~ '^[a-f0-9]{64}$' AND
         "v4TitleDigestKeyId" IS NOT NULL AND length("v4TitleDigestKeyId") > 0)
    ) NOT VALID,
    ADD CONSTRAINT "AmuxWorkItem_v4_key_pair_check"
    CHECK (
        "sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
        (
            "v4TitleCiphertext" IS NOT NULL AND "v4TitleKeyId" IS NOT NULL AND length("v4TitleKeyId") > 0 AND
            "v4TitleKeyVersion" IS NOT NULL AND "v4TitleKeyVersion" > 0 AND
            (
                ("cardType" = 'story' AND "v4BriefCiphertext" IS NULL AND "v4BriefKeyId" IS NULL AND "v4BriefKeyVersion" IS NULL AND "v4BriefDigest" IS NULL AND "v4BriefDigestKeyId" IS NULL AND "v4BriefPurgedAt" IS NULL) OR
                ("cardType" = 'task' AND (
                    ("v4BriefPurgedAt" IS NULL AND "v4BriefCiphertext" IS NOT NULL AND "v4BriefKeyId" IS NOT NULL AND length("v4BriefKeyId") > 0 AND "v4BriefKeyVersion" IS NOT NULL AND "v4BriefKeyVersion" > 0) OR
                    ("v4BriefPurgedAt" IS NOT NULL AND "v4BriefCiphertext" IS NULL AND "v4BriefKeyId" IS NULL AND "v4BriefKeyVersion" IS NULL AND "status" IN ('done', 'cancelled') AND "v4TerminalAt" IS NOT NULL)
                ))
            )
        )
    ) NOT VALID,
    ADD CONSTRAINT "AmuxWorkItem_v4_registration_shape_check"
    CHECK (
        "sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR
        (
            "parentFeatureNodeId" IS NOT NULL AND "v4SourceApprovalId" IS NOT NULL AND
            (("cardType" = 'story' AND "title" IS NOT DISTINCT FROM 'AMUX Story' AND "taskRole" IS NULL AND "executionGrade" IS NULL) OR
             ("cardType" = 'task' AND "title" IS NOT DISTINCT FROM 'AMUX Task' AND "taskRole" IS NOT NULL AND "executionGrade" IS NOT NULL))
        )
    ) NOT VALID,
    ADD CONSTRAINT "AmuxWorkItem_v4_terminal_time_check"
    CHECK (
        "sourceSystem" IS DISTINCT FROM 'admin-idea-v4' OR "v4TerminalAt" IS NULL OR "status" IN ('done', 'cancelled')
    ) NOT VALID,
    ADD CONSTRAINT "AmuxWorkItem_v4_parent_story_not_self_check"
    CHECK ("parentStoryCardId" IS DISTINCT FROM "id") NOT VALID;

-- The current catalog is small, and phase B already takes an ACCESS EXCLUSIVE
-- metadata lock. Build the indexes atomically in this migration; do not rely
-- on runner-specific CREATE INDEX CONCURRENTLY transaction behavior.
CREATE UNIQUE INDEX "AmuxWorkItem_v22ReceiptId_key"
    ON "AmuxWorkItem"("v22ReceiptId");
CREATE INDEX "AmuxWorkItem_parentFeatureNodeId_status_idx"
    ON "AmuxWorkItem"("parentFeatureNodeId", "status");
CREATE INDEX "AmuxWorkItem_parentStoryCardId_status_idx"
    ON "AmuxWorkItem"("parentStoryCardId", "status");

-- Parent type, same-Feature, approval and receipt binding require cross-row
-- checks added in later protected migrations before any v4 writer opens.
-- The existing sourced-todo CHECK still rejects v4 encrypted-brief Todo.
-- It is deliberately NOT changed here: the transition remains fail-closed.

COMMIT;
