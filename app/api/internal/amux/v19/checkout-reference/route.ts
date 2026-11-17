export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV,
  isAmuxV4AnalysisAgentAuthorized } from "@/lib/amux/ideaAnalysisQueueCore";
import { readAmuxSessionCheckoutReference } from
  "@/lib/amux/ideaSessionCheckoutReferenceRead";
import { AMUX_V19_MAX_LAUNCHER_SECRET_ENV,
  isAmuxV19MaxLauncherAuthorized } from
  "@/lib/amux/ideaSessionMaxLauncherAuth";

const bodySchema = z.object({ reservationId: z.string().uuid(),
  ideaId: z.string().uuid(), claimId: z.string().uuid(),
  referenceOrdinal: z.number().int().safe().min(0).max(2_147_483_647) }).strict();

/** Agent-only lookup after a budget claim. It returns one sealed intake
 * reference's repository identity and canonical pin; no idea body or path. */
export async function POST(request: Request): Promise<Response> {
  const maxAuthorized = isAmuxV19MaxLauncherAuthorized(request,
    process.env[AMUX_V19_MAX_LAUNCHER_SECRET_ENV],
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET);
  if (!maxAuthorized && !isAmuxV4AnalysisAgentAuthorized(request,
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
    const reference = await readAmuxSessionCheckoutReference({ ...body,
      requiredBudgetMode: maxAuthorized ? "max_shadow" : "bounded" });
    return reference ? amuxJsonNoStore(reference) :
      amuxJsonNoStore({ error: "not_ready" }, 409);
  } catch {
    return amuxJsonNoStore({ error: "checkout_reference_unavailable" }, 503);
  }
}
