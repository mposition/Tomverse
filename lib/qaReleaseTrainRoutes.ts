import "server-only";

import { z } from "zod";

import { QA_RELEASE_CONTROL_REVISION_HEADER, isQaReleaseRouteSecret } from "@/lib/qaReleaseRouteAuthCore";
import { QA_RELEASE_TRAIN_RESOLVE_WHY_CHARS } from "@/lib/qaReleaseTrainResolve";
import { qaReleaseTrainVerdictWanted } from "@/lib/qaReleaseTrainCargoCore";
import { readQaReleaseTrainCargoCandidates } from "@/lib/qaReleaseTrainCargoRead";
import {
  admitQaReleaseTrain,
  readQaReleaseTrainSelection,
  readQaReleaseTrainVerdicts,
  recordQaReleaseTrainSchedule,
  recordQaReleaseTrainVerdicts,
  reportQaReleaseTrain,
} from "@/lib/qaReleaseTrainStore";
import {
  QA_RELEASE_TRAIN_VERDICT_EVIDENCE_MAX,
  QA_RELEASE_TRAIN_VERDICT_FILES,
  QA_RELEASE_TRAIN_VERDICT_WHY_CHARS,
} from "@/lib/qaReleaseTrainVerdictCore";

/**
 * The release train's app call (docs/policy/qa-release-agent.md section 8 item
 * 12): tell the departure hours it runs on, read the cargo the operator
 * picked, admit a departure, or report what it did. Authenticated by the merge
 * lane's own secret, with the revision the service carries.
 */
const SLOT = z.string().regex(/^\d{8}-\d{4}$/);
const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const PR = z.number().int().positive().max(1_000_000_000);

const COUNT = z.number().int().min(0).max(10_000_000);
const AT = z.string().max(40).refine((value) => !Number.isNaN(Date.parse(value)));
const WHY = z.string().min(1).max(QA_RELEASE_TRAIN_VERDICT_WHY_CHARS);
const VERDICT = z
  .object({
    number: PR,
    content: z.discriminatedUnion("state", [
      z.object({ state: z.literal("on_main"), lines: COUNT }).strict(),
      z
        .object({
          state: z.literal("differs"),
          lines: COUNT,
          missing: COUNT,
          leftOnMain: COUNT,
          files: z.array(z.object({ path: z.string().min(1).max(512), lines: COUNT }).strict()).max(QA_RELEASE_TRAIN_VERDICT_FILES),
          fileCount: COUNT,
        })
        .strict(),
      z.object({ state: z.literal("unread") }).strict(),
    ]),
    mainSha: SHA.optional(),
    checkedAt: AT.optional(),
    gapDigest: z.string().regex(/^[0-9a-f]{32}$/).optional(),
    model: z
      .object({
        decision: z.enum(["release", "not_needed", "operator"]),
        why: z.object({ ko: WHY, en: WHY }).strict(),
        evidence: z.array(PR).max(QA_RELEASE_TRAIN_VERDICT_EVIDENCE_MAX),
      })
      .strict()
      .optional(),
    askedAt: AT.optional(),
  })
  .strict();

const body = z.union([
  z.object({ phase: z.literal("verdict_queue") }).strict(),
  z.object({ phase: z.literal("verdicts"), mainSha: SHA, at: AT, verdicts: z.array(VERDICT).max(500) }).strict(),
  z
    .object({
      phase: z.literal("schedule"),
      hours: z
        .array(z.number().int().min(0).max(23))
        .min(1)
        .max(24)
        .refine((hours) => new Set(hours).size === hours.length),
    })
    .strict(),
  z.object({ phase: z.literal("selection") }).strict(),
  z.object({ phase: z.literal("admit"), slot: SLOT, emergencyRequestId: z.string().min(1).max(64).optional() }).strict(),
  z
    .object({
      phase: z.literal("report"),
      slot: SLOT,
      outcome: z.enum(["opened", "empty", "failed"]),
      pullRequestNumber: PR.nullable(),
      branch: z.string().regex(/^release\/train-\d{8}-\d{4}$/).nullable(),
      rcSha: SHA.nullable(),
      failure: z.string().regex(/^[a-z_]{1,40}$/).nullable(),
      picks: z
        .array(
          z
            .object({
              number: PR,
              outcome: z.enum(["included", "already_in_main", "conflict", "over_capacity", "changes_workflows", "in_open_train"]),
              why: z.string().max(QA_RELEASE_TRAIN_RESOLVE_WHY_CHARS).optional(),
              // Sent by a train service from before model resolution (2026-10-28); not read.
              predecessors: z.array(PR).max(10).optional(),
              boardedFor: PR.optional(),
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
]);

type Answer = { status: number; body: Record<string, unknown> };
const REVISION = /^[1-9][0-9]{0,8}$/;

export async function handleQaReleaseTrain(request: Request, env: Readonly<Record<string, string | undefined>> = process.env): Promise<Answer> {
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  if (!isQaReleaseRouteSecret("mergeLane", bearer, env)) return { status: 401, body: { error: "unauthorized" } };
  const header = request.headers.get(QA_RELEASE_CONTROL_REVISION_HEADER) ?? "";
  const callerRevision = REVISION.test(header) ? Number(header) : null;

  const text = await request.text().catch(() => null);
  // The verdicts are the one large body (up to 500 candidates with two short
  // reasons each); every other phase keeps the 16 KiB limit below.
  if (text === null || text.length > 1024 * 1024) return { status: 400, body: { error: "invalid_request" } };
  let parsed;
  try {
    parsed = body.safeParse(JSON.parse(text));
  } catch {
    return { status: 400, body: { error: "invalid_request" } };
  }
  if (!parsed.success) return { status: 400, body: { error: "invalid_request" } };
  const input = parsed.data;
  if (input.phase !== "verdicts" && text.length > 16 * 1024) return { status: 400, body: { error: "invalid_request" } };
  try {
    if (input.phase === "schedule") {
      // Display only (Admin's next train): no revision check, no audit row.
      await recordQaReleaseTrainSchedule(input.hours);
      return { status: 200, body: { recorded: true } };
    }
    if (input.phase === "verdict_queue") {
      // Read only: what Admin lists as able to ride (or to release by hand),
      // before any verdict is applied, and the verdicts held now.
      const [read, stored] = await Promise.all([readQaReleaseTrainCargoCandidates(Date.now()), readQaReleaseTrainVerdicts()]);
      if (read.status !== "ok") return { status: 503, body: { error: "candidates_unread" } };
      const candidates = read.candidates
        .filter((candidate) => qaReleaseTrainVerdictWanted(candidate.status) && candidate.mergeCommitSha)
        .map((candidate) => ({
          number: candidate.number,
          title: candidate.title,
          mergeCommitSha: candidate.mergeCommitSha,
          mergedAt: candidate.mergedAt,
          mainPullRequest: candidate.status === "mentioned" ? candidate.mainPullRequest : null,
        }));
      return { status: 200, body: { candidates, stored } };
    }
    if (input.phase === "verdicts") {
      // Display only (Admin's next train): no revision check, no audit row.
      await recordQaReleaseTrainVerdicts({ mainSha: input.mainSha, at: input.at, verdicts: input.verdicts });
      return { status: 200, body: { recorded: true } };
    }
    if (input.phase === "selection") {
      // Read only: the numbers the next scheduled train carries, and an
      // emergency request's numbers when one is waiting, both picked in Admin.
      const next = await readQaReleaseTrainSelection();
      const pending = next.emergency.pending;
      return { status: 200, body: { numbers: next.numbers, emergency: pending ? { id: pending.id, numbers: pending.numbers } : null } };
    }
    if (input.phase === "admit") {
      const result = await admitQaReleaseTrain({ callerRevision, slot: input.slot, emergencyRequestId: input.emergencyRequestId });
      return result.admitted ? { status: 200, body: result } : { status: 409, body: result };
    }
    const report = { slot: input.slot, outcome: input.outcome, pullRequestNumber: input.pullRequestNumber, branch: input.branch, rcSha: input.rcSha, failure: input.failure, picks: input.picks };
    return { status: 200, body: await reportQaReleaseTrain({ callerRevision, report }) };
  } catch {
    return { status: 500, body: { error: "internal_error" } };
  }
}
