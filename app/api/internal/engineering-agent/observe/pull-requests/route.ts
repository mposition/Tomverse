export const dynamic = "force-dynamic";

import { z } from "zod";

import { observeAmuxIdeaLaneMerges } from "@/lib/amux/ideaLaneService";
import { publishAmuxV22KeptResults } from "@/lib/amux/v22KeptResultPublication";
import { readLimitedJson } from "@/lib/apiSecurity";
import { engineeringAgentAmuxAdapterPermittedNow } from "@/lib/engineeringAgentAmuxAdapter";
import { releaseEngineeringAgentBindings } from "@/lib/engineeringAgentBindingRelease";
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
// answer is binding ids and outcomes only. The idea lane's draft PRs ride the
// same round: their observed merge settles the idea (ideaLaneService.ts). So
// do kept v22 results, put on their publication path once it can open
// (v22KeptResultPublication.ts); a failure there is its own, never this round's.

const requestSchema = z.object({}).strict();

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "runner")) return engineeringAgentUnauthorized();
  if (!(await engineeringAgentAmuxAdapterPermittedNow())) return engineeringAgentJson({ refused: "adapter_closed" }, 409);
  try {
    await readLimitedJson(request, 64, requestSchema);
    const observed = await observeEngineeringAgentPullRequests();
    const unreadable = observed.filter((entry) => entry.outcome === "unreadable");
    if (unreadable.length > 0) {
      // Codes and a count only. The round repeats; this is what says why it keeps deciding nothing.
      console.error(JSON.stringify({ event: "engineering_agent_pr_observe_unreadable",
        bindings: unreadable.length, codes: [...new Set(unreadable.map((entry) => entry.code ?? "unknown"))].sort() }));
    }
    // After the observer, so a merge it records this round is released too.
    const released = await releaseEngineeringAgentBindings();
    const lane = await observeAmuxIdeaLaneMerges();
    // After the release, so a slot it frees this round can take a kept result
    // (owner decision 2026-11-15: a successful result is published once it can be).
    const kept = await publishAmuxV22KeptResults();
    return engineeringAgentJson({ observed, released, lane, kept }, 200);
  } catch (error) {
    return engineeringAgentErrorResponse("observe_pull_requests", error);
  }
}
