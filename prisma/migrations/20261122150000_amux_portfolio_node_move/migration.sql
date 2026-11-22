-- Owner decision 2026-11-22: the owner may move an active Epic under another
-- active Initiative, or an active Feature under another active Epic, so ideas
-- that split one goal (AEO-01, AEO-02) can be brought under one hierarchy. A
-- move is a node revision of the same exact shape as a content revision
-- (20261121130000): the revision goes up by one, an append-only
-- AmuxPortfolioNodeRevision row records the new parent in parentIdAtApproval
-- with the same source decision, and the owner's own
-- amux.v4.portfolio.node.revise entry in the hash chain authorises it. The new
-- parent must be active and exactly one level up; an Initiative never moves.
-- Cards keep their Feature (AmuxWorkItem.parentFeatureNodeId stays closed).
-- baseline-check: replace-function-if-body-sha256 "amux_portfolio_parent_guard" "819340888161e53ac994d6227a6a5d6bedfe0a8d7e952d374f95c8974db10998" "39695f6063c7b25b72fe45c889bf29825bcdae6cf952e34838c03fc9824fe347"
CREATE OR REPLACE FUNCTION amux_portfolio_parent_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    parent_level text;
    parent_state text;
    content_revision boolean;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        content_revision := NEW."revision" = OLD."revision" + 1 AND
           OLD."state" = 'active' AND NEW."state" = 'active' AND
           NEW."titleCiphertext" IS NOT NULL AND
           NEW."descriptionCiphertext" IS NOT NULL AND
           NEW."contentKeyId" IS NOT NULL AND NEW."contentKeyVersion" IS NOT NULL AND
           NEW."authorizationAuditLogId" IS DISTINCT FROM OLD."authorizationAuditLogId" AND
           EXISTS (
             SELECT 1 FROM public."AmuxPortfolioNodeRevision" next_revision
             JOIN public."AmuxPortfolioNodeRevision" prior_revision
               ON prior_revision."nodeId" = OLD."id" AND
                  prior_revision."revision" = OLD."revision"
             WHERE next_revision."nodeId" = NEW."id" AND
               next_revision."revision" = NEW."revision" AND
               next_revision."priorRevision" = OLD."revision" AND
               next_revision."parentIdAtApproval" IS NOT DISTINCT FROM NEW."parentId" AND
               next_revision."contentDigest" = NEW."contentDigest" AND
               next_revision."contentDigestKeyId" = NEW."contentDigestKeyId" AND
               next_revision."authorizationAuditLogId" = NEW."authorizationAuditLogId" AND
               next_revision."decisionId" = prior_revision."decisionId") AND
           EXISTS (
             SELECT 1 FROM public."AdminAuditLog" audit
             WHERE audit."id" = NEW."authorizationAuditLogId" AND
               audit."action" = 'amux.v4.portfolio.node.revise' AND
               audit."targetType" = 'AmuxPortfolioNode' AND
               audit."targetId" = NEW."id" AND
               audit."actorUserId" = NEW."approvedByUserId" AND
               audit."entryHash" IS NOT NULL);
        IF NEW."id" IS DISTINCT FROM OLD."id" OR
           NEW."level" IS DISTINCT FROM OLD."level" OR
           (NEW."parentId" IS DISTINCT FROM OLD."parentId" AND
             (NOT content_revision OR NEW."level" = 'initiative')) OR
           NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
           (NOT content_revision AND (
           NEW."revision" IS DISTINCT FROM OLD."revision" OR
           NEW."titleCiphertext" IS DISTINCT FROM OLD."titleCiphertext" OR
           NEW."descriptionCiphertext" IS DISTINCT FROM OLD."descriptionCiphertext" OR
           NEW."contentKeyId" IS DISTINCT FROM OLD."contentKeyId" OR
           NEW."contentKeyVersion" IS DISTINCT FROM OLD."contentKeyVersion" OR
           NEW."contentDigest" IS DISTINCT FROM OLD."contentDigest" OR
           NEW."contentDigestKeyId" IS DISTINCT FROM OLD."contentDigestKeyId" OR
           NEW."approvedByUserId" IS DISTINCT FROM OLD."approvedByUserId" OR
           NEW."authorizationAuditLogId" IS DISTINCT FROM OLD."authorizationAuditLogId")) THEN
            RAISE EXCEPTION 'portfolio content and identity revision path is closed';
        END IF;
        IF NEW."parentId" IS DISTINCT FROM OLD."parentId" THEN
            SELECT "level", "state" INTO parent_level, parent_state
            FROM public."AmuxPortfolioNode" WHERE "id" = NEW."parentId" FOR SHARE;
            IF NEW."level" = 'epic' AND (parent_level IS DISTINCT FROM 'initiative' OR parent_state IS DISTINCT FROM 'active') THEN
                RAISE EXCEPTION 'epic requires an active initiative parent';
            END IF;
            IF NEW."level" = 'feature' AND (parent_level IS DISTINCT FROM 'epic' OR parent_state IS DISTINCT FROM 'active') THEN
                RAISE EXCEPTION 'feature requires an active epic parent';
            END IF;
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
