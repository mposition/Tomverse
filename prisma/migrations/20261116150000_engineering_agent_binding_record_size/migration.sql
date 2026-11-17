-- Owner decision 2026-11-16 (conversation): one generous size for the
-- engineering agent binding's records instead of the 2026-09-28 caps -- a
-- 4 KiB snapshot holding at most 100 invalidated review ids, and 1 KiB
-- approval and merge observations. The GitHub reads now page through every
-- review (lib/engineeringAgentGitHubRead.ts), so a pull request with more than
-- 100 reviews could no longer be bound. Each record is still a JSON object of
-- exact keys, digests, enums, review ids and instants -- no free text and no
-- person -- and now at most 1 MiB; the review id count has no bound of its
-- own. Nothing else in the three CHECKs changes. No row changes.
--
-- Rollback: drop and add the three constraints again with 4096 and the 100
-- id bound, and 1024 (only possible while no row exceeds them).
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
            AND jsonb_typeof("snapshot"->'diffDigest') = 'string' AND "snapshot"->>'diffDigest' ~ '^[0-9a-f]{64}$'
            AND jsonb_typeof("snapshot"->'treeId') = 'string' AND "snapshot"->>'treeId' ~ '^[0-9a-f]{40}$'
            AND jsonb_typeof("snapshot"->'invalidatedReviewIds') = 'array'
            AND NOT jsonb_path_exists(
                "snapshot", '$.invalidatedReviewIds[*] ? (@.type() != "number" || @ < 1 || @.floor() != @)')
        ),
    DROP CONSTRAINT "EngineeringAgentBinding_approvalObservation_check",
    ADD CONSTRAINT "EngineeringAgentBinding_approvalObservation_check"
        CHECK (
            "approvalObservation" IS NULL OR (
                jsonb_typeof("approvalObservation") = 'object'
                AND octet_length("approvalObservation"::text) <= 1048576
                AND jsonb_typeof("approvalObservation"->'observedAt') = 'string'
                AND "approvalObservation"->>'observedAt'
                    ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$'
                AND (
                    (
                        "approvalObservation"->>'verdict' = 'approved'
                        AND "approvalObservation" ?& ARRAY['verdict', 'reviewId', 'reviewCommitId', 'submittedAt', 'observedAt']
                        AND "approvalObservation"
                            - ARRAY['verdict', 'reviewId', 'reviewCommitId', 'submittedAt', 'observedAt'] = '{}'::jsonb
                        AND jsonb_typeof("approvalObservation"->'reviewId') = 'number'
                        AND NOT jsonb_path_exists(
                            "approvalObservation", '$.reviewId ? (@ < 1 || @.floor() != @)')
                        AND jsonb_typeof("approvalObservation"->'reviewCommitId') = 'string'
                        AND "approvalObservation"->>'reviewCommitId' ~ '^[0-9a-f]{40}$'
                        AND jsonb_typeof("approvalObservation"->'submittedAt') = 'string'
                        AND "approvalObservation"->>'submittedAt'
                            ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$'
                    )
                    OR (
                        "approvalObservation"->>'verdict' = 'not_approved'
                        AND "approvalObservation" ?& ARRAY['verdict', 'reason', 'observedAt']
                        AND "approvalObservation" - ARRAY['verdict', 'reason', 'observedAt'] = '{}'::jsonb
                        -- reasons: ENGINEERING_AGENT_NOT_APPROVED_REASONS
                        AND "approvalObservation"->>'reason' IN (
                            'base_not_develop', 'head_not_verified', 'required_check_failed', 'no_authorised_review',
                            'review_not_valid', 'snapshot_changed', 'review_before_snapshot', 'merged_without_approval'
                        )
                    )
                )
            )
        ),
    DROP CONSTRAINT "EngineeringAgentBinding_mergeObservation_check",
    ADD CONSTRAINT "EngineeringAgentBinding_mergeObservation_check"
        CHECK (
            "mergeObservation" IS NULL OR (
                jsonb_typeof("mergeObservation") = 'object'
                AND octet_length("mergeObservation"::text) <= 1048576
                AND "mergeObservation" ?& ARRAY['merged', 'mergeCommitSha', 'mergedAt', 'mergedByKind', 'observedAt']
                AND "mergeObservation"
                    - ARRAY['merged', 'mergeCommitSha', 'mergedAt', 'mergedByKind', 'observedAt'] = '{}'::jsonb
                -- mergers: ENGINEERING_AGENT_MERGER_KINDS
                AND "mergeObservation"->>'mergedByKind' IN ('user', 'bot', 'app', 'unknown')
                AND jsonb_typeof("mergeObservation"->'observedAt') = 'string'
                AND "mergeObservation"->>'observedAt'
                    ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$'
                AND (
                    (
                        "mergeObservation"->'merged' = 'true'::jsonb
                        AND jsonb_typeof("mergeObservation"->'mergeCommitSha') = 'string'
                        AND "mergeObservation"->>'mergeCommitSha' ~ '^[0-9a-f]{40}$'
                        AND jsonb_typeof("mergeObservation"->'mergedAt') = 'string'
                        AND "mergeObservation"->>'mergedAt'
                            ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$'
                    )
                    OR (
                        "mergeObservation"->'merged' = 'false'::jsonb
                        AND jsonb_typeof("mergeObservation"->'mergeCommitSha') = 'null'
                        AND jsonb_typeof("mergeObservation"->'mergedAt') = 'null'
                    )
                )
            )
        );

COMMIT;
