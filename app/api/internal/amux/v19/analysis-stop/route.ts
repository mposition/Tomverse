export const dynamic = "force-dynamic";

import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV,
  isAmuxV4AnalysisAgentAuthorized } from "@/lib/amux/ideaAnalysisQueueCore";
import { AmuxIdeaAnalysisWorkerStopReadError,
  readAmuxIdeaAnalysisWorkerStopState } from
  "@/lib/amux/ideaAnalysisWorkerStopRead";
import { prisma } from "@/lib/prisma";

const ID = /^[A-Za-z0-9:_-]{1,128}$/;

export async function GET(request: Request): Promise<Response> {
  if (!isAmuxV4AnalysisAgentAuthorized(request,
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  const params = new URL(request.url).searchParams;
  const holdId = params.get("holdId");
  if (params.size !== 1 || params.getAll("holdId").length !== 1 ||
      !holdId || !ID.test(holdId)) {
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  }
  try {
    const state = await prisma.$transaction((tx) =>
      readAmuxIdeaAnalysisWorkerStopState(tx, holdId),
    { maxWait: 5_000, timeout: 10_000 });
    return amuxJsonNoStore(state);
  } catch (error) {
    if (error instanceof AmuxIdeaAnalysisWorkerStopReadError) {
      return amuxJsonNoStore({ error: error.code },
        error.code === "not_found" ? 404 : 503);
    }
    return amuxJsonNoStore({ error: "analysis_stop_poll_unavailable" }, 503);
  }
}
