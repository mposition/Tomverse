export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV } from
  "@/lib/amux/ideaAnalysisQueueCore";
import { AMUX_V19_MAX_LAUNCHER_SECRET_ENV,
  isAmuxV19MaxLauncherAuthorized } from
  "@/lib/amux/ideaSessionMaxLauncherAuth";
import { readAmuxV19MaxIdea } from
  "@/lib/amux/ideaSessionMaxIdeaRead";

const READ_ENV = "TOMVERSE_AMUX_V19_SESSION_MAX_IDEA_READ";
const bodySchema = z.object({ reservationId: z.string().uuid(),
  ideaId: z.string().uuid(), claimId: z.string().uuid() }).strict();

/** Plaintext is released only to the dedicated Max launcher after its exact
 * budget claim; this route stays disabled until the live flow is validated. */
export async function POST(request: Request): Promise<Response> {
  if (!isAmuxV19MaxLauncherAuthorized(request,
    process.env[AMUX_V19_MAX_LAUNCHER_SECRET_ENV],
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (process.env[READ_ENV] !== "enabled") {
    return amuxJsonNoStore({ available: false,
      reason: "session_max_idea_read_disabled" }, 409);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  }
  let body: z.infer<typeof bodySchema>;
  try { body = await readLimitedJson(request, 1_024, bodySchema); }
  catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
  try {
    const idea = await readAmuxV19MaxIdea(body);
    return idea ? amuxJsonNoStore(idea) :
      amuxJsonNoStore({ error: "not_ready" }, 409);
  } catch {
    return amuxJsonNoStore({ error: "unavailable" }, 503);
  }
}
