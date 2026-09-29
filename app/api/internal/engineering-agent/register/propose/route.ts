export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { proposeEngineeringAgentRegistration } from "@/lib/engineeringAgentRegistration";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
  runAttachedIdempotentEngineeringAgentRequest,
} from "@/lib/engineeringAgentRouteAuth";

// One registration proposal (docs/policy/engineering-agent.md §2.2 steps 3
// and 4; docs/policy/amux-intake.md version 2). The app re-reads the source at
// the pinned revision, runs the guard, and only then registers a backlog card
// with this agent's record in one AMUX transaction. The proposal is data: its
// text is length- and content-scanned, never followed, and the card holds
// only its title and digests. An answer lost after the commit is read back
// once and never retried.

const requestSchema = z
  .object({
    requestKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    roundId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    source: z.enum(["S1", "S2", "S3"]),
    pinnedCommit: z.string().regex(/^[0-9a-f]{40}$/),
    // Shape and content are the guard's to judge; the route only bounds size.
    proposal: z.unknown(),
  })
  .strict();

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "runner")) return engineeringAgentUnauthorized();
  try {
    const body = await readLimitedJson(request, 16 * 1024, requestSchema);
    const outcome = await runAttachedIdempotentEngineeringAgentRequest({
      route: "register/propose",
      requestKey: body.requestKey,
      body,
      work: (markCommitted) =>
        proposeEngineeringAgentRegistration({
          roundId: body.roundId,
          source: body.source,
          pinnedCommit: body.pinnedCommit,
          proposal: body.proposal,
          markCommitted,
        }),
    });
    if (outcome.kind === "conflict") return engineeringAgentJson({ error: "request_key_reused" }, 409);
    if (outcome.kind === "replay") {
      return engineeringAgentJson({ replayed: true, state: outcome.state, resultRef: outcome.resultRef }, 200);
    }
    return engineeringAgentJson(outcome.value, outcome.kind === "done" && outcome.value.registered ? 200 : 409);
  } catch (error) {
    return engineeringAgentErrorResponse("register_propose", error);
  }
}
