export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { engineeringAgentAmuxAdapterPermittedNow } from "@/lib/engineeringAgentAmuxAdapter";
import { OBSERVABLE_HALTS } from "@/lib/engineeringAgentCore";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
} from "@/lib/engineeringAgentRouteAuth";
import { recordEngineeringAgentObservedHalt, runEngineeringAgentTransaction } from "@/lib/engineeringAgentStore";
import { prisma } from "@/lib/prisma";

// The runner saw a branch or pull request under the agent's namespace that
// nothing the agent did accounts for (docs/policy/engineering-agent.md §12).
// Recorded as a reading with the database's clock; it halts claims, runs and
// pushes until a person acknowledges it. Only these two values: a circuit or
// a mismatch is the app's to read, never a service's to assert.

const requestSchema = z.object({ halt: z.enum(OBSERVABLE_HALTS) }).strict();

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "runner")) return engineeringAgentUnauthorized();
  if (!(await engineeringAgentAmuxAdapterPermittedNow())) return engineeringAgentJson({ refused: "adapter_closed" }, 409);
  try {
    const body = await readLimitedJson(request, 128, requestSchema);
    const recorded = await runEngineeringAgentTransaction(prisma, (tx) =>
      recordEngineeringAgentObservedHalt(tx, { halt: body.halt }),
    );
    return engineeringAgentJson({ recorded: true, observedAt: recorded.observedAt.toISOString() }, 200);
  } catch (error) {
    return engineeringAgentErrorResponse("observe_halt", error);
  }
}
