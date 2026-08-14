-- How a manifest's hash can be checked later, and why the detail went.
--
-- Expand-only and nullable. Manifests written before this carry no
-- provenance, which is the truth about them: they were digested with a key
-- that has no id, under a scheme nothing recorded.

ALTER TABLE "ContextManifest" ADD COLUMN "contentHashVersion" TEXT;
ALTER TABLE "ContextManifest" ADD COLUMN "hashAlgorithm" TEXT;
ALTER TABLE "ContextManifest" ADD COLUMN "hashKeyId" TEXT;
ALTER TABLE "ContextManifest" ADD COLUMN "compactionReason" TEXT;

-- A hash with no key id is a commitment nobody can verify once the key that
-- made it has rotated, so a finalized manifest must carry all three or none.
-- None is only reachable for rows written before this migration; the
-- application refuses to finalize without them.
ALTER TABLE "ContextManifest"
    ADD CONSTRAINT "ContextManifest_hash_provenance_pair_check"
    CHECK (
        (
            "contentHashVersion" IS NULL
            AND "hashAlgorithm" IS NULL
            AND "hashKeyId" IS NULL
        )
        OR (
            "contentHashVersion" IS NOT NULL
            AND "hashAlgorithm" IS NOT NULL
            AND "hashKeyId" IS NOT NULL
        )
    );

-- Why the detail went. `aged` is the retention sweep; the other two are
-- privacy transitions that outrank the retention window entirely
-- (routing policy §5: "user deletion and memory deletion/supersession always
-- take priority over audit retention").
--
-- Account deletion is deliberately not a value here. It removes the row
-- through the cascade rather than compacting it, so there is no compacted
-- manifest left to carry the reason -- and a value nothing can produce would
-- be a category in a report that is always zero for a reason nobody could
-- work out from the data.
ALTER TABLE "ContextManifest"
    ADD CONSTRAINT "ContextManifest_compactionReason_check"
    CHECK (
        "compactionReason" IS NULL
        OR "compactionReason" IN ('aged', 'memory_deleted', 'memory_superseded')
    );

-- Compacted and its reason travel together: a compaction with no reason is a
-- record nobody can audit, and a reason with nothing compacted is a claim
-- about an event that did not happen.
ALTER TABLE "ContextManifest"
    ADD CONSTRAINT "ContextManifest_compaction_reason_pair_check"
    CHECK (
        ("compactedAt" IS NULL AND "compactionReason" IS NULL)
        OR ("compactedAt" IS NOT NULL AND "compactionReason" IS NOT NULL)
    );

-- The compaction door, widened by exactly one column and no more.
--
-- Same reasoning as when it was cut: a finalized manifest is the record of
-- what reached a provider and ROUTE-06 rests on it being uneditable. The
-- retention transition may now also set `compactionReason`, because a
-- compaction that cannot say why it happened is not auditable. Everything
-- else -- the hash, its provenance, the counts, the versions, the lifecycle
-- -- must still be byte-for-byte what it was.
CREATE OR REPLACE FUNCTION "context_manifest_finalized_is_immutable"()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD."finalizedAt" IS NOT NULL THEN
        IF NOT (
            OLD."compactedAt" IS NULL
            AND NEW."compactedAt" IS NOT NULL
            AND NEW."compactionReason" IS NOT NULL
            AND NEW."sourceRefs" = '[]'::jsonb
            AND NEW."inclusionRange" IS NULL
            AND NEW."truncationPoints" IS NULL
            AND NEW."summaryVersion" IS NULL
            AND NEW."id" = OLD."id"
            AND NEW."attemptId" = OLD."attemptId"
            AND NEW."userId" IS NOT DISTINCT FROM OLD."userId"
            AND NEW."state" = OLD."state"
            AND NEW."tokenizerVersion" = OLD."tokenizerVersion"
            AND NEW."tokenCount" = OLD."tokenCount"
            AND NEW."contextWindowTokens" = OLD."contextWindowTokens"
            AND NEW."plannerVersion" IS NOT DISTINCT FROM OLD."plannerVersion"
            AND NEW."templateVersion" IS NOT DISTINCT FROM OLD."templateVersion"
            AND NEW."adapterVersion" IS NOT DISTINCT FROM OLD."adapterVersion"
            AND NEW."structuredOptionsHash" IS NOT DISTINCT FROM OLD."structuredOptionsHash"
            AND NEW."effectiveRequestHash" IS NOT DISTINCT FROM OLD."effectiveRequestHash"
            AND NEW."contentHashVersion" IS NOT DISTINCT FROM OLD."contentHashVersion"
            AND NEW."hashAlgorithm" IS NOT DISTINCT FROM OLD."hashAlgorithm"
            AND NEW."hashKeyId" IS NOT DISTINCT FROM OLD."hashKeyId"
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

    IF NEW."attemptId" IS DISTINCT FROM OLD."attemptId" THEN
        RAISE EXCEPTION
            'ContextManifest % cannot be moved to another attempt', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- `summaryVersion` joins the columns compaction clears. It names the summary
-- template a truncated conversation was condensed with, which is a fact about
-- how the user's own text was reduced -- the same category as the source
-- references, not the same category as the tokenizer version.
ALTER TABLE "ContextManifest"
    DROP CONSTRAINT "ContextManifest_compacted_has_no_detail_check";

ALTER TABLE "ContextManifest"
    ADD CONSTRAINT "ContextManifest_compacted_has_no_detail_check"
    CHECK (
        "compactedAt" IS NULL
        OR (
            "sourceRefs" = '[]'::jsonb
            AND "inclusionRange" IS NULL
            AND "truncationPoints" IS NULL
            AND "summaryVersion" IS NULL
        )
    );
