-- MANIFEST-02: aged manifests keep their aggregate and lose their detail.
--
-- Expand-only. Every existing manifest reads as never compacted, which is what
-- has happened: nothing has compacted anything until now.

ALTER TABLE "ContextManifest" ADD COLUMN "compactedAt" TIMESTAMP(3);

-- A compacted manifest may not still hold the detail it claims to have
-- dropped, and detail may not be dropped without saying so.
--
-- The second half is the one that matters. Without the marker a compacted
-- manifest would be indistinguishable from a dispatch whose request had no
-- source parts at all -- and §5 is explicit that a manifest must not be
-- misread as a different request than the one that reached the provider.
-- "This described nothing" and "this no longer says what it described" are
-- different claims, and only one of them is true here.
ALTER TABLE "ContextManifest"
    ADD CONSTRAINT "ContextManifest_compacted_has_no_detail_check"
    CHECK (
        "compactedAt" IS NULL
        OR (
            "sourceRefs" = '[]'::jsonb
            AND "inclusionRange" IS NULL
            AND "truncationPoints" IS NULL
        )
    );

-- The sweep looks for old rows that have not been compacted yet, so that is
-- the shape of the index. Partial, because a compacted row is never a
-- candidate again and there is no reason to carry it in the index that finds
-- work.
CREATE INDEX "ContextManifest_compaction_candidates_idx"
    ON "ContextManifest" ("createdAt")
    WHERE "compactedAt" IS NULL;

-- Compaction is the one modification a finalized manifest may undergo, and
-- letting it through must not open a door for anything else.
--
-- The trigger this replaces refused every update to a finalized row, which is
-- what ROUTE-06's boundary rests on: the record of what reached a provider
-- cannot be edited afterwards. Retention needs exactly one lossy transition
-- through that wall, so the wall gets a door of exactly that shape rather than
-- being lowered. Permitted on a finalized row: `compactedAt` goes from NULL to
-- a value, the three detail columns end up empty, and every other column is
-- byte-for-byte what it was. Anything else -- a different hash, a changed
-- token count, a second compaction, detail written back, a compacted row
-- returning to uncompacted -- still raises.
--
-- `updatedAt` is exempt because Prisma sets it on every write; it records when
-- the row was last touched, which is a fact about the row rather than a claim
-- about the request.
CREATE OR REPLACE FUNCTION "context_manifest_finalized_is_immutable"()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD."finalizedAt" IS NOT NULL THEN
        IF NOT (
            OLD."compactedAt" IS NULL
            AND NEW."compactedAt" IS NOT NULL
            AND NEW."sourceRefs" = '[]'::jsonb
            AND NEW."inclusionRange" IS NULL
            AND NEW."truncationPoints" IS NULL
            AND NEW."id" = OLD."id"
            AND NEW."attemptId" = OLD."attemptId"
            AND NEW."userId" IS NOT DISTINCT FROM OLD."userId"
            AND NEW."state" = OLD."state"
            AND NEW."summaryVersion" IS NOT DISTINCT FROM OLD."summaryVersion"
            AND NEW."tokenizerVersion" = OLD."tokenizerVersion"
            AND NEW."tokenCount" = OLD."tokenCount"
            AND NEW."contextWindowTokens" = OLD."contextWindowTokens"
            AND NEW."plannerVersion" IS NOT DISTINCT FROM OLD."plannerVersion"
            AND NEW."templateVersion" IS NOT DISTINCT FROM OLD."templateVersion"
            AND NEW."adapterVersion" IS NOT DISTINCT FROM OLD."adapterVersion"
            AND NEW."structuredOptionsHash" IS NOT DISTINCT FROM OLD."structuredOptionsHash"
            AND NEW."effectiveRequestHash" IS NOT DISTINCT FROM OLD."effectiveRequestHash"
            AND NEW."finalizedAt" = OLD."finalizedAt"
            AND NEW."notDispatchedReason" IS NOT DISTINCT FROM OLD."notDispatchedReason"
            AND NEW."createdAt" = OLD."createdAt"
        ) THEN
            RAISE EXCEPTION
                'ContextManifest % is finalized; only retention compaction may modify it', OLD."id"
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
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
