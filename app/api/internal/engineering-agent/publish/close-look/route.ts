export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { readEngineeringAgentSupersededReviewDrafts } from "@/lib/engineeringAgentStore";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
} from "@/lib/engineeringAgentRouteAuth";
import { prisma } from "@/lib/prisma";

// The last look before the publisher closes a review draft (owner decision
// 2026-11-23, docs/policy/engineering-agent.md §3). The claim named it; this
// reads the same list again just before the close, so a switch turned off, a
// halt, or a draft that is no longer one to close (its replacement closed, an
// approval observed, its card closed) stops it. It only reads, and writes
// nothing: it can refuse, and it cannot allow anything the claim did not name.

const requestSchema = z
  .object({
    prNumber: z.number().int().positive().max(2_147_483_647),
    runId: z.string().regex(/^[0-9]{1,12}$/),
  })
  .strict();

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "publisher")) return engineeringAgentUnauthorized();
  try {
    const body = await readLimitedJson(request, 256, requestSchema);
    const drafts = await readEngineeringAgentSupersededReviewDrafts(prisma);
    const named = drafts.some((draft) => draft.prNumber === body.prNumber && draft.runId === body.runId);
    return engineeringAgentJson({ verdict: named ? "no_objection" : "objection" }, 200);
  } catch (error) {
    return engineeringAgentErrorResponse("publish_close_look", error);
  }
}
