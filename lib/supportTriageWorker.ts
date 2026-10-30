/**
 * One support-triage worker pass, suggestions only (design section 5.2 steps
 * 1 to 5 and 5.3). Groups are not formed: the model names duplicates.
 *
 * A pass starts a `worker` run row, fails expired claims (a lapsed claim may
 * already have paid for its model call, so it is never handed out again),
 * then works in batches of 10 reports, at most 50 per pass, while the
 * remaining budget covers the model call and both transactions:
 *
 *   1. read candidates: reports awaiting an operator, not a deleted account's,
 *      that need work: an open suggestion of another input to supersede, a
 *      pending one of the current input, or no live or decided one for it
 *      (a hint; nothing is locked). A current input whose only rows are
 *      superseded or invalidated before they were answered (the input came
 *      back, or the report reopened) is made again; one already answered is
 *      not, so the same input is never paid for twice;
 *   2. claim transaction: lock those reports FOR SHARE in id order with the
 *      eligibility re-checked, recompute each input digest from the locked
 *      rows, supersede pending or ready suggestions of an older input (a
 *      claimed one is left to its claim, which may be paying for a call),
 *      insert the new pending rows and claim the pending ones with this
 *      batch's token;
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
  LANE_TIMEOUTS,
  SUGGESTION_CLOSABLE_OPEN_STATES,
  SUGGESTION_SETTLING_STATES,
  TRIAGE_ELIGIBLE_REPORT_STATUSES,
  TRIAGE_REPORT_WINDOW_DAYS,
  WORKER_CLAIM_BATCH_SIZE,
  WORKER_PASS_MAX,
  WORKER_RECLAIM_MAX,
  maxGuardedBudgetMs,
  suggestionSettlesInput,
  triageLaneFor,
  type LaneSource,
  type TriageLane,
} from "@/lib/supportTriageCore";
import { suggestionInputDigest } from "@/lib/supportTriageInputDigest";
import { keywordFlagsIn } from "@/lib/supportTriageKeywords";
import {
  DUPLICATE_CANDIDATES_MAX,
  SUPPORT_TRIAGE_LLM_TIMEOUT_MS,
  supportTriageLlmFromEnv,
  type TriageCandidate,
  type TriageLlm,
  type TriageLlmAnswer,
  type TriageLlmInput,
} from "@/lib/supportTriageLlm";
import { finishSupportTriageRun, startSupportTriageRun } from "@/lib/supportTriageRunStore";
import { armSupportTriageTransaction } from "@/lib/supportTriageTransaction";

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const ELIGIBLE = [...TRIAGE_ELIGIBLE_REPORT_STATUSES];
const CLOSABLE_STATES = [...SUGGESTION_CLOSABLE_OPEN_STATES];

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

/**
 * The eligible reports among `ids`, locked FOR SHARE in id order, with their
 * evidence and case. `windowed` also requires a report created within
 * TRIAGE_REPORT_WINDOW_DAYS: the claim asks it, the result write does not, so
 * an answer already paid for is not dropped for crossing the window mid-call.
 */
const lockEligibleReports = (tx: Tx, ids: string[], windowed = false) =>
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
       AND (NOT ${windowed}::boolean
            OR f."createdAt" > (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(days => ${TRIAGE_REPORT_WINDOW_DAYS}::integer))
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

/**
 * Expired claims fail and are not retried: the pass that held one may have
 * paid for its model call before it stopped, and a run whose outcome is
 * unknown is never retried (policy section 2, item 11). Failed settles the
 * input, so the report is triaged again only when its input changes.
 */
export const failExpiredClaims = (run: { id: string; deadlineAt: Date }) =>
  transaction(async (tx) => {
    await armSupportTriageTransaction(tx, "worker");
    // retry_exhausted here means "no retry is allowed", not "retries were tried".
    const exhausted = await tx.$executeRaw`
      UPDATE "SupportTriageSuggestion" s SET "state" = 'failed', "failureCode" = 'retry_exhausted'
       WHERE s."id" IN (
         SELECT x."id" FROM "SupportTriageSuggestion" x
          WHERE x."state" = 'claimed' AND x."leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
          ORDER BY x."id" LIMIT ${WORKER_RECLAIM_MAX}::integer FOR UPDATE SKIP LOCKED)
         AND s."state" = 'claimed'`;
    if (exhausted > 0) {
      await audit(tx, run.id, "support_triage.worker_reclaim", { reclaimed: 0, exhausted });
      await assertDeadline(tx, run.deadlineAt);
    }
    return { exhausted };
  });

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
       AND f."createdAt" > (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(days => ${TRIAGE_REPORT_WINDOW_DAYS}::integer)
       AND (${after}::text IS NULL OR f."id" > ${after}::text)
     ORDER BY f."id"
     LIMIT ${limit * 5}::integer`;
  if (reports.length === 0) return { candidates: [] as string[], last: null as string | null, exhausted: true };
  const digests = new Map(reports.map((row) => [row.id, digestOf(row)]));
  const existing = await prisma.supportTriageSuggestion.findMany({
    where: { feedbackId: { in: reports.map((row) => row.id) } },
    select: { feedbackId: true, inputDigest: true, state: true, lane: true },
  });
  const needsWork = (feedbackId: string) => {
    const current = digests.get(feedbackId);
    const rows = existing.filter((row) => row.feedbackId === feedbackId);
    // An open proposal for an input the report no longer has.
    if (rows.some((row) => row.inputDigest !== current && CLOSABLE_STATES.includes(row.state as never))) return true;
    const mine = rows.filter((row) => row.inputDigest === current);
    if (mine.some((row) => row.state === "pending")) return true;
    // Live, decided or answered for this input: nothing to do. Only rows
    // closed before an answer, or none: make one.
    return !mine.some(suggestionSettlesInput);
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
  /** The LLM step's answer, when it ran and its answer was usable. */
  readonly llm?: TriageLlmAnswer;
};

/** What the LLM step reads of a claimed report; never logged or audited. */
export type ClaimedReport = TriageLlmInput["report"];

/** Step 2: supersede, insert and claim, for the reports still eligible under lock. */
export const claimSupportTriageBatch = (
  run: { id: string; deadlineAt: Date },
  reportIds: string[],
  reserveMs: number
) =>
  transaction(async (tx) => {
    await armSupportTriageTransaction(tx, "worker");
    const reports = await lockEligibleReports(tx, reportIds, true);
    if (reports.length === 0) {
      return {
        token: null as string | null,
        claimed: [] as ClaimedRow[],
        superseded: 0,
        reports: new Map<string, ClaimedReport>(),
      };
    }
    const feedbackIds = reports.map((row) => row.id);
    const digests = reports.map(digestOf);
    const superseded = await tx.$executeRaw`
      UPDATE "SupportTriageSuggestion" s SET "state" = 'superseded'
        FROM unnest(${feedbackIds}::text[], ${digests}::text[]) AS c("feedbackId", "inputDigest")
       WHERE s."feedbackId" = c."feedbackId" AND s."inputDigest" <> c."inputDigest"
         AND s."state" = ANY(${CLOSABLE_STATES}::text[])`;
    const newIds = feedbackIds.map(() => randomUUID());
    await tx.$executeRaw`
      INSERT INTO "SupportTriageSuggestion" ("id", "feedbackId", "inputDigest")
      SELECT c."id", c."feedbackId", c."inputDigest"
        FROM unnest(${newIds}::text[], ${feedbackIds}::text[], ${digests}::text[])
             AS c("id", "feedbackId", "inputDigest")
       -- A current input already live, decided or answered (suggestionSettlesInput)
       -- is not proposed again; only one whose rows all closed unanswered is.
       WHERE NOT EXISTS (
         SELECT 1 FROM "SupportTriageSuggestion" x
          WHERE x."feedbackId" = c."feedbackId" AND x."inputDigest" = c."inputDigest"
            AND (x."state" = ANY(${SUGGESTION_SETTLING_STATES}::text[]) OR x."lane" IS NOT NULL))
      ON CONFLICT ("feedbackId", "inputDigest") WHERE "state" IN ('pending', 'claimed', 'ready') DO NOTHING`;
    const token = randomUUID();
    const claimed = await tx.$queryRaw<{ id: string; feedbackId: string; inputDigest: string }[]>`
      UPDATE "SupportTriageSuggestion" s SET "state" = 'claimed', "claimToken" = ${token}
        FROM unnest(${feedbackIds}::text[], ${digests}::text[]) AS c("feedbackId", "inputDigest")
       WHERE s."feedbackId" = c."feedbackId" AND s."inputDigest" = c."inputDigest" AND s."state" = 'pending'
      RETURNING s."id", s."feedbackId", s."inputDigest"`;
    if (claimed.length + superseded > 0) {
      await audit(tx, run.id, "support_triage.worker_claim", { claimed: claimed.length, superseded });
      // The claim commits only while what follows it (the model call and the
      // result transaction) still fits before the deadline; otherwise it rolls
      // back and nothing is left claimed to lapse.
      await assertDeadline(tx, new Date(run.deadlineAt.getTime() - reserveMs));
    }
    // Step 3, in memory: flag codes and a keyword lane; the report itself is
    // returned only for the LLM step, which sends it to the configured model.
    const byId = new Map(reports.map((row) => [row.id, row]));
    return {
      token,
      superseded,
      reports: new Map<string, ClaimedReport>(
        reports.map((row) => [
          row.id,
          {
            type: row.type,
            language: row.language,
            message: row.message,
            verifiedError: row.errorReportVerification === "verified" ? row.evErrorCode : null,
          },
        ])
      ),
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

const HUMAN_LANES: readonly TriageLane[] = ["billing_human", "trust_safety_human"];

/**
 * The lane written: a money or trust-and-safety keyword keeps its human lane
 * whatever the model says (a floor, not a vote); otherwise the model's lane
 * when it answered, else the keyword lane. The one move off a human floor is
 * up: billing to trust and safety, which outranks it (policy section 1).
 */
export const finalLane = (row: ClaimedRow): { finalLane: TriageLane; laneSource: LaneSource } => {
  if (row.lane === "billing_human" && row.llm?.lane === "trust_safety_human") {
    return { finalLane: "trust_safety_human", laneSource: "llm" };
  }
  if (!row.llm || HUMAN_LANES.includes(row.lane)) return { finalLane: row.lane, laneSource: "keyword" };
  // Verified is a server fact: the keyword rule reads it from the report, the
  // model only from the prompt. The model cannot raise a report to verified.
  if (row.llm.lane === "bug_verified" && row.lane !== "bug_verified") {
    return { finalLane: "bug_unverified", laneSource: "llm" };
  }
  return { finalLane: row.llm.lane, laneSource: "llm" };
};

/** Open reports a claimed report may duplicate: the newest 30 eligible ones from the last 30 days. */
export const readDuplicateCandidates = (): Promise<TriageCandidate[]> =>
  prisma.$queryRaw<TriageCandidate[]>`
    SELECT f."id", f."type", f."message"
      FROM "Feedback" f
     WHERE f."status" = ANY(${ELIGIBLE}::text[])
       AND f."message" <> ${DELETED_ACCOUNT_MARKER}
       AND f."createdAt" >= (clock_timestamp() AT TIME ZONE 'UTC') - interval '30 days'
     ORDER BY f."createdAt" DESC
     LIMIT ${DUPLICATE_CANDIDATES_MAX + WORKER_CLAIM_BATCH_SIZE}::integer`;

/**
 * The LLM step, outside any transaction: one call per claimed report, all at
 * once (a batch is at most 10). A failed or unusable answer leaves the row on
 * its keyword lane. The lease (5 minutes) outlasts the call timeout.
 *
 * The duplicate pool is read before the claim and the reports in the claim, so
 * an account deletion can complete after either read. Right before the calls,
 * one read by id keeps only the reports still open and not anonymised: a
 * deletion committed by then is never sent (docs/policy/support-triage.md §5).
 * A deletion committed after it is ordered after the dispatch; the result
 * transaction then keeps no answer that saw it, and the deletion removes the
 * row that did.
 */
export const runTriageLlm = async (
  llm: TriageLlm,
  claimed: readonly ClaimedRow[],
  reports: ReadonlyMap<string, ClaimedReport>,
  pool: readonly TriageCandidate[]
): Promise<ClaimedRow[]> => {
  const ids = [...new Set([...claimed.map((row) => row.feedbackId), ...pool.map((c) => c.id)])];
  const showable = new Set(
    (
      await prisma.$queryRaw<{ id: string }[]>`
        SELECT f."id" FROM "Feedback" f
         WHERE f."id" = ANY(${ids}::text[])
           AND f."status" = ANY(${ELIGIBLE}::text[])
           AND f."message" <> ${DELETED_ACCOUNT_MARKER}`
    ).map((row) => row.id)
  );
  const shown = pool.filter((c) => showable.has(c.id));
  return Promise.all(
    claimed.map(async (row) => {
      const report = reports.get(row.feedbackId);
      // A report closed or deleted since the claim is not sent; a claim still
      // left lapses to failed.
      if (!report || !showable.has(row.feedbackId)) return row;
      const candidates = shown.filter((c) => c.id !== row.feedbackId).slice(0, DUPLICATE_CANDIDATES_MAX);
      const answer = await llm({ report, candidates });
      return answer ? { ...row, llm: answer } : row;
    })
  );
};

/**
 * Step 4: ready only the rows still claimed with this token, for reports still
 * eligible. Reports are no longer grouped here: the model's duplicateOf answer
 * replaced the keyword-era group formation (owner direction 2026-10-19, LLM
 * first), so the worker writes no SupportTriageGroup rows.
 */
export const writeSupportTriageResults = (
  run: { id: string; deadlineAt: Date },
  token: string,
  rows: readonly ClaimedRow[]
) =>
  transaction(async (tx) => {
    await armSupportTriageTransaction(tx, "worker");
    // The batch and every report the model was shown, in one id-ordered lock:
    // an account deletion of a shown report either waits for this commit (and
    // then deletes this row by contextFeedbackIds) or has already marked it,
    // which drops the answer below.
    const lockIds = [
      ...new Set([...rows.map((row) => row.feedbackId), ...rows.flatMap((row) => row.llm?.contextIds ?? [])]),
    ];
    const locked = await lockEligibleReports(tx, lockIds);
    // Still eligible, and the same input the lane and flags were computed from.
    const current = new Map(locked.map((row) => [row.id, digestOf(row)]));
    const writable = rows
      .filter((row) => current.get(row.feedbackId) === row.inputDigest)
      // An answer whose context lost a report (deleted or closed since) is not kept.
      .map((row) =>
        row.llm && !row.llm.contextIds.every((id) => current.has(id)) ? { ...row, llm: undefined } : row
      )
      .map((row) => ({ ...row, ...finalLane(row) }));
    const ready =
      writable.length === 0
        ? []
        : await tx.$queryRaw<{ id: string }[]>`
            UPDATE "SupportTriageSuggestion" s
               SET "state" = 'ready', "lane" = c."lane", "laneSource" = c."laneSource",
                   "keywordFlags" = CASE WHEN c."flags" = '' THEN ARRAY[]::text[]
                                         ELSE pg_catalog.string_to_array(c."flags", ',') END,
                   "contextFeedbackIds" = CASE WHEN c."context" = '' THEN ARRAY[]::text[]
                                               ELSE pg_catalog.string_to_array(c."context", ',') END,
                   "duplicateOfFeedbackIds" = CASE WHEN c."duplicates" = '' THEN ARRAY[]::text[]
                                                   ELSE pg_catalog.string_to_array(c."duplicates", ',') END,
                   "replyDraft" = NULLIF(c."replyDraft", '')
              FROM unnest(${writable.map((row) => row.id)}::text[],
                                     ${writable.map((row) => row.finalLane)}::text[],
                                     ${writable.map((row) => row.laneSource)}::text[],
                                     ${writable.map((row) => row.flags.join(","))}::text[],
                                     ${writable.map((row) => (row.llm?.contextIds ?? []).join(","))}::text[],
                                     ${writable.map((row) => (row.llm?.duplicateOf ?? []).join(","))}::text[],
                                     ${writable.map((row) => row.llm?.replyDraft ?? "")}::text[])
                   AS c("id", "lane", "laneSource", "flags", "context", "duplicates", "replyDraft")
             WHERE s."id" = c."id" AND s."state" = 'claimed' AND s."claimToken" = ${token}
            RETURNING s."id"`;
    if (ready.length > 0) {
      await audit(tx, run.id, "support_triage.worker_result", { ready: ready.length });
      await assertDeadline(tx, run.deadlineAt);
    }
    return { ready: ready.length, stale: rows.length - ready.length };
  });

export type WorkerPassResult = {
  readonly runId: string;
  readonly outcome: string;
  readonly exhausted: number;
  readonly claimed: number;
  readonly ready: number;
  readonly stale: number;
  readonly superseded: number;
};

const deadlinePassed = (error: unknown) =>
  error instanceof Error && error.message.includes("support_triage_deadline_passed");

const databaseNow = async (): Promise<Date> => {
  const [row] = await prisma.$queryRaw<{ now: Date }[]>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`;
  return row.now;
};

/** `options.llm` replaces the configured model (tests); `null` turns the step off. */
export const runSupportTriageWorker = async (
  options: { readonly llm?: TriageLlm | null } = {}
): Promise<WorkerPassResult> => {
  const run = await startSupportTriageRun("worker");
  const totals = { exhausted: 0, claimed: 0, ready: 0, stale: 0, superseded: 0 };
  const llm = options.llm === undefined ? await supportTriageLlmFromEnv() : options.llm;
  let batchesCompleted = 0;
  let partial = false;
  // What a claimed batch still needs: the model call and the result
  // transaction. A claim commits only with this much left, so a claimed batch
  // is always called and its answer is not dropped for want of time. A result
  // transaction that fails for another reason rolls back, and its claim lapses
  // to failed without a second call (policy section 2 item 11).
  const batchReserveMs = maxGuardedBudgetMs("worker") + (llm ? SUPPORT_TRIAGE_LLM_TIMEOUT_MS : 0);
  const hasBudget = async (reserveMs = maxGuardedBudgetMs("worker")) =>
    run.deadlineAt.getTime() - (await databaseNow()).getTime() > reserveMs;
  try {
    if (await hasBudget()) {
      totals.exhausted = (await failExpiredClaims(run)).exhausted;
    }
    let after: string | null = null;
    while (totals.claimed < WORKER_PASS_MAX) {
      // Two transactions and the model call per batch; all must fit.
      if (!(await hasBudget(batchReserveMs))) {
        partial = true;
        break;
      }
      const limit = Math.min(WORKER_CLAIM_BATCH_SIZE, WORKER_PASS_MAX - totals.claimed);
      const { candidates, last, exhausted } = await readCandidates(after, limit);
      after = last;
      if (candidates.length > 0) {
        const pool = llm ? await readDuplicateCandidates() : [];
        const batch = await claimSupportTriageBatch(run, candidates, batchReserveMs).catch((error: unknown) => {
          if (deadlinePassed(error)) return null;
          throw error;
        });
        if (!batch) {
          // The claim ran past its reserve and rolled back: nothing was claimed.
          partial = true;
          break;
        }
        totals.superseded += batch.superseded;
        totals.claimed += batch.claimed.length;
        if (batch.token && batch.claimed.length > 0) {
          // The claim's reserve covers the call (it ends within its timeout)
          // and the write, so neither is skipped for want of time.
          const answered = llm ? await runTriageLlm(llm, batch.claimed, batch.reports, pool) : batch.claimed;
          const result = await writeSupportTriageResults(run, batch.token, answered);
          totals.ready += result.ready;
          totals.stale += result.stale;
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
