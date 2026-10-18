export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV,
  AMUX_V4_ANALYSIS_QUEUE_READ_ENV, amuxV4AnalysisQueueReadEnabled,
  isAmuxV4AnalysisAgentAuthorized } from "@/lib/amux/ideaAnalysisQueueCore";
import { readAmuxSessionCheckoutReference } from
  "@/lib/amux/ideaSessionCheckoutReferenceRead";
import { AMUX_SESSION_INTAKE_ENV } from
  "@/lib/amux/ideaSessionSubmissionCore";

const READ_ENV = "TOMVERSE_AMUX_V19_CHECKOUT_REFERENCE_READ";
const QUEUE_READ_ENV = "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_QUEUE_READ";
const PIN_READ_ENV = "TOMVERSE_AMUX_V19_REFERENCE_PIN_READ";
const bodySchema = z.object({ reservationId: z.string().uuid(),
  ideaId: z.string().uuid(), claimId: z.string().uuid(),
  referenceOrdinal: z.number().int().safe().min(0).max(2_147_483_647) }).strict();

/** Agent-only lookup after a budget claim. It returns one sealed intake
 * reference's repository identity and canonical pin; no idea body or path. */
export async function POST(request: Request): Promise<Response> {
  if (!isAmuxV4AnalysisAgentAuthorized(request,
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (process.env[READ_ENV] !== "enabled" ||
      process.env[QUEUE_READ_ENV] !== "enabled" ||
      process.env[PIN_READ_ENV] !== "enabled" ||
      process.env[AMUX_SESSION_INTAKE_ENV] !== "enabled" ||
      !amuxV4AnalysisQueueReadEnabled(process.env[AMUX_V4_ANALYSIS_QUEUE_READ_ENV])) {
    return amuxJsonNoStore({ available: false,
      reason: "session_checkout_reference_read_disabled" }, 409);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  }
  let body: z.infer<typeof bodySchema>;
  try { body = await readLimitedJson(request, 1_024, bodySchema); }
  catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
  try {
    const reference = await readAmuxSessionCheckoutReference(body);
    return reference ? amuxJsonNoStore(reference) :
      amuxJsonNoStore({ error: "not_ready" }, 409);
  } catch {
    return amuxJsonNoStore({ error: "checkout_reference_unavailable" }, 503);
  }
}
