-- Owner decision 2026-11-18 (conversation, "v2로 바꾸기"): a pull request's
-- approval binds its merge base, head commit and head tree -- the v2 change
-- digest (lib/pullDiffDigestCore.ts), stored as `v2:` and 64 hex -- instead of
-- the SHA-256 of its diff. The three places an approval binding is kept take
-- either form: the engineering agent binding's snapshot, the Decision Maker's
-- approval of a review pull request, and AMUX review's approve proposal. A v1
-- value already stored stays as it is and is compared as v1. Nothing else in
-- the three CHECKs changes. No row changes.
--
-- Rollback: drop and add the three constraints again with '^[0-9a-f]{64}$'
-- (only possible while no row holds a v2 value).
BEGIN;

ALTER TABLE "EngineeringAgentBinding"
    DROP CONSTRAINT "EngineeringAgentBinding_snapshot_check",
    ADD CONSTRAINT "EngineeringAgentBinding_snapshot_check"
        CHECK (
            jsonb_typeof("snapshot") = 'object'
            AND octet_length("snapshot"::text) <= 1048576
            AND "snapshot" ?& ARRAY['baseSha', 'diffDigest', 'treeId', 'invalidatedReviewIds']
            AND "snapshot" - ARRAY['baseSha', 'diffDigest', 'treeId', 'invalidatedReviewIds'] = '{}'::jsonb
            AND jsonb_typeof("snapshot"->'baseSha') = 'string' AND "snapshot"->>'baseSha' ~ '^[0-9a-f]{40}$'
            AND jsonb_typeof("snapshot"->'diffDigest') = 'string' AND "snapshot"->>'diffDigest' ~ '^(v2:)?[0-9a-f]{64}$'
            AND jsonb_typeof("snapshot"->'treeId') = 'string' AND "snapshot"->>'treeId' ~ '^[0-9a-f]{40}$'
            AND jsonb_typeof("snapshot"->'invalidatedReviewIds') = 'array'
            AND NOT jsonb_path_exists(
                "snapshot", '$.invalidatedReviewIds[*] ? (@.type() != "number" || @ < 1 || @.floor() != @)')
        );

ALTER TABLE "AmuxDmOwnerSettlement"
    DROP CONSTRAINT "AmuxDmOwnerSettlement_shape_check",
    ADD CONSTRAINT "AmuxDmOwnerSettlement_shape_check" CHECK (
        "id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
        "kind" IN ('t2_pr', 'stopped') AND
        "taskStatus" IN ('review', 'blocked') AND
        (("kind" = 't2_pr') = ("bindingId" IS NOT NULL)) AND
        ("kind" <> 't2_pr' OR "attemptId" IS NOT NULL) AND
        ("bindingId" IS NULL OR "bindingId" ~ '^[A-Za-z0-9_-]{1,64}$') AND
        ("answerSource" IS NULL OR "answerSource" IN ('dm', 'dm_confirmed')) AND
        ("requestId" IS NULL OR "requestId" ~ '^[A-Za-z0-9_-]{1,64}$') AND
        ("approvedHeadSha" IS NULL OR "approvedHeadSha" ~ '^[0-9a-f]{40}$') AND
        ("approvedDiffDigest" IS NULL OR "approvedDiffDigest" ~ '^(v2:)?[0-9a-f]{64}$') AND
        (("approvedHeadSha" IS NULL) = ("approvedDiffDigest" IS NULL)) AND
        ("remakeRequestId" IS NULL OR
          "remakeRequestId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') AND
        ("remakeIdeaId" IS NULL OR "remakeIdeaId" ~ '^[A-Za-z0-9_-]{1,64}$') AND
        ("remakeIdeaId" IS NULL OR "remakeRequestId" IS NOT NULL) AND
        (("decision" = 'remake') = ("remakeRequestId" IS NOT NULL)) AND
        ("cancelReason" IS NULL OR "cancelReason" ~ '^[a-z_]{1,64}$') AND
        (("handoffReason" IS NULL) = ("handoffAt" IS NULL)) AND
        ("handoffReason" IS NULL OR "handoffReason" ~ '^[a-z_]{1,64}$') AND
        ("localCardId" IS NULL OR "localCardId" ~ '^[A-Za-z0-9_-]{1,64}$') AND
        ("localCardClosedAt" IS NULL OR ("localCardId" IS NOT NULL AND
          ("state" <> 'open' OR "handoffAt" IS NOT NULL)))
    );

ALTER TABLE "AmuxReviewProposal"
    DROP CONSTRAINT "AmuxReviewProposal_source_evidence_check",
    ADD CONSTRAINT "AmuxReviewProposal_source_evidence_check" CHECK (
      (
        "outcome" = 'approve'
        AND "reviewPrNumber" IS NOT NULL AND "reviewPrNumber" > 0
        AND "reviewBaseSha" IS NOT NULL
        AND "reviewBaseSha" ~ '^[0-9a-f]{40}$'
        AND "reviewHeadSha" IS NOT NULL
        AND "reviewHeadSha" ~ '^[0-9a-f]{40}$'
        AND "reviewDiffDigest" IS NOT NULL
        AND "reviewDiffDigest" ~ '^(v2:)?[0-9a-f]{64}$'
      ) OR (
        "outcome" = 'approve'
        AND "reviewPrNumber" IS NULL AND "reviewBaseSha" IS NULL
        AND "reviewHeadSha" IS NULL AND "reviewDiffDigest" IS NULL
      ) OR (
        "outcome" <> 'approve'
        AND "reviewPrNumber" IS NULL AND "reviewBaseSha" IS NULL
        AND "reviewHeadSha" IS NULL AND "reviewDiffDigest" IS NULL
      )
    );

COMMIT;
