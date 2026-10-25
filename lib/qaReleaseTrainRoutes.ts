import "server-only";

import { z } from "zod";

import { QA_RELEASE_CONTROL_REVISION_HEADER, isQaReleaseRouteSecret } from "@/lib/qaReleaseRouteAuthCore";
import { QA_RELEASE_TRAIN_MAX_PREDECESSORS } from "@/lib/qaReleaseTrainCore";
import { admitQaReleaseTrain, readQaReleaseTrainSelection, recordQaReleaseTrainSchedule, reportQaReleaseTrain } from "@/lib/qaReleaseTrainStore";

/**
 * The release train's app call (docs/policy/qa-release-agent.md section 8 item
 * 12): tell the departure hours it runs on, read the cargo the operator
 * picked, admit a departure, or report what it did. Authenticated by the merge
 * lane's own secret, with the revision the service carries.
 */
const SLOT = z.string().regex(/^\d{8}-\d{4}$/);
const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const PR = z.number().int().positive().max(1_000_000_000);

const body = z.union([
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
  z.object({ phase: z.literal("admit"), slot: SLOT, emergency: z.literal(true).optional() }).strict(),
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
              outcome: z.enum(["included", "already_in_main", "conflict", "over_capacity", "changes_workflows"]),
              predecessors: z.array(PR).max(QA_RELEASE_TRAIN_MAX_PREDECESSORS).optional(),
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
  if (text === null || text.length > 16 * 1024) return { status: 400, body: { error: "invalid_request" } };
  let parsed;
  try {
    parsed = body.safeParse(JSON.parse(text));
  } catch {
    return { status: 400, body: { error: "invalid_request" } };
  }
  if (!parsed.success) return { status: 400, body: { error: "invalid_request" } };
  const input = parsed.data;
  try {
    if (input.phase === "schedule") {
      // Display only (Admin's next train): no revision check, no audit row.
      await recordQaReleaseTrainSchedule(input.hours);
      return { status: 200, body: { recorded: true } };
    }
    if (input.phase === "selection") {
      // Read only: the numbers the next scheduled train carries, and an
      // emergency request's numbers when one is waiting, both picked in Admin.
      const next = await readQaReleaseTrainSelection();
      return { status: 200, body: { numbers: next.numbers, emergency: next.emergency.pending?.numbers ?? null } };
    }
    if (input.phase === "admit") {
      const result = await admitQaReleaseTrain({ callerRevision, slot: input.slot, emergency: input.emergency === true });
      return result.admitted ? { status: 200, body: result } : { status: 409, body: result };
    }
    const report = { slot: input.slot, outcome: input.outcome, pullRequestNumber: input.pullRequestNumber, branch: input.branch, rcSha: input.rcSha, failure: input.failure, picks: input.picks };
    return { status: 200, body: await reportQaReleaseTrain({ callerRevision, report }) };
  } catch {
    return { status: 500, body: { error: "internal_error" } };
  }
}
