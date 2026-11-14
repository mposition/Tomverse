// The figures of the AMUX process analysis agent (lib/amuxProcessAuditCore.ts):
// deterministic, read-only SQL over the AMUX and engineering tables for one
// window. Aggregates and card display keys only: no title, body, brief,
// e-mail or free text a person wrote. Every text column that is grouped
// (reasons, outcomes, routes, actions) passes only as a code-shaped value; a
// row holding anything else -- a worker's free text, for one -- is counted as
// `other_text`, so no stored text reaches the model's prompt
// (docs/policy/amux-agent-approval-contract.md §2). A module of reads only, apart from the
// store that writes the agent's own rows, so no write can sit beside a read of
// a protected table (scripts/check-protected-table-writers.mjs).

import "server-only";

import type { Prisma } from "@prisma/client";

type Db = Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Text of a JSON-safe number: a Postgres bigint or numeric comes back as BigInt or Decimal. */
const plain = <T>(rows: T): T =>
  JSON.parse(JSON.stringify(rows, (_key, value) => (typeof value === "bigint" ? Number(value) : value)));

export type AmuxProcessAuditMetrics = Record<string, unknown> & {
  readonly window: { readonly start: string; readonly end: string; readonly days: number };
};

/**
 * Every figure of one window. Timestamps are stored as UTC wall time
 * (timestamp(3) without zone), so the window goes in as instants and the
 * columns are compared as UTC; days are counted in Brisbane, the owner's
 * clock. No timestamp is read back: durations come out of SQL as hours.
 */
export async function readProcessAuditMetrics(db: Db, window: { start: Date; end: Date }): Promise<AmuxProcessAuditMetrics> {
  const s = window.start.toISOString();
  const e = window.end.toISOString();
  const tasks = await db.$queryRaw`
    SELECT count(*)::int AS created,
      count(*) FILTER (WHERE "status" = 'done')::int AS done,
      count(*) FILTER (WHERE "archivedAt" IS NOT NULL)::int AS archived,
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY
        EXTRACT(EPOCH FROM (COALESCE("v4TerminalAt", "updatedAt") - "createdAt")) / 3600)
        FILTER (WHERE "status" = 'done'))::numeric, 1)::float8 AS "doneMedianHours"
    FROM "AmuxWorkItem"
    WHERE "cardType" = 'task'
      AND "createdAt" >= (${s}::timestamptz AT TIME ZONE 'UTC')
      AND "createdAt" < (${e}::timestamptz AT TIME ZONE 'UTC')`;
  const liveByStatus = await db.$queryRaw`
    SELECT "status", count(*)::int AS count
    FROM "AmuxWorkItem"
    WHERE "cardType" = 'task' AND "archivedAt" IS NULL
    GROUP BY "status" ORDER BY "status"`;
  const backlogBlockers = await db.$queryRaw`
    SELECT
      count(DISTINCT t."id") FILTER (WHERE d."archivedAt" IS NOT NULL)::int AS "behindArchivedDependency",
      count(DISTINCT t."id") FILTER (WHERE d."archivedAt" IS NULL AND d."status" IN ('blocked', 'review'))::int AS "behindStoppedDependency"
    FROM "AmuxWorkItem" t
    JOIN "AmuxWorkDependency" x ON x."taskId" = t."id"
    JOIN "AmuxWorkItem" d ON d."id" = x."dependencyId"
    WHERE t."cardType" = 'task' AND t."archivedAt" IS NULL AND t."status" = 'backlog'`;
  // A todo that has spent the attempt budget is in no person's queue (the
  // 2026-11-14 report found one that sat 162 hours).
  const exhaustedTodo = await db.$queryRaw`
    SELECT COALESCE(t."displayKey", t."id") AS "card", count(a."id")::int AS attempts,
      round((EXTRACT(EPOCH FROM ((${e}::timestamptz AT TIME ZONE 'UTC') - max(a."startedAt"))) / 3600)::numeric, 1)::float8
        AS "hoursSinceLastAttempt"
    FROM "AmuxWorkItem" t
    JOIN "AmuxExecutionAttempt" a ON a."taskId" = t."id"
    WHERE t."cardType" = 'task' AND t."archivedAt" IS NULL AND t."status" = 'todo'
    GROUP BY t."id", t."displayKey"
    HAVING count(a."id") >= 5
    ORDER BY 3 DESC NULLS LAST
    LIMIT 10`;
  const attemptsPerDay = await db.$queryRaw`
    SELECT to_char(("startedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Australia/Brisbane', 'YYYY-MM-DD') AS day,
      count(*)::int AS attempts
    FROM "AmuxExecutionAttempt"
    WHERE "startedAt" >= (${s}::timestamptz AT TIME ZONE 'UTC')
      AND "startedAt" < (${e}::timestamptz AT TIME ZONE 'UTC')
    GROUP BY 1 ORDER BY 1`;
  // Why attempts ended, and how long until the same card ran again.
  const stopReasons = await db.$queryRaw`
    SELECT a."outcome", a."toStatus", CASE WHEN a."reason" IS NULL THEN NULL WHEN a."reason" ~ '^[a-z][a-z0-9_.:-]{0,79}$' THEN a."reason" ELSE 'other_text' END AS reason, count(*)::int AS count,
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (n."startedAt" - a."endedAt")) / 3600)
        FILTER (WHERE n."startedAt" IS NOT NULL))::numeric, 1)::float8 AS "medianHoursToNextAttempt",
      count(*) FILTER (WHERE n."startedAt" IS NULL)::int AS "noNextAttempt"
    FROM "AmuxExecutionAttempt" a
    LEFT JOIN LATERAL (
      SELECT b."startedAt" FROM "AmuxExecutionAttempt" b
      WHERE b."taskId" = a."taskId" AND b."startedAt" > a."endedAt"
      ORDER BY b."startedAt" LIMIT 1
    ) n ON true
    WHERE a."endedAt" >= (${s}::timestamptz AT TIME ZONE 'UTC')
      AND a."endedAt" < (${e}::timestamptz AT TIME ZONE 'UTC')
    GROUP BY 1, 2, 3
    ORDER BY count DESC
    LIMIT 40`;
  const escalations = await db.$queryRaw`
    SELECT CASE WHEN "reason" IS NULL THEN NULL WHEN "reason" ~ '^[a-z][a-z0-9_.:-]{0,79}$' THEN "reason" ELSE 'other_text' END AS reason, "status", CASE WHEN "resolutionOutcome" IS NULL THEN NULL WHEN "resolutionOutcome" ~ '^[a-z][a-z0-9_.:-]{0,79}$' THEN "resolutionOutcome" ELSE 'other_text' END AS "resolutionOutcome", count(*)::int AS count,
      -- A person resolves with their admin e-mail; the system resolvers have none. Counted, never read.
      count(*) FILTER (WHERE "resolvedAt" IS NOT NULL AND "resolvedByEmail" IS NOT NULL)::int AS "resolvedByPerson",
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("resolvedAt" - "createdAt")) / 3600)
        FILTER (WHERE "resolvedAt" IS NOT NULL))::numeric, 1)::float8 AS "medianHoursToResolve"
    FROM "AmuxHumanEscalation"
    WHERE "createdAt" >= (${s}::timestamptz AT TIME ZONE 'UTC')
      AND "createdAt" < (${e}::timestamptz AT TIME ZONE 'UTC')
    GROUP BY 1, 2, 3
    ORDER BY count DESC
    LIMIT 40`;
  const openEscalations = await db.$queryRaw`
    SELECT count(*)::int AS open,
      count(*) FILTER (WHERE w."archivedAt" IS NOT NULL)::int AS "onArchivedCards",
      count(*) FILTER (WHERE w."archivedAt" IS NULL AND w."status" IN ('review', 'blocked'))::int AS "onStoppedLiveCards"
    FROM "AmuxHumanEscalation" h
    JOIN "AmuxWorkItem" w ON w."id" = h."taskId"
    WHERE h."status" IN ('open', 'acknowledged')`;
  const v52Reviews = await db.$queryRaw`
    SELECT CASE WHEN "verdict" IS NULL THEN NULL WHEN "verdict" ~ '^[a-z][a-z0-9_.:-]{0,79}$' THEN "verdict" ELSE 'other_text' END AS verdict, count(*)::int AS count
    FROM "AmuxV52ReviewRecord"
    WHERE "createdAt" >= (${s}::timestamptz AT TIME ZONE 'UTC')
      AND "createdAt" < (${e}::timestamptz AT TIME ZONE 'UTC')
    GROUP BY 1 ORDER BY count DESC`;
  const resultReviews = await db.$queryRaw`
    SELECT CASE WHEN "kind" IS NULL THEN NULL WHEN "kind" ~ '^[a-z][a-z0-9_.:-]{0,79}$' THEN "kind" ELSE 'other_text' END AS kind, CASE WHEN "state" IS NULL THEN NULL WHEN "state" ~ '^[a-z][a-z0-9_.:-]{0,79}$' THEN "state" ELSE 'other_text' END AS state, CASE WHEN "answerSource" IS NULL THEN NULL WHEN "answerSource" ~ '^[a-z][a-z0-9_.:-]{0,79}$' THEN "answerSource" ELSE 'other_text' END AS "answerSource", count(*)::int AS count
    FROM "AmuxV22ResultReview"
    WHERE "createdAt" >= (${s}::timestamptz AT TIME ZONE 'UTC')
      AND "createdAt" < (${e}::timestamptz AT TIME ZONE 'UTC')
    GROUP BY 1, 2, 3 ORDER BY count DESC`;
  const decisionMakerRequests = await db.$queryRaw`
    SELECT CASE WHEN "route" IS NULL THEN NULL WHEN "route" ~ '^[a-z][a-z0-9_.:-]{0,79}$' THEN "route" ELSE 'other_text' END AS route, count(*)::int AS count
    FROM "AmuxDecisionMakerRequest"
    WHERE "createdAt" >= (${s}::timestamptz AT TIME ZONE 'UTC')
      AND "createdAt" < (${e}::timestamptz AT TIME ZONE 'UTC')
    GROUP BY 1 ORDER BY count DESC`;
  const engineeringRuns = await db.$queryRaw`
    SELECT CASE WHEN "status" IS NULL THEN NULL WHEN "status" ~ '^[a-z][a-z0-9_.:-]{0,79}$' THEN "status" ELSE 'other_text' END AS status, CASE WHEN "outcome" IS NULL THEN NULL WHEN "outcome" ~ '^[a-z][a-z0-9_.:-]{0,79}$' THEN "outcome" ELSE 'other_text' END AS outcome, count(*)::int AS count
    FROM "EngineeringAgentRun"
    WHERE "startedAt" >= (${s}::timestamptz AT TIME ZONE 'UTC')
      AND "startedAt" < (${e}::timestamptz AT TIME ZONE 'UTC')
    GROUP BY 1, 2 ORDER BY count DESC`;
  // What people did by hand on AMUX and the engineering agent. Action names
  // only: the actor is not named.
  const humanActions = await db.$queryRaw`
    SELECT CASE WHEN "action" IS NULL THEN NULL WHEN "action" ~ '^[a-z][a-z0-9_.:-]{0,79}$' THEN "action" ELSE 'other_text' END AS action, count(*)::int AS count
    FROM "AdminAuditLog"
    WHERE "actorUserId" IS NOT NULL
      AND ("action" LIKE 'amux.%' OR "action" LIKE 'engineering%' OR "action" LIKE 'ci_admission%' OR "action" LIKE 'qa_release%')
      AND "createdAt" >= (${s}::timestamptz AT TIME ZONE 'UTC')
      AND "createdAt" < (${e}::timestamptz AT TIME ZONE 'UTC')
    GROUP BY 1 ORDER BY count DESC LIMIT 25`;
  const humanActionsPerDay = await db.$queryRaw`
    SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Australia/Brisbane', 'YYYY-MM-DD') AS day,
      count(*)::int AS count
    FROM "AdminAuditLog"
    WHERE "actorUserId" IS NOT NULL
      AND ("action" LIKE 'amux.%' OR "action" LIKE 'engineering%' OR "action" LIKE 'ci_admission%' OR "action" LIKE 'qa_release%')
      AND "createdAt" >= (${s}::timestamptz AT TIME ZONE 'UTC')
      AND "createdAt" < (${e}::timestamptz AT TIME ZONE 'UTC')
    GROUP BY 1 ORDER BY 1`;
  const auditVolume = await db.$queryRaw`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE "actorUserId" IS NULL)::int AS system
    FROM "AdminAuditLog"
    WHERE "createdAt" >= (${s}::timestamptz AT TIME ZONE 'UTC')
      AND "createdAt" < (${e}::timestamptz AT TIME ZONE 'UTC')`;
  const auditTopActions = await db.$queryRaw`
    SELECT CASE WHEN "action" IS NULL THEN NULL WHEN "action" ~ '^[a-z][a-z0-9_.:-]{0,79}$' THEN "action" ELSE 'other_text' END AS action, count(*)::int AS count
    FROM "AdminAuditLog"
    WHERE "createdAt" >= (${s}::timestamptz AT TIME ZONE 'UTC')
      AND "createdAt" < (${e}::timestamptz AT TIME ZONE 'UTC')
    GROUP BY 1 ORDER BY count DESC LIMIT 10`;
  const days = Math.max(1, Math.round((window.end.getTime() - window.start.getTime()) / DAY_MS));
  return plain({
    window: { start: s, end: e, days },
    tasks: (tasks as unknown[])[0] ?? null,
    liveTasksByStatus: liveByStatus,
    backlogBlockers: (backlogBlockers as unknown[])[0] ?? null,
    exhaustedTodo,
    attemptsPerDay,
    stopReasons,
    escalations,
    openEscalations: (openEscalations as unknown[])[0] ?? null,
    v52Reviews,
    resultReviews,
    decisionMakerRequests,
    engineeringRuns,
    humanActions,
    humanActionsPerDay,
    auditVolume: (auditVolume as unknown[])[0] ?? null,
    auditTopActions,
  });
}
