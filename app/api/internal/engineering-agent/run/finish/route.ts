export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { AMUX_MAX_EXPECTED_REVISION, AMUX_PRISMA_INT_MAX } from "@/lib/amux/claimContract";
import { withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import {
  ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
  finishEngineeringAgentRun,
  engineeringAgentAmuxAdapterPermittedNow,
} from "@/lib/engineeringAgentAmuxAdapter";
import { RUNNER_REPORTABLE_HALTS, RUNNER_REPORTABLE_OUTCOMES, isRunId } from "@/lib/engineeringAgentCore";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
  runAttachedIdempotentEngineeringAgentRequest,
} from "@/lib/engineeringAgentRouteAuth";

// The runner ends its run (docs/policy/engineering-agent.md §11). It names the
// run's outcome; the adapter maps that to the AMUX settlement from the core's
// one table, so the runner never chooses an AMUX status and never `done`. The
// attempt settles and the run ends in one AMUX transaction, or neither.

const requestSchema = z
  .object({
    requestKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    instanceId: z.string().uuid(),
    generation: z.number().int().min(1).max(AMUX_PRISMA_INT_MAX),
    runId: z.string().refine(isRunId),
    attemptId: z.string().uuid(),
    taskRevision: z.number().int().min(0).max(AMUX_MAX_EXPECTED_REVISION),
    // `abandoned` is recovery's; `private_result` requires v22 result proof.
    outcome: z.enum(RUNNER_REPORTABLE_OUTCOMES),
    // What only the runner can see; the app adds the circuit and mismatches.
    halt: z.enum(RUNNER_REPORTABLE_HALTS),
    // The run's model spend in micro-USD as the provider reported it; null when
    // it is not known, which records nothing rather than a zero.
    usageMicrousd: z.string().regex(/^(0|[1-9][0-9]{0,14})$/).nullable(),
  })
  .strict();

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "runner")) return engineeringAgentUnauthorized();
  if (!(await engineeringAgentAmuxAdapterPermittedNow())) return engineeringAgentJson({ refused: "adapter_closed" }, 409);
  try {
    const body = await readLimitedJson(request, 2048, requestSchema);
    const outcome = await runAttachedIdempotentEngineeringAgentRequest({
      route: "run/finish",
      requestKey: body.requestKey,
      body,
      work: (markCommitted) =>
        withAmuxRouteBudget(
          () =>
            finishEngineeringAgentRun({
              lease: { instanceId: body.instanceId, generation: body.generation },
              runId: body.runId,
              attemptId: body.attemptId,
              taskRevision: body.taskRevision,
              outcome: body.outcome,
              halt: body.halt,
              usageMicrousd: body.usageMicrousd === null ? null : BigInt(body.usageMicrousd),
              markCommitted,
            }),
          ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
        ),
    });
    if (outcome.kind === "conflict") return engineeringAgentJson({ error: "request_key_reused" }, 409);
    if (outcome.kind === "replay") return engineeringAgentJson({ replayed: true, state: outcome.state, resultRef: outcome.resultRef }, 200);
    // AMUX fenced the settlement out before anything of ours was written.
    if (outcome.kind === "not_committed") return engineeringAgentJson(outcome.value, 409);
    return engineeringAgentJson(outcome.value, 200);
  } catch (error) {
    return engineeringAgentErrorResponse("run_finish", error);
  }
}
