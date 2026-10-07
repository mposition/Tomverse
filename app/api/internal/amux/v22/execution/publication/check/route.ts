export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { engineeringAgentV22CandidateSummary,
  loadEngineeringAgentV22StoredCandidate } from
  "@/lib/engineeringAgentV22StoredCandidate";

const schema = z.object({ attemptId: z.string().uuid() }).strict();

/** Content-free, read-only preflight. A verified tree is not a T1 verdict or
 * permission to queue a Publisher item; the policy and image gates are still
 * separate. No patch body or changed-file bytes leave this route. */
export async function POST(request: Request): Promise<Response> {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  let body: z.infer<typeof schema>;
  try { body = await readLimitedJson(request, 4 * 1024, schema); }
  catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
  try {
    const result = await loadEngineeringAgentV22StoredCandidate(
      body.attemptId);
    if (!result.ok) return amuxJsonNoStore({ verified: false,
      reason: result.reason }, 200);
    return amuxJsonNoStore(engineeringAgentV22CandidateSummary(result), 200);
  } catch {
    return amuxJsonNoStore({ verified: false,
      reason: "verification_unavailable" }, 503);
  }
}
