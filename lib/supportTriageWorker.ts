/**
 * One support-triage worker pass, suggestions only (design section 5.2 steps
 * 1 to 5 and 5.3; groups and display promotion come later).
 *
 * A pass starts a `worker` run row, returns expired claims to pending (or
 * fails them after three attempts), then works in batches of 10 reports, at
 * most 50 per pass, while the remaining budget exceeds the worker lane's
 * guarded budget:
 *
 *   1. read candidates: reports awaiting an operator, not a deleted account's,
 *      that need work: an open suggestion of another input to supersede, a
 *      pending one of the current input, or no live or decided one for it
 *      (a hint; nothing is locked). A current input whose only rows are
 *      superseded or invalidated (the input came back, or the report
 *      reopened) is made again;
 *   2. claim transaction: lock those reports FOR SHARE in id order with the
 *      eligibility re-checked, recompute each input digest from the locked
 *      rows, supersede open suggestions of an older input, insert the new
 *      pending rows and claim the pending ones with this batch's token;
 *   3. compute the keyword flags and the lane outside any transaction;
 *   4. result transaction: lock the reports again with the eligibility
 *      re-checked and their input digest recomputed, and move to ready only
 *      rows still claimed with this batch's token (fencing) whose input is
 *      unchanged since the claim. Anything else is not written and is counted
 *      as stale; a changed input is picked up by the next pass.
 *
 * Every batch write set is set-based, one statement per step, so a batch
 * stays inside the lane's round-trip budget. Each transaction's last write
 * is the system audit entry and its last round trip the deadline check.
 * Nothing here retries. No report text, digest or id is logged or audited.
 */
import "server-only";

import { randomUUID } from "node:crypto";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import {
  DELETED_ACCOUNT_MARKER,
  GROUP_MEMBER_CAP,
  LANE_TIMEOUTS,
  SIGNAL_PROVENANCE,
  SUGGESTION_MAX_ATTEMPTS,
  SUGGESTION_STATES,
  SUGGESTION_TERMINAL_STATES,
  TRIAGE_ELIGIBLE_REPORT_STATUSES,
  WORKER_CLAIM_BATCH_SIZE,
  WORKER_PASS_MAX,
  WORKER_RECLAIM_MAX,
  maxGuardedBudgetMs,
  triageLaneFor,
  type GroupKind,
  type TriageLane,
} from "@/lib/supportTriageCore";
import { suggestionInputDigest } from "@/lib/supportTriageInputDigest";
import { keywordFlagsIn } from "@/lib/supportTriageKeywords";
import {
  GROUP_NEW_MEMBERSHIPS_PER_PASS_MAX,
  groupBinding,
  planGroups,
  type GroupFacts,
} from "@/lib/supportTriageGroupCore";
import { finishSupportTriageRun, startSupportTriageRun } from "@/lib/supportTriageRunStore";
import { armSupportTriageTransaction } from "@/lib/supportTriageTransaction";

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const ELIGIBLE = [...TRIAGE_ELIGIBLE_REPORT_STATUSES];
const OPEN_STATES = SUGGESTION_STATES.filter((state) => !SUGGESTION_TERMINAL_STATES.includes(state));

type ReportRow = {
  id: string;
  message: string;
  type: string;
  language: string;
  status: string;
  errorReportVerification: string | null;
  traceProvenance: string | null;
  errorClassificationSource: string | null;
  clientErrorCode: string | null;
  evidenceAvailability: string | null;
  traceEvidenceId: string | null;
  evErrorCode: string | null;
  evRouteClass: string | null;
  evRelease: string | null;
  evRetryable: boolean | null;
  evFailureLayer: string | null;
  caseState: string | null;
  caseClassification: string | null;
  userId: string | null;
  evOccurredAt: Date | null;
  caseFingerprint: string | null;
};

const digestOf = (row: ReportRow) =>
  suggestionInputDigest({
    report: {
      message: row.message,
      type: row.type,
      language: row.language,
      status: row.status,
      errorReportVerification: row.errorReportVerification,
      traceProvenance: row.traceProvenance,
      errorClassificationSource: row.errorClassificationSource,
      clientErrorCode: row.clientErrorCode,
      evidenceAvailability: row.evidenceAvailability,
      traceEvidenceId: row.traceEvidenceId,
    },
    evidence:
      row.evRouteClass === null
        ? null
        : {
            errorCode: row.evErrorCode,
            routeClass: row.evRouteClass,
            release: row.evRelease,
            retryable: row.evRetryable,
            failureLayer: row.evFailureLayer,
          },
    autoFixCase: row.caseState === null ? null : { state: row.caseState, classification: row.caseClassification },
  });

/** The eligible reports among `ids`, locked FOR SHARE in id order, with their evidence and case. */
const lockEligibleReports = (tx: Tx, ids: string[]) =>
  tx.$queryRaw<ReportRow[]>`
    SELECT f."id", f."message", f."type", f."language", f."status", f."errorReportVerification",
           f."traceProvenance", f."errorClassificationSource", f."clientErrorCode",
           f."evidenceAvailability", f."traceEvidenceId",
           e."errorCode" AS "evErrorCode", e."routeClass" AS "evRouteClass", e."release" AS "evRelease",
           e."retryable" AS "evRetryable", e."failureLayer" AS "evFailureLayer",
           c."state" AS "caseState", c."classification" AS "caseClassification",
           f."userId", e."occurredAt" AS "evOccurredAt", c."fingerprint" AS "caseFingerprint"
      FROM "Feedback" f
      LEFT JOIN "TraceErrorEvidence" e ON e."id" = f."traceEvidenceId"
      LEFT JOIN "FeedbackAutoFixCase" c ON c."feedbackId" = f."id"
     WHERE f."id" = ANY(${ids}::text[])
       AND f."status" = ANY(${ELIGIBLE}::text[])
       AND f."message" <> ${DELETED_ACCOUNT_MARKER}
     ORDER BY f."id"
       FOR SHARE OF f`;

const audit = (tx: Tx, runId: string, action: string, metadata: Record<string, number>) =>
  writeSystemAuditLog({
    tx,
    systemActor: "support-triage-worker",
    action,
    targetType: "SupportTriageRun",
    targetId: runId,
    summary: "Support-triage worker batch",
    metadata,
  });

const assertDeadline = (tx: Tx, deadlineAt: Date) =>
  tx.$executeRaw`SELECT "support_triage_assert_deadline"(${deadlineAt}::timestamp(3))`;

const transaction = <T>(fn: (tx: Tx) => Promise<T>) =>
  prisma.$transaction(fn, { timeout: LANE_TIMEOUTS.worker.prismaTransactionTimeoutMs });

/** Expired claims go back to pending, or fail after the last attempt. */
export const reclaimExpiredSuggestions = (run: { id: string; deadlineAt: Date }) =>
  transaction(async (tx) => {
    await armSupportTriageTransaction(tx, "worker");
    const reclaimed = await tx.$executeRaw`
      UPDATE "SupportTriageSuggestion" s SET "state" = 'pending'
       WHERE s."id" IN (
         SELECT x."id" FROM "SupportTriageSuggestion" x
          WHERE x."state" = 'claimed' AND x."leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
            AND x."attemptCount" < ${SUGGESTION_MAX_ATTEMPTS}::integer
          ORDER BY x."id" LIMIT ${WORKER_RECLAIM_MAX}::integer FOR UPDATE SKIP LOCKED)
         AND s."state" = 'claimed'`;
    const exhausted = await tx.$executeRaw`
      UPDATE "SupportTriageSuggestion" s SET "state" = 'failed', "failureCode" = 'retry_exhausted'
       WHERE s."id" IN (
         SELECT x."id" FROM "SupportTriageSuggestion" x
          WHERE x."state" = 'claimed' AND x."leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
            AND x."attemptCount" >= ${SUGGESTION_MAX_ATTEMPTS}::integer
          ORDER BY x."id" LIMIT ${WORKER_RECLAIM_MAX}::integer FOR UPDATE SKIP LOCKED)
         AND s."state" = 'claimed'`;
    if (reclaimed + exhausted > 0) {
      await audit(tx, run.id, "support_triage.worker_reclaim", { reclaimed, exhausted });
      await assertDeadline(tx, run.deadlineAt);
    }
    return { reclaimed, exhausted };
  });

/** States of a current-input row that settle the report: live or decided. */
const SETTLING_STATES = new Set(["claimed", "ready", "accepted", "rejected", "expired", "failed"]);

/** Up to `limit` eligible reports after `after` that need work (step 1). */
const readCandidates = async (after: string | null, limit: number) => {
  const reports = await prisma.$queryRaw<ReportRow[]>`
    SELECT f."id", f."message", f."type", f."language", f."status", f."errorReportVerification",
           f."traceProvenance", f."errorClassificationSource", f."clientErrorCode",
           f."evidenceAvailability", f."traceEvidenceId",
           e."errorCode" AS "evErrorCode", e."routeClass" AS "evRouteClass", e."release" AS "evRelease",
           e."retryable" AS "evRetryable", e."failureLayer" AS "evFailureLayer",
           c."state" AS "caseState", c."classification" AS "caseClassification",
           f."userId", e."occurredAt" AS "evOccurredAt", c."fingerprint" AS "caseFingerprint"
      FROM "Feedback" f
      LEFT JOIN "TraceErrorEvidence" e ON e."id" = f."traceEvidenceId"
      LEFT JOIN "FeedbackAutoFixCase" c ON c."feedbackId" = f."id"
     WHERE f."status" = ANY(${ELIGIBLE}::text[])
       AND f."message" <> ${DELETED_ACCOUNT_MARKER}
       AND (${after}::text IS NULL OR f."id" > ${after}::text)
     ORDER BY f."id"
     LIMIT ${limit * 5}::integer`;
  if (reports.length === 0) return { candidates: [] as string[], last: null as string | null, exhausted: true };
  const digests = new Map(reports.map((row) => [row.id, digestOf(row)]));
  const existing = await prisma.supportTriageSuggestion.findMany({
    where: { feedbackId: { in: reports.map((row) => row.id) } },
    select: { feedbackId: true, inputDigest: true, state: true },
  });
  const needsWork = (feedbackId: string) => {
    const current = digests.get(feedbackId);
    const rows = existing.filter((row) => row.feedbackId === feedbackId);
    // An open proposal for an input the report no longer has.
    if (rows.some((row) => row.inputDigest !== current && OPEN_STATES.includes(row.state as never))) return true;
    const mine = rows.filter((row) => row.inputDigest === current);
    // Returned to pending by a reclaim: claim it again.
    if (mine.some((row) => row.state === "pending")) return true;
    // Live or decided for this input: nothing to do. Only superseded or
    // invalidated rows, or none: make one.
    return !mine.some((row) => SETTLING_STATES.has(row.state));
  };
  const candidates: string[] = [];
  let last: string | null = null;
  for (const row of reports) {
    last = row.id;
    if (needsWork(row.id)) candidates.push(row.id);
    if (candidates.length === limit) break;
  }
  return { candidates, last, exhausted: reports.length < limit * 5 && candidates.length < limit };
};

export type ClaimedRow = {
  readonly id: string;
  readonly feedbackId: string;
  /** The input the lane and flags were computed from. */
  readonly inputDigest: string;
  readonly lane: TriageLane;
  readonly flags: string[];
};

/** Step 2: supersede, insert and claim, for the reports still eligible under lock. */
export const claimSupportTriageBatch = (run: { id: string; deadlineAt: Date }, reportIds: string[]) =>
  transaction(async (tx) => {
    await armSupportTriageTransaction(tx, "worker");
    const reports = await lockEligibleReports(tx, reportIds);
    if (reports.length === 0) return { token: null as string | null, claimed: [] as ClaimedRow[], superseded: 0 };
    const feedbackIds = reports.map((row) => row.id);
    const digests = reports.map(digestOf);
    const superseded = await tx.$executeRaw`
      UPDATE "SupportTriageSuggestion" s SET "state" = 'superseded'
        FROM unnest(${feedbackIds}::text[], ${digests}::text[]) AS c("feedbackId", "inputDigest")
       WHERE s."feedbackId" = c."feedbackId" AND s."inputDigest" <> c."inputDigest"
         AND s."state" = ANY(${OPEN_STATES}::text[])`;
    const newIds = feedbackIds.map(() => randomUUID());
    await tx.$executeRaw`
      INSERT INTO "SupportTriageSuggestion" ("id", "feedbackId", "inputDigest")
      SELECT c."id", c."feedbackId", c."inputDigest"
        FROM unnest(${newIds}::text[], ${feedbackIds}::text[], ${digests}::text[])
             AS c("id", "feedbackId", "inputDigest")
       -- A current input already live or decided (claimed, ready, accepted,
       -- rejected, expired, failed) is not proposed again; only one whose
       -- rows are all superseded or invalidated is.
       WHERE NOT EXISTS (
         SELECT 1 FROM "SupportTriageSuggestion" x
          WHERE x."feedbackId" = c."feedbackId" AND x."inputDigest" = c."inputDigest"
            AND x."state" = ANY(${[...SETTLING_STATES]}::text[]))
      ON CONFLICT ("feedbackId", "inputDigest") WHERE "state" IN ('pending', 'claimed', 'ready') DO NOTHING`;
    const token = randomUUID();
    const claimed = await tx.$queryRaw<{ id: string; feedbackId: string; inputDigest: string }[]>`
      UPDATE "SupportTriageSuggestion" s SET "state" = 'claimed', "claimToken" = ${token}
        FROM unnest(${feedbackIds}::text[], ${digests}::text[]) AS c("feedbackId", "inputDigest")
       WHERE s."feedbackId" = c."feedbackId" AND s."inputDigest" = c."inputDigest" AND s."state" = 'pending'
      RETURNING s."id", s."feedbackId", s."inputDigest"`;
    if (claimed.length + superseded > 0) {
      await audit(tx, run.id, "support_triage.worker_claim", { claimed: claimed.length, superseded });
      await assertDeadline(tx, run.deadlineAt);
    }
    // Step 3, in memory only: the text never leaves this function's result
    // except as flag codes and a lane.
    const byId = new Map(reports.map((row) => [row.id, row]));
    return {
      token,
      superseded,
      claimed: claimed.map((row) => {
        const report = byId.get(row.feedbackId) as ReportRow;
        const flags = keywordFlagsIn(report.message);
        return {
          id: row.id,
          feedbackId: row.feedbackId,
          inputDigest: row.inputDigest,
          flags,
          lane: triageLaneFor({
            type: report.type,
            keywordFlags: flags,
            errorReportVerification: report.errorReportVerification,
          }),
        };
      }),
    };
  });

/** The server facts grouping reads from a locked report row. */
const groupFactsOf = (row: ReportRow): GroupFacts => ({
  feedbackId: row.id,
  status: row.status,
  userId: row.userId,
  errorReportVerification: row.errorReportVerification,
  evidence:
    row.evRouteClass === null || row.evOccurredAt === null
      ? null
      : {
          errorCode: row.evErrorCode,
          routeClass: row.evRouteClass,
          release: row.evRelease,
          occurredAt: row.evOccurredAt,
        },
  autoFixFingerprint: row.caseFingerprint,
});

/**
 * Eligible reports sharing a grouping value with any of `feedbackIds`, at
 * most one over the member cap per value so an oversized class is still seen
 * as one. A hint read outside any transaction: the result transaction locks
 * these rows with the batch and reads their facts again under that lock.
 */
export const readGroupPeers = async (feedbackIds: readonly string[]): Promise<string[]> => {
  if (feedbackIds.length === 0) return [];
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    WITH facts AS (
      SELECT f."id", f."userId", f."errorReportVerification" AS "verification",
             e."errorCode", e."routeClass", e."release", c."fingerprint"
        FROM "Feedback" f
        LEFT JOIN "TraceErrorEvidence" e ON e."id" = f."traceEvidenceId"
        LEFT JOIN "FeedbackAutoFixCase" c ON c."feedbackId" = f."id"
       WHERE f."status" = ANY(${ELIGIBLE}::text[])
         AND f."message" <> ${DELETED_ACCOUNT_MARKER}
    ), batch AS (
      SELECT * FROM facts WHERE "id" = ANY(${[...feedbackIds]}::text[])
    ), peers AS (
      SELECT p."id", pg_catalog.row_number() OVER (PARTITION BY p."userId" ORDER BY p."id") AS "rank"
        FROM facts p WHERE p."userId" IN (SELECT b."userId" FROM batch b WHERE b."userId" IS NOT NULL)
      UNION ALL
      SELECT p."id", pg_catalog.row_number() OVER (PARTITION BY p."fingerprint" ORDER BY p."id")
        FROM facts p WHERE p."fingerprint" IN (SELECT b."fingerprint" FROM batch b WHERE b."fingerprint" IS NOT NULL)
      UNION ALL
      SELECT p."id", pg_catalog.row_number() OVER (PARTITION BY p."errorCode", p."routeClass", p."release" ORDER BY p."id")
        FROM facts p
       WHERE p."verification" = 'verified' AND p."errorCode" IS NOT NULL AND p."release" IS NOT NULL
         AND (p."errorCode", p."routeClass", p."release") IN (
           SELECT b."errorCode", b."routeClass", b."release" FROM batch b
            WHERE b."verification" = 'verified' AND b."errorCode" IS NOT NULL AND b."release" IS NOT NULL)
    )
    SELECT DISTINCT "id" FROM peers WHERE "rank" <= ${GROUP_MEMBER_CAP + 1}::integer ORDER BY "id"`;
  return rows.map((row) => row.id);
};

export type GroupWriteCounts = {
  readonly groupsCreated: number;
  readonly groupMembers: number;
  readonly groupSignals: number;
  /** Created, then missing a planned member taken by a concurrent pass, and invalidated. */
  readonly groupsLost: number;
  /** Open groups that took new members this batch, and how many. */
  readonly groupsJoined: number;
  readonly joinedMembers: number;
  /** A join undone because the grown member set's key already exists (a tombstone). */
  readonly joinsUndone: number;
  readonly memberCapReached: number;
  readonly joinDeferred: number;
  readonly moveDeferred: number;
  readonly budgetDeferred: number;
};

const NO_GROUP_WRITES: GroupWriteCounts = Object.freeze({
  groupsCreated: 0,
  groupMembers: 0,
  groupSignals: 0,
  groupsLost: 0,
  groupsJoined: 0,
  joinedMembers: 0,
  joinsUndone: 0,
  memberCapReached: 0,
  joinDeferred: 0,
  moveDeferred: 0,
  budgetDeferred: 0,
});

/**
 * Groups around the reports this batch made ready (policy section 6), inside
 * the result transaction and after the ready write: new groups, and joins of
 * a report in no open group to the candidate group of its kind and value.
 * Moving up a kind comes later; it is counted, not done.
 *
 * Lock order (design section 5.4): every member's report is already locked
 * FOR SHARE by this transaction with its eligibility re-checked. Every open
 * group those reports are in is then locked FOR UPDATE by one statement in id
 * order, before its members are read and before the plan is made; every
 * membership writer takes the group lock first, so the member lists read here
 * cannot change before these writes.
 *
 * New groups: a key that already exists (a live group or a tombstone) makes no
 * group. A group missing any planned member (another pass took one) is emptied
 * and invalidated before any signal is written, members before the group (the
 * composite key), keeping the planned ids its key was made from.
 *
 * Joins: the key, input digest and signals are recomputed from the members
 * the group actually has after the insert. If that key already belongs to
 * another row (a tombstone of exactly that set), the join is undone: the
 * newcomers' memberships are deleted and the group keeps its old key.
 *
 * Round trips in the result transaction, at most 17 of the worker lane's 20:
 * arm, report lock, ready update, group lock, member read, group insert,
 * member insert, [lost member delete, lost group update], key update, [join
 * undo], signal delete, signal insert, the audit entry's four, deadline check.
 */
const writeGroups = async (
  tx: Tx,
  locked: readonly ReportRow[],
  arriving: readonly string[],
  membershipBudget: number
): Promise<GroupWriteCounts & { membershipsUsed: number }> => {
  const ids = locked.map((row) => row.id);
  const current = await tx.$queryRaw<
    { feedbackId: string; groupId: string; state: string; kind: GroupKind; snapshotDigest: string }[]
  >`
    SELECT m."feedbackId", g."id" AS "groupId", g."state", g."primaryKind" AS "kind",
           m."primarySnapshotDigest" AS "snapshotDigest"
      FROM "SupportTriageGroupMember" m
      JOIN "SupportTriageGroup" g ON g."id" = m."groupId"
     WHERE m."feedbackId" = ANY(${ids}::text[])
     ORDER BY g."id", m."feedbackId"
       FOR UPDATE OF g`;
  const lockedGroupIds = [...new Set(current.map((row) => row.groupId))];
  const existing =
    lockedGroupIds.length === 0
      ? []
      : await tx.$queryRaw<{ groupId: string; feedbackId: string }[]>`
          SELECT m."groupId", m."feedbackId" FROM "SupportTriageGroupMember" m
           WHERE m."groupId" = ANY(${lockedGroupIds}::text[])
           ORDER BY m."groupId", m."feedbackId"`;
  const groupMembers = new Map<string, string[]>();
  for (const row of existing) groupMembers.set(row.groupId, [...(groupMembers.get(row.groupId) ?? []), row.feedbackId]);
  const facts = locked.map(groupFactsOf);
  const factsById = new Map(facts.map((row) => [row.feedbackId, row]));
  const plan = planGroups({
    reports: facts,
    arriving,
    memberships: new Map(
      current.map((row) => [
        row.feedbackId,
        { groupId: row.groupId, state: row.state, kind: row.kind, snapshotDigest: row.snapshotDigest },
      ])
    ),
    groupMembers,
    membershipBudget,
  });
  const deferred = {
    memberCapReached: plan.memberCapReached,
    joinDeferred: plan.joinDeferred,
    moveDeferred: plan.moveDeferred,
    budgetDeferred: plan.budgetDeferred,
  };
  if (plan.planned.length === 0 && plan.joins.length === 0) {
    return { ...NO_GROUP_WRITES, ...deferred, membershipsUsed: 0 };
  }

  const groupIds = plan.planned.map(() => randomUUID());
  const created =
    plan.planned.length === 0
      ? []
      : await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "SupportTriageGroup" ("id", "primaryKind", "primarySnapshotDigest", "groupCandidateKey", "groupInputDigest")
          SELECT c."id", c."kind", c."digest", c."key", c."inputDigest"
            FROM unnest(${groupIds}::text[], ${plan.planned.map((g) => g.kind)}::text[],
                        ${plan.planned.map((g) => g.snapshotDigest)}::text[],
                        ${plan.planned.map((g) => g.groupCandidateKey)}::text[],
                        ${plan.planned.map((g) => g.groupInputDigest)}::text[]) AS c("id", "kind", "digest", "key", "inputDigest")
          ON CONFLICT ("groupCandidateKey") DO NOTHING
          RETURNING "id"`;
  const createdIds = new Set(created.map((row) => row.id));
  const kept = plan.planned.map((group, i) => ({ ...group, id: groupIds[i] })).filter((g) => createdIds.has(g.id));

  const memberRows = [
    ...kept.flatMap((g) => g.memberIds.map((feedbackId) => [g.id, feedbackId, g.snapshotDigest] as const)),
    ...plan.joins.flatMap((j) => j.newcomerIds.map((feedbackId) => [j.groupId, feedbackId, j.snapshotDigest] as const)),
  ];
  const members =
    memberRows.length === 0
      ? []
      : await tx.$queryRaw<{ groupId: string; feedbackId: string }[]>`
          INSERT INTO "SupportTriageGroupMember" ("groupId", "feedbackId", "primarySnapshotDigest")
          SELECT c."groupId", c."feedbackId", c."digest"
            FROM unnest(${memberRows.map((r) => r[0])}::text[], ${memberRows.map((r) => r[1])}::text[],
                        ${memberRows.map((r) => r[2])}::text[]) AS c("groupId", "feedbackId", "digest")
           ORDER BY c."groupId", c."feedbackId"
          ON CONFLICT ("feedbackId") DO NOTHING
          RETURNING "groupId", "feedbackId"`;
  const inserted = new Map<string, string[]>();
  for (const row of members) inserted.set(row.groupId, [...(inserted.get(row.groupId) ?? []), row.feedbackId]);

  // New groups: any planned member missing means the key and input digest name
  // a set the group does not have, so the whole group goes, and it keeps every
  // planned id so an account deletion can still find its tombstone.
  const lostGroups = kept.filter((g) => (inserted.get(g.id)?.length ?? 0) !== g.memberIds.length);
  const lost = lostGroups.map((g) => g.id);
  if (lost.length > 0) {
    await tx.$executeRaw`DELETE FROM "SupportTriageGroupMember" WHERE "groupId" = ANY(${lost}::text[])`;
    await tx.$executeRaw`
      UPDATE "SupportTriageGroup" g
         SET "state" = 'invalidated', "primarySnapshotDigest" = NULL,
             "retiredMemberIds" = pg_catalog.string_to_array(c."memberIds", ',')
        FROM unnest(${lost}::text[], ${lostGroups.map((group) => group.memberIds.join(","))}::text[]) AS c("id", "memberIds")
       WHERE g."id" = c."id" AND g."state" = 'candidate'`;
  }
  const live = kept.filter((g) => !lost.includes(g.id));

  // Joins: rebind each grown group to the members it actually has now.
  const grown = plan.joins
    .filter((j) => (inserted.get(j.groupId)?.length ?? 0) > 0)
    .map((j) => {
      const newcomers = inserted.get(j.groupId) as string[];
      const memberIds = [...j.existingIds, ...newcomers];
      const binding = groupBinding(
        j.kind,
        j.snapshotDigest,
        memberIds.map((id) => factsById.get(id) as GroupFacts)
      );
      return { ...j, newcomers, binding };
    });
  const rebound =
    grown.length === 0
      ? []
      : await tx.$queryRaw<{ id: string }[]>`
          UPDATE "SupportTriageGroup" g
             SET "groupCandidateKey" = c."key", "groupInputDigest" = c."inputDigest"
            FROM unnest(${grown.map((j) => j.groupId)}::text[],
                        ${grown.map((j) => j.binding.groupCandidateKey)}::text[],
                        ${grown.map((j) => j.binding.groupInputDigest)}::text[]) AS c("id", "key", "inputDigest")
           WHERE g."id" = c."id" AND g."state" = 'candidate'
             AND NOT EXISTS (SELECT 1 FROM "SupportTriageGroup" o WHERE o."groupCandidateKey" = c."key")
          RETURNING g."id"`;
  const reboundIds = new Set(rebound.map((row) => row.id));
  const undone = grown.filter((j) => !reboundIds.has(j.groupId));
  if (undone.length > 0) {
    const pairs = undone.flatMap((j) => j.newcomers.map((feedbackId) => [j.groupId, feedbackId] as const));
    await tx.$executeRaw`
      DELETE FROM "SupportTriageGroupMember" m
       USING unnest(${pairs.map((p) => p[0])}::text[], ${pairs.map((p) => p[1])}::text[]) AS c("groupId", "feedbackId")
       WHERE m."groupId" = c."groupId" AND m."feedbackId" = c."feedbackId"`;
  }
  const joined = grown.filter((j) => reboundIds.has(j.groupId));

  // A joined group's signals are replaced: a newcomer may not share a
  // secondary value, and an earlier evidence occurrence moves the expiry.
  if (joined.length > 0) {
    await tx.$executeRaw`
      DELETE FROM "SupportTriageGroupSignal" WHERE "groupId" = ANY(${joined.map((j) => j.groupId)}::text[])`;
  }
  const signalRows = [
    ...live.flatMap((g) => g.signals.map((s) => [g.id, s.kind, s.snapshotDigest, s.expiresAt] as const)),
    ...joined.flatMap((j) => j.binding.signals.map((s) => [j.groupId, s.kind, s.snapshotDigest, s.expiresAt] as const)),
  ];
  const signals =
    signalRows.length === 0
      ? 0
      : await tx.$executeRaw`
          INSERT INTO "SupportTriageGroupSignal" ("groupId", "kind", "snapshotDigest", "provenanceClass", "snapshotExpiresAt")
          SELECT c."groupId", c."kind", c."digest", c."provenance", c."expiresAt"
            FROM unnest(${signalRows.map((r) => r[0])}::text[], ${signalRows.map((r) => r[1])}::text[],
                        ${signalRows.map((r) => r[2])}::text[],
                        ${signalRows.map((r) => SIGNAL_PROVENANCE[r[1]])}::text[],
                        ${signalRows.map((r) => r[3])}::timestamp(3)[])
                 AS c("groupId", "kind", "digest", "provenance", "expiresAt")`;
  return {
    groupsCreated: live.length,
    groupMembers: live.reduce((sum, g) => sum + (inserted.get(g.id)?.length ?? 0), 0),
    groupSignals: signals,
    groupsLost: lost.length,
    groupsJoined: joined.length,
    joinedMembers: joined.reduce((sum, j) => sum + j.newcomers.length, 0),
    joinsUndone: undone.length,
    ...deferred,
    membershipsUsed: members.length,
  };
};

/**
 * Step 4: ready only the rows still claimed with this token, for reports still
 * eligible; then the groups around them. `peerIds` (from `readGroupPeers`) are
 * locked with the batch in one statement, in id order, so the report lock is
 * taken once and before any group row.
 */
export const writeSupportTriageResults = (
  run: { id: string; deadlineAt: Date },
  token: string,
  rows: readonly ClaimedRow[],
  grouping: { readonly peerIds?: readonly string[]; readonly membershipBudget?: number } = {}
) =>
  transaction(async (tx) => {
    await armSupportTriageTransaction(tx, "worker");
    const lockIds = [...new Set([...rows.map((row) => row.feedbackId), ...(grouping.peerIds ?? [])])];
    const locked = await lockEligibleReports(tx, lockIds);
    // Still eligible, and the same input the lane and flags were computed from.
    const current = new Map(locked.map((row) => [row.id, digestOf(row)]));
    const writable = rows.filter((row) => current.get(row.feedbackId) === row.inputDigest);
    const ready =
      writable.length === 0
        ? []
        : await tx.$queryRaw<{ id: string }[]>`
            UPDATE "SupportTriageSuggestion" s
               SET "state" = 'ready', "lane" = c."lane",
                   "keywordFlags" = CASE WHEN c."flags" = '' THEN ARRAY[]::text[]
                                         ELSE pg_catalog.string_to_array(c."flags", ',') END
              FROM unnest(${writable.map((row) => row.id)}::text[],
                                     ${writable.map((row) => row.lane)}::text[],
                                     ${writable.map((row) => row.flags.join(","))}::text[]) AS c("id", "lane", "flags")
             WHERE s."id" = c."id" AND s."state" = 'claimed' AND s."claimToken" = ${token}
            RETURNING s."id"`;
    const readyIds = new Set(ready.map((row) => row.id));
    const arriving = writable.filter((row) => readyIds.has(row.id)).map((row) => row.feedbackId);
    const groups =
      arriving.length === 0
        ? { ...NO_GROUP_WRITES, membershipsUsed: 0 }
        : await writeGroups(
            tx,
            locked,
            arriving,
            grouping.membershipBudget ?? GROUP_NEW_MEMBERSHIPS_PER_PASS_MAX
          );
    if (ready.length > 0) {
      await audit(tx, run.id, "support_triage.worker_result", {
        ready: ready.length,
        groupsCreated: groups.groupsCreated,
        groupMembers: groups.groupMembers,
        groupSignals: groups.groupSignals,
        groupsLost: groups.groupsLost,
        groupsJoined: groups.groupsJoined,
        joinedMembers: groups.joinedMembers,
        joinsUndone: groups.joinsUndone,
        memberCapReached: groups.memberCapReached,
        joinDeferred: groups.joinDeferred,
        moveDeferred: groups.moveDeferred,
        budgetDeferred: groups.budgetDeferred,
      });
      await assertDeadline(tx, run.deadlineAt);
    }
    return { ready: ready.length, stale: rows.length - ready.length, groups };
  });

export type WorkerPassResult = {
  readonly runId: string;
  readonly outcome: string;
  readonly reclaimed: number;
  readonly exhausted: number;
  readonly claimed: number;
  readonly ready: number;
  readonly stale: number;
  readonly superseded: number;
  readonly groupsCreated: number;
};

const databaseNow = async (): Promise<Date> => {
  const [row] = await prisma.$queryRaw<{ now: Date }[]>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`;
  return row.now;
};

export const runSupportTriageWorker = async (): Promise<WorkerPassResult> => {
  const run = await startSupportTriageRun("worker");
  const totals = { reclaimed: 0, exhausted: 0, claimed: 0, ready: 0, stale: 0, superseded: 0, groupsCreated: 0 };
  let membershipBudget = GROUP_NEW_MEMBERSHIPS_PER_PASS_MAX;
  let batchesCompleted = 0;
  let partial = false;
  const hasBudget = async () =>
    run.deadlineAt.getTime() - (await databaseNow()).getTime() > maxGuardedBudgetMs("worker");
  try {
    if (await hasBudget()) {
      const reclaim = await reclaimExpiredSuggestions(run);
      totals.reclaimed = reclaim.reclaimed;
      totals.exhausted = reclaim.exhausted;
    }
    let after: string | null = null;
    while (totals.claimed < WORKER_PASS_MAX) {
      // Two transactions per batch; both must fit.
      if (!(await hasBudget())) {
        partial = true;
        break;
      }
      const limit = Math.min(WORKER_CLAIM_BATCH_SIZE, WORKER_PASS_MAX - totals.claimed);
      const { candidates, last, exhausted } = await readCandidates(after, limit);
      after = last;
      if (candidates.length > 0) {
        const batch = await claimSupportTriageBatch(run, candidates);
        totals.superseded += batch.superseded;
        totals.claimed += batch.claimed.length;
        if (batch.token && batch.claimed.length > 0) {
          if (!(await hasBudget())) {
            // Claimed but not written: the leases expire and a later pass reclaims them.
            partial = true;
            break;
          }
          const peerIds = await readGroupPeers(batch.claimed.map((row) => row.feedbackId));
          const result = await writeSupportTriageResults(run, batch.token, batch.claimed, { peerIds, membershipBudget });
          totals.ready += result.ready;
          totals.stale += result.stale;
          totals.groupsCreated += result.groups.groupsCreated;
          membershipBudget -= result.groups.membershipsUsed;
          batchesCompleted += 1;
        }
      }
      if (exhausted || last === null) break;
    }
    if (totals.stale > 0) {
      console.warn(JSON.stringify({ event: "support_triage_stale_claim", count: totals.stale }));
    }
    const finished = await finishSupportTriageRun({
      id: run.id,
      kind: "worker",
      outcome: partial ? "partial" : "success",
      counters: { batchesCompleted },
    });
    return { runId: run.id, outcome: finished.outcome, ...totals };
  } catch (error) {
    await finishSupportTriageRun({ id: run.id, kind: "worker", outcome: "failed", counters: { batchesCompleted } }).catch(
      () => undefined
    );
    throw error;
  }
};
