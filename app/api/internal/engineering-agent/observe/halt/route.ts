export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { engineeringAgentAmuxAdapterPermittedNow } from "@/lib/engineeringAgentAmuxAdapter";
import { OBSERVABLE_HALTS, parseObservedHaltSubject } from "@/lib/engineeringAgentCore";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
} from "@/lib/engineeringAgentRouteAuth";
import {
  clearEngineeringAgentObservedHalt,
  recordEngineeringAgentObservedHalt,
  runEngineeringAgentTransaction,
} from "@/lib/engineeringAgentStore";
import { prisma } from "@/lib/prisma";

// The runner saw a branch or pull request under the agent's namespace that
// nothing the agent did accounts for (docs/policy/engineering-agent.md §12).
// Recorded as a reading with the database's clock, naming the pull request or
// branch; it halts claims, runs and pushes until a person acknowledges it or
// -- owner decision 2026-11-15 -- the runner's later reading finds nothing
// unbound (`none`), which clears it (a no-op when nothing holds, and with
// ENGINEERING_AGENT_LEGACY_HALTS). Only these values: a circuit or a mismatch
// is the app's to read, never a service's to assert.

const subjectSchema = z.union([
  z.object({ prNumber: z.number().int().positive().max(2_147_483_647) }).strict(),
  z.object({ ref: z.string().min(1).max(220) }).strict(),
]);
const requestSchema = z.union([
  z.object({ halt: z.enum(OBSERVABLE_HALTS), subject: subjectSchema.optional() }).strict(),
  z.object({ halt: z.literal("none") }).strict(),
]);

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "runner")) return engineeringAgentUnauthorized();
  if (!(await engineeringAgentAmuxAdapterPermittedNow())) return engineeringAgentJson({ refused: "adapter_closed" }, 409);
  try {
    const body = await readLimitedJson(request, 512, requestSchema);
    if (body.halt === "none") {
      const cleared = await runEngineeringAgentTransaction(prisma, (tx) => clearEngineeringAgentObservedHalt(tx));
      return engineeringAgentJson({ cleared: cleared.cleared }, 200);
    }
    const subject = "subject" in body && body.subject ? parseObservedHaltSubject(body.subject) : null;
    const recorded = await runEngineeringAgentTransaction(prisma, (tx) =>
      recordEngineeringAgentObservedHalt(tx, { halt: body.halt, subject }),
    );
    return engineeringAgentJson({ recorded: true, observedAt: recorded.observedAt.toISOString() }, 200);
  } catch (error) {
    return engineeringAgentErrorResponse("observe_halt", error);
  }
}
