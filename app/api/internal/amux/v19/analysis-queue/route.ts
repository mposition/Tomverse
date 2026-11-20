export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV,
  isAmuxV4AnalysisAgentAuthorized } from "@/lib/amux/ideaAnalysisQueueCore";
import { AMUX_V19_MAX_LAUNCHER_SECRET_ENV,
  isAmuxV19MaxLauncherAuthorized } from
  "@/lib/amux/ideaSessionMaxLauncherAuth";
import { parseAmuxSessionAnalysisQueueCursor } from
  "@/lib/amux/ideaSessionAnalysisQueueCursorCore";
import { listAmuxSessionAnalysisCandidates } from
  "@/lib/amux/ideaSessionAnalysisQueueService";

const queueRequest = z.object({ after: z.string().max(512).optional() }).strict();

/** Agent-only metadata poll of the subscription analysis queue. */
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
  let cursor = null;
  try {
    const body = await readLimitedJson(request, 1_024, queueRequest);
    cursor = body.after === undefined ? null : parseAmuxSessionAnalysisQueueCursor(body.after);
    if (body.after !== undefined && cursor === null) {
      return amuxJsonNoStore({ error: "Invalid cursor." }, 400);
    }
  } catch {
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  }
  try {
    return amuxJsonNoStore(await listAmuxSessionAnalysisCandidates(cursor));
  } catch {
    return amuxJsonNoStore({ error: "Session analysis queue unavailable." }, 503);
  }
}
