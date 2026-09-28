export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import {
  ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
  recordEngineeringAgentPublisherResult,
} from "@/lib/engineeringAgentAmuxAdapter";
import type { WriteResultOutcome } from "@/lib/engineeringAgentCore";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
  runAttachedIdempotentEngineeringAgentRequest,
} from "@/lib/engineeringAgentRouteAuth";
import { engineeringAgentBindingSnapshotSchema } from "@/lib/engineeringAgentStore";

// The publisher reports what happened to the item it claimed
// (docs/policy/engineering-agent.md §10, §11). The settlement is the core's
// to pick from the outcome; a result that published carries the pull request,
// which is bound in the same transaction and recorded on the card for its
// review. Every outcome is recorded, whatever the switches say: it already
// happened.

const OUTCOMES = [
  "confirmed",
  "refused_before_write",
  "revalidation_refused",
  "write_rejected",
  "pr_create_rejected",
  "lookup_no_prior_write",
  "lookup_found_result",
  "lookup_impossible",
] as const satisfies readonly WriteResultOutcome[];

const sha1 = z.string().regex(/^[0-9a-f]{40}$/);

const requestSchema = z
  .object({
    requestKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    workItemId: z.string().uuid(),
    fencingToken: z.string().regex(/^[1-9][0-9]{0,18}$/),
    outcome: z.enum(OUTCOMES),
    reason: z.string().regex(/^[a-z_]{1,64}$/).optional(),
    pullRequest: z
      .object({
        prNumber: z.number().int().positive().max(2_147_483_647),
        headSha: sha1,
        verifiedHeadSha: sha1,
        snapshot: engineeringAgentBindingSnapshotSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "publisher")) return engineeringAgentUnauthorized();
  try {
    const body = await readLimitedJson(request, 8 * 1024, requestSchema);
    const outcome = await runAttachedIdempotentEngineeringAgentRequest({
      route: "publish/result",
      requestKey: body.requestKey,
      body,
      work: (markCommitted) =>
        withAmuxRouteBudget(
          () =>
            recordEngineeringAgentPublisherResult({
              workItemId: body.workItemId,
              fencingToken: BigInt(body.fencingToken),
              outcome: body.outcome,
              reason: body.reason,
              pullRequest: body.pullRequest,
              markCommitted,
            }),
          ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
        ),
    });
    if (outcome.kind === "conflict") return engineeringAgentJson({ error: "request_key_reused" }, 409);
    if (outcome.kind === "replay") return engineeringAgentJson({ replayed: true, state: outcome.state, resultRef: outcome.resultRef }, 200);
    // Nothing of ours was written: the result was not recorded, and the
    // claim's lease will pass into a lookup.
    if (outcome.kind === "not_committed") return engineeringAgentJson({ recorded: false }, 409);
    return engineeringAgentJson(outcome.value, 200);
  } catch (error) {
    return engineeringAgentErrorResponse("publish_result", error);
  }
}
