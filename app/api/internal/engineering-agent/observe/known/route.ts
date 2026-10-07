export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { engineeringAgentAmuxAdapterPermittedNow } from "@/lib/engineeringAgentAmuxAdapter";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
} from "@/lib/engineeringAgentRouteAuth";
import { readEngineeringAgentKnownPublishes } from "@/lib/engineeringAgentStore";
import { prisma } from "@/lib/prisma";

// What the agent itself may have put on GitHub (docs/policy/engineering-agent.md
// §12): run ids whose publish consumed a capability and the pull request
// numbers the app bound. Identifiers only. The runner compares its own
// read-only view of the agent's namespace with this; anything outside it is
// an unbound pull request or ref. Read-only.

const requestSchema = z.object({}).strict();

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "runner")) return engineeringAgentUnauthorized();
  if (!(await engineeringAgentAmuxAdapterPermittedNow())) return engineeringAgentJson({ refused: "adapter_closed" }, 409);
  try {
    await readLimitedJson(request, 64, requestSchema);
    return engineeringAgentJson(await readEngineeringAgentKnownPublishes(prisma), 200);
  } catch (error) {
    return engineeringAgentErrorResponse("observe_known", error);
  }
}
