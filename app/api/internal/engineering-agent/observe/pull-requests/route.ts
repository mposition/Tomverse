export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { engineeringAgentAmuxAdapterPermittedNow } from "@/lib/engineeringAgentAmuxAdapter";
import { observeEngineeringAgentPullRequests } from "@/lib/engineeringAgentPrObserver";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
} from "@/lib/engineeringAgentRouteAuth";

// One round of the approval observer (docs/policy/engineering-agent.md §9-10).
// The runner triggers it; the app reads GitHub with its own read-only token
// and decides. Nothing the caller sends is evidence: the body is empty. The
// answer is binding ids and outcomes only.

const requestSchema = z.object({}).strict();

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "runner")) return engineeringAgentUnauthorized();
  if (!(await engineeringAgentAmuxAdapterPermittedNow())) return engineeringAgentJson({ refused: "adapter_closed" }, 409);
  try {
    await readLimitedJson(request, 64, requestSchema);
    return engineeringAgentJson({ observed: await observeEngineeringAgentPullRequests() }, 200);
  } catch (error) {
    return engineeringAgentErrorResponse("observe_pull_requests", error);
  }
}
