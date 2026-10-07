import "server-only";

import { z } from "zod";

import {
  QaReleaseMergeLaneLate,
  consumeQaReleaseMergeInstruction,
  issueQaReleaseMergeInstruction,
  readQaReleaseMergeLaneState,
  reportQaReleaseMergeResult,
} from "@/lib/qaReleaseMergeLaneStore";
import { qaReleaseDeployObservation } from "@/lib/qaReleaseMergeLaneReportCore";
import { QA_RELEASE_CONTROL_REVISION_HEADER, isQaReleaseRouteSecret } from "@/lib/qaReleaseRouteAuthCore";

/**
 * The merge lane service's three app calls (docs/policy/qa-release-agent.md
 * version 4, sections 3, 6 and 10): instruction issue, instruction consume and
 * result report. Each authenticates the merge lane's own secret, reads the
 * revision number the service carries, checks a strict body and hands both to
 * the single writer, which judges the revision inside its transaction -- issue
 * and consume refuse a mismatch, a report is kept and latches (section 6).
 *
 * Each call has its own budget, measured from the request's arrival, and the
 * transaction's last statement checks it on the database clock.
 */

/** One call's budget: above the longest transaction's Prisma limit (40 s), below the service's call timeout. */
export const QA_RELEASE_MERGE_LANE_CALL_BUDGET_MS = 50_000;

export type QaReleaseMergeLaneAnswer = { status: number; body: Record<string, unknown> };

const answer = (status: number, body: Record<string, unknown>): QaReleaseMergeLaneAnswer => ({ status, body });

const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const PR = z.number().int().positive().max(1_000_000_000);
const ATTEMPT = z.string().min(1).max(64);

const issueBody = z.object({ pullRequestNumber: PR, headSha: SHA }).strict();
const consumeBody = z.object({ attemptId: ATTEMPT, pullRequestNumber: PR, headSha: SHA, base: z.string().min(1).max(255) }).strict();
const reportBody = z
  .object({
    attemptId: ATTEMPT,
    report: z.union([
      z.object({ kind: z.literal("merge"), result: z.literal("merged"), mergeCommitSha: SHA }).strict(),
      z.object({ kind: z.literal("merge"), result: z.enum(["refused", "unknown"]) }).strict(),
      z
        .object({
          kind: z.literal("deploy"),
          outcome: z.enum(["succeeded", "failed", "unknown", "wait_exceeded", "unreadable"]),
          observation: z
            .array(z.object({ service: z.string(), status: z.string(), commitSha: SHA.nullable() }).strict())
            .max(20),
        })
        .strict(),
      z.object({ kind: z.literal("unreported") }).strict(),
      z.object({ kind: z.literal("reread"), result: z.literal("merged_on_develop"), mergeCommitSha: SHA }).strict(),
      z.object({ kind: z.literal("reread"), result: z.enum(["not_merged", "merged_off_develop", "merge_commit_off_develop"]) }).strict(),
    ]),
  })
  .strict();

/** Parsed against the strict schema; null when the body is not exactly one report. */
const parseReport = (value: unknown) => {
  const parsed = reportBody.safeParse(value);
  if (!parsed.success) return null;
  // The observation's closed vocabulary (service names, Railway statuses) is the core's.
  if (parsed.data.report.kind === "deploy" && qaReleaseDeployObservation(parsed.data.report.observation) === null) return null;
  return parsed.data;
};

/** The body, at most 4 KiB, parsed; null when unreadable. */
async function readBody(request: Request): Promise<unknown> {
  const text = await request.text().catch(() => null);
  if (text === null || text.length > 4 * 1024) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const REVISION = /^[1-9][0-9]{0,8}$/;

/** Authentication, then the revision the caller carries (null when absent or malformed). */
function authenticate(request: Request, env: Readonly<Record<string, string | undefined>>) {
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  if (!isQaReleaseRouteSecret("mergeLane", bearer, env)) return null;
  const header = request.headers.get(QA_RELEASE_CONTROL_REVISION_HEADER) ?? "";
  return { callerRevision: REVISION.test(header) ? Number(header) : null };
}

async function guarded(run: () => Promise<QaReleaseMergeLaneAnswer>): Promise<QaReleaseMergeLaneAnswer> {
  try {
    return await run();
  } catch (error) {
    // A late round is recorded as nothing; anything else is unknown, and the
    // service reports it as such rather than retrying blindly (section 3).
    if (error instanceof QaReleaseMergeLaneLate) return answer(503, { error: "deadline_passed" });
    return answer(500, { error: "internal_error" });
  }
}

type Env = Readonly<Record<string, string | undefined>>;

export async function handleQaReleaseMergeInstruction(request: Request, env: Env = process.env, clock: () => number = Date.now) {
  const startedAt = clock();
  const auth = authenticate(request, env);
  if (!auth) return answer(401, { error: "unauthorized" });
  const parsed = issueBody.safeParse(await readBody(request));
  if (!parsed.success) return answer(400, { error: "invalid_request" });
  return guarded(async () => {
    const result = await issueQaReleaseMergeInstruction({
      callerRevision: auth.callerRevision,
      pullRequest: { number: parsed.data.pullRequestNumber, headSha: parsed.data.headSha },
      budget: { startedAt, budgetMs: QA_RELEASE_MERGE_LANE_CALL_BUDGET_MS, clock },
    });
    return result.issued
      ? answer(200, { ...result, expiresAt: result.expiresAt.toISOString() })
      : answer(409, { issued: false, reason: result.reason });
  });
}

export async function handleQaReleaseMergeConsume(request: Request, env: Env = process.env, clock: () => number = Date.now) {
  const startedAt = clock();
  const auth = authenticate(request, env);
  if (!auth) return answer(401, { error: "unauthorized" });
  const parsed = consumeBody.safeParse(await readBody(request));
  if (!parsed.success) return answer(400, { error: "invalid_request" });
  return guarded(async () => {
    const result = await consumeQaReleaseMergeInstruction({
      callerRevision: auth.callerRevision,
      request: parsed.data,
      budget: { startedAt, budgetMs: QA_RELEASE_MERGE_LANE_CALL_BUDGET_MS, clock },
    });
    return result.consumed ? answer(200, { consumed: true }) : answer(409, { consumed: false, reason: result.reason });
  });
}

export async function handleQaReleaseMergeReport(request: Request, env: Env = process.env, clock: () => number = Date.now) {
  const startedAt = clock();
  const auth = authenticate(request, env);
  if (!auth) return answer(401, { error: "unauthorized" });
  const body = parseReport(await readBody(request));
  if (!body) return answer(400, { error: "invalid_request" });
  return guarded(async () => {
    const result = await reportQaReleaseMergeResult({
      callerRevision: auth.callerRevision,
      attemptId: body.attemptId,
      report: body.report,
      budget: { startedAt, budgetMs: QA_RELEASE_MERGE_LANE_CALL_BUDGET_MS, clock },
    });
    return result.recorded ? answer(200, { ...result }) : answer(409, { recorded: false, reason: result.reason });
  });
}

/**
 * The lane's state for the start of a round: whether it is latched and the
 * attempt it holds, on the database clock. A read with no write, so it needs
 * no revision -- the calls that write judge the revision themselves.
 */
export async function handleQaReleaseMergeLaneState(request: Request, env: Env = process.env) {
  const auth = authenticate(request, env);
  if (!auth) return answer(401, { error: "unauthorized" });
  return guarded(async () => answer(200, { ...(await readQaReleaseMergeLaneState()) }));
}
