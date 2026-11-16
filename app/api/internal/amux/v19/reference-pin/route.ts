export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV,
  isAmuxV4AnalysisAgentAuthorized } from "@/lib/amux/ideaAnalysisQueueCore";
import { readAmuxSessionReferencePin } from
  "@/lib/amux/ideaSessionReferencePinRead";

const bodySchema = z.object({ reservationId: z.string().uuid(),
  ideaId: z.string().uuid(),
  referenceOrdinal: z.number().int().safe().min(0).max(2_147_483_647),
  claimId: z.string().uuid().optional() }).strict();

/** Agent-only, content-free preflight. An in-flight worker must present its
 * exact claim; a pre-claim worker may read only a queue-eligible reservation. */
export async function POST(request: Request): Promise<Response> {
  if (!isAmuxV4AnalysisAgentAuthorized(request,
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  }
  let body: z.infer<typeof bodySchema>;
  try { body = await readLimitedJson(request, 1_024, bodySchema); }
  catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
  try {
    const pin = await readAmuxSessionReferencePin(body);
    return pin ? amuxJsonNoStore(pin) :
      amuxJsonNoStore({ error: "not_ready" }, 409);
  } catch {
    return amuxJsonNoStore({ error: "reference_pin_unavailable" }, 503);
  }
}
