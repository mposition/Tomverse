export const dynamic = "force-dynamic";

import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV,
  isAmuxV4AnalysisAgentAuthorized } from "@/lib/amux/ideaAnalysisQueueCore";
import { AmuxSessionAnalysisStopReadError,
  readAmuxSessionAnalysisStopState } from
  "@/lib/amux/ideaSessionAnalysisStopRead";
import { prisma } from "@/lib/prisma";

const READ_ENV = "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_STOP_POLL_READ";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request): Promise<Response> {
  if (!isAmuxV4AnalysisAgentAuthorized(request,
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (process.env[READ_ENV] !== "enabled") {
    return amuxJsonNoStore({ error: "session_analysis_stop_poll_disabled" }, 409);
  }
  const params = new URL(request.url).searchParams;
  const claimId = params.get("claimId");
  const reservationId = params.get("reservationId");
  const ideaId = params.get("ideaId");
  if (params.size !== 3 || params.getAll("claimId").length !== 1 ||
      params.getAll("reservationId").length !== 1 ||
      params.getAll("ideaId").length !== 1 ||
      !claimId || !reservationId || !ideaId || !UUID.test(claimId) ||
      !UUID.test(reservationId) || !UUID.test(ideaId)) {
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  }
  try {
    const state = await prisma.$transaction((tx) =>
      readAmuxSessionAnalysisStopState(tx, claimId, reservationId, ideaId),
    { maxWait: 5_000, timeout: 10_000 });
    return amuxJsonNoStore(state);
  } catch (error) {
    if (error instanceof AmuxSessionAnalysisStopReadError) {
      return amuxJsonNoStore({ error: error.code },
        error.code === "not_found" ? 404 : 503);
    }
    return amuxJsonNoStore({ error: "session_analysis_stop_poll_unavailable" }, 503);
  }
}
