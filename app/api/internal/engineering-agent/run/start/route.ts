export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { AMUX_PRISMA_INT_MAX } from "@/lib/amux/claimContract";
import { withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import {
  ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
  engineeringAgentAmuxAdapterPermittedNow,
  startEngineeringAgentRun,
} from "@/lib/engineeringAgentAmuxAdapter";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
  runAttachedIdempotentEngineeringAgentRequest,
} from "@/lib/engineeringAgentRouteAuth";

// The runner starts work on the card AMUX assigned to it
// (docs/policy/engineering-agent.md §2.1, §8, §11): the AMUX attempt and the
// engineering run are created in one transaction, the AMUX writer's. The
// worker is the adapter's constant and the card is AMUX's choice; the body
// carries only the worker lease and the base commit the runner will read.

const requestSchema = z
  .object({
    requestKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    instanceId: z.string().uuid(),
    generation: z.number().int().min(1).max(AMUX_PRISMA_INT_MAX),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "runner")) return engineeringAgentUnauthorized();
  if (!(await engineeringAgentAmuxAdapterPermittedNow())) return engineeringAgentJson({ refused: "adapter_closed" }, 409);
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
              baseSha: body.baseSha,
              markCommitted,
            }),
          ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
        ),
    });
    if (outcome.kind === "conflict") return engineeringAgentJson({ error: "request_key_reused" }, 409);
    if (outcome.kind === "replay") return engineeringAgentJson({ replayed: true, state: outcome.state, resultRef: outcome.resultRef }, 200);
    // AMUX refused before anything of ours was written.
    if (outcome.kind === "not_committed") return engineeringAgentJson(outcome.value, 409);
    return engineeringAgentJson(outcome.value, 200);
  } catch (error) {
    return engineeringAgentErrorResponse("run_start", error);
  }
}
