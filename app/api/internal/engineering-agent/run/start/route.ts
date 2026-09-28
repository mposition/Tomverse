export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { AMUX_MAX_EXPECTED_REVISION, AMUX_PRISMA_INT_MAX, amuxMachineIdSchema } from "@/lib/amux/claimContract";
import { AMUX_LIFECYCLE_ROUTE_BUDGET_MS, withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import { isEngineeringAgentAmuxAdapterOpen, startEngineeringAgentRun } from "@/lib/engineeringAgentAmuxAdapter";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
  runAttachedIdempotentEngineeringAgentRequest,
} from "@/lib/engineeringAgentRouteAuth";

// The runner starts work on a card it owns (docs/policy/engineering-agent.md
// §8, §11): the AMUX attempt and the engineering run are created in one
// transaction, the AMUX writer's. The worker is the adapter's constant; the
// body carries only the worker lease it registered with.

const requestSchema = z
  .object({
    requestKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    instanceId: z.string().uuid(),
    generation: z.number().int().min(1).max(AMUX_PRISMA_INT_MAX),
    taskId: amuxMachineIdSchema,
    expectedRevision: z.number().int().min(0).max(AMUX_MAX_EXPECTED_REVISION),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "runner")) return engineeringAgentUnauthorized();
  if (!isEngineeringAgentAmuxAdapterOpen()) return engineeringAgentJson({ refused: "adapter_closed" }, 409);
  try {
    const body = await readLimitedJson(request, 2048, requestSchema);
    const outcome = await runAttachedIdempotentEngineeringAgentRequest({
      route: "run/start",
      requestKey: body.requestKey,
      body,
      work: (markCommitted) =>
        withAmuxRouteBudget(
          () =>
            startEngineeringAgentRun({
              lease: { instanceId: body.instanceId, generation: body.generation },
              taskId: body.taskId,
              expectedRevision: body.expectedRevision,
              baseSha: body.baseSha,
              markCommitted,
            }),
          AMUX_LIFECYCLE_ROUTE_BUDGET_MS,
        ),
    });
    if (outcome.kind === "conflict") return engineeringAgentJson({ error: "request_key_reused" }, 409);
    if (outcome.kind === "replay") return engineeringAgentJson({ replayed: true, state: outcome.state }, 200);
    // AMUX refused before anything of ours was written.
    if (outcome.kind === "not_committed") return engineeringAgentJson(outcome.value, 409);
    return engineeringAgentJson(outcome.value, 200);
  } catch (error) {
    return engineeringAgentErrorResponse("run_start", error);
  }
}
