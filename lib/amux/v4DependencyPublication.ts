import { Prisma } from "@prisma/client";

/** The audit entry the review merge observer writes when a v22 implement
 * Task's pull request was merged (lib/amux/reviewMergeObserved.ts). */
export const AMUX_V22_REVIEW_MERGE_OBSERVED_ACTION = "amux.v22.review.merge_observed";

/**
 * SQL condition on a dependency row (an `AmuxWorkItem` aliased `dep` by the
 * caller's query): its newest
 * attempt stored a patch and no recorded merge carries that attempt's patch
 * to develop -- neither the review merge observer's audit entry for that
 * attempt nor a merged engineering binding of that attempt's run. A dependency
 * done this way (AMUX-FILEGEN2-002, 2026-11-13: approved as "no change needed"
 * with its patch unpublished) leaves its dependents building on code develop
 * does not have. A dependency whose newest attempt stored no patch (an
 * investigation, a verification, a real no-change) is not matched, so it is
 * judged on done alone. Newest is the owner review's order: taskRevision,
 * startedAt, id, all descending. Readiness and the v22 candidate window read
 * this one condition, so they cannot drift apart.
 */
export const amuxDependencyUnpublishedPatchSql = () => Prisma.sql`EXISTS (
    SELECT 1 FROM (
      SELECT a."id" FROM "AmuxExecutionAttempt" a WHERE a."taskId" = dep."id"
      ORDER BY a."taskRevision" DESC, a."startedAt" DESC, a."id" DESC LIMIT 1
    ) newest
    JOIN "AmuxV22TaskPatch" p ON p."attemptId" = newest."id"
    WHERE NOT EXISTS (SELECT 1 FROM "AdminAuditLog" l
        WHERE l."targetType" = 'AmuxWorkItem' AND l."targetId" = dep."id"
          AND l."action" = ${AMUX_V22_REVIEW_MERGE_OBSERVED_ACTION}
          AND l."metadata"->>'attempt_id' = newest."id")
      AND NOT EXISTS (SELECT 1 FROM "EngineeringAgentRun" r
        JOIN "EngineeringAgentBinding" b ON b."runId" = r."id"
        WHERE r."amuxAttemptId" = newest."id"
          AND b."mergeObservation"->>'merged' = 'true'))`;
