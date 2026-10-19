export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV,
  AMUX_V4_ANALYSIS_QUEUE_READ_ENV, amuxV4AnalysisQueueReadEnabled,
  isAmuxV4AnalysisAgentAuthorized } from "@/lib/amux/ideaAnalysisQueueCore";
import { AMUX_V19_MAX_LAUNCHER_SECRET_ENV,
  isAmuxV19MaxLauncherAuthorized } from
  "@/lib/amux/ideaSessionMaxLauncherAuth";
import { AMUX_SESSION_INTAKE_ENV } from "@/lib/amux/ideaSessionSubmissionCore";
import { parseAmuxSessionAnalysisQueueCursor } from
  "@/lib/amux/ideaSessionAnalysisQueueCursorCore";
import { listAmuxSessionAnalysisCandidates } from
  "@/lib/amux/ideaSessionAnalysisQueueService";

const READ_ENV = "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_QUEUE_READ";
const MAX_READ_ENV = "TOMVERSE_AMUX_V19_MAX_ANALYSIS_QUEUE_READ";
const queueRequest = z.object({ after: z.string().max(512).optional() }).strict();

/** Agent-only metadata poll. Submission, v4 analysis and this bridge each
 * retain an independent default-off operating switch. */
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
  if (process.env[READ_ENV] !== "enabled" ||
      process.env[AMUX_SESSION_INTAKE_ENV] !== "enabled" ||
      !amuxV4AnalysisQueueReadEnabled(process.env[AMUX_V4_ANALYSIS_QUEUE_READ_ENV]) ||
      (maxAuthorized && process.env[MAX_READ_ENV] !== "enabled")) {
    return amuxJsonNoStore({ available: false,
      reason: "session_analysis_queue_disabled" }, 409);
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
