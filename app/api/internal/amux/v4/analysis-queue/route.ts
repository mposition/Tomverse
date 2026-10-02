export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import {
  AMUX_V4_ANALYSIS_AGENT_SECRET_ENV,
  AMUX_V4_ANALYSIS_QUEUE_READ_ENV,
  amuxV4AnalysisQueueReadEnabled,
  isAmuxV4AnalysisAgentAuthorized,
} from "@/lib/amux/ideaAnalysisQueueCore";
import { listAmuxV4AnalysisCandidates } from "@/lib/amux/ideaAnalysisQueueService";

const emptyRequest = z.object({}).strict();

/** Metadata-only polling route. It does not claim a receipt or return text. */
export async function POST(request: Request): Promise<Response> {
  if (!isAmuxV4AnalysisAgentAuthorized(request,
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV])) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!amuxV4AnalysisQueueReadEnabled(process.env[AMUX_V4_ANALYSIS_QUEUE_READ_ENV])) {
    return amuxJsonNoStore({ available: false, reason: "analysis_queue_disabled" }, 409);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  }
  try {
    await readLimitedJson(request, 1_024, emptyRequest);
  } catch {
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  }
  try {
    return amuxJsonNoStore(await listAmuxV4AnalysisCandidates());
  } catch {
    return amuxJsonNoStore({ error: "Analysis queue unavailable." }, 503);
  }
}
