export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
  ENGINEERING_AGENT_PUBLISH_CLAIM_LEASE_MS,
  EngineeringAgentStoreRefusedError,
  claimNextEngineeringAgentPublishWork,
  currentEngineeringAgentHalt,
  readEngineeringAgentHaltState,
} from "@/lib/engineeringAgentStore";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
  runIdempotentEngineeringAgentRequest,
} from "@/lib/engineeringAgentRouteAuth";
import { prisma } from "@/lib/prisma";

// The publisher's claim (docs/policy/engineering-agent.md §11): the next
// lookup or, while publishing is allowed, the next queued publish item with a
// live capability, claimed with a new fencing token. A write claim consumes
// the capability in the same transaction. Nothing to do answers `work: null`.

const requestSchema = z
  .object({
    requestKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  })
  .strict();

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "publisher")) return engineeringAgentUnauthorized();
  try {
    const body = await readLimitedJson(request, 1024, requestSchema);
    const outcome = await runIdempotentEngineeringAgentRequest({
      route: "publish/claim",
      requestKey: body.requestKey,
      body,
      work: (tx) => claimNextEngineeringAgentPublishWork(tx, { leaseMs: ENGINEERING_AGENT_PUBLISH_CLAIM_LEASE_MS }),
      // A publisher that loses the answer learns which item it holds; the
      // claim's lease then passes and a lookup finds the work again (§10).
      resultRef: (work) => work?.workItemId ?? null,
    });
    if (outcome.kind === "conflict") return engineeringAgentJson({ error: "request_key_reused" }, 409);
    if (outcome.kind === "replay") return engineeringAgentJson({ replayed: true, state: outcome.state, resultRef: outcome.resultRef }, 200);
    // The halt beside the work, so a quiet round while halted is not reported
    // as a healthy one (§12). Lookups continue while halted.
    const halt = currentEngineeringAgentHalt(await readEngineeringAgentHaltState(prisma));
    return engineeringAgentJson({ work: outcome.value, halt }, 200);
  } catch (error) {
    // A switch that refuses the claim (mode off, frozen, kill switch) says
    // nothing about a halt, so the refusal carries it too: a quiet round is
    // live only while nothing halts (§12).
    if (error instanceof EngineeringAgentStoreRefusedError) {
      const halt = await readEngineeringAgentHaltState(prisma)
        .then(currentEngineeringAgentHalt)
        .catch(() => "unknown" as const);
      return engineeringAgentJson({ refused: error.code, halt }, 409);
    }
    return engineeringAgentErrorResponse("publish_claim", error);
  }
}
