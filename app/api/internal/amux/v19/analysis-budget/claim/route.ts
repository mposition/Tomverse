export const dynamic = "force-dynamic";

import { z } from "zod";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV,
  isAmuxV4AnalysisAgentAuthorized } from "@/lib/amux/ideaAnalysisQueueCore";
import { readAmuxSessionBudgetClaimReceipt } from
  "@/lib/amux/ideaSessionAnalysisBudgetClaimService";
import { prisma } from "@/lib/prisma";

const READ_ENV = "TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_READ";
const uuid = z.string().uuid();
const identity = z.object({ requestId: uuid, reservationId: uuid,
  invocationOrdinal: z.number().int().safe().nonnegative() }).strict();

/** An unknown claim is checked once by exact request/reservation/ordinal.
 * Even an absent receipt never authorizes replay of its POST. Readback stays
 * available when claim writes are disabled for operator reconciliation. */
export async function GET(request: Request): Promise<Response> {
  if (!isAmuxV4AnalysisAgentAuthorized(request,
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (process.env[READ_ENV] !== "enabled") {
    return amuxJsonNoStore({ available: false,
      reason: "session_budget_claim_read_disabled" }, 409);
  }
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].length !== 3 ||
      ["requestId", "reservationId", "invocationOrdinal"].some((key) =>
        url.searchParams.getAll(key).length !== 1)) {
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  }
  const ordinal = url.searchParams.get("invocationOrdinal");
  const parsed = identity.safeParse({
    requestId: url.searchParams.get("requestId"),
    reservationId: url.searchParams.get("reservationId"),
    invocationOrdinal: ordinal !== null && /^(0|[1-9][0-9]*)$/.test(ordinal)
      ? Number(ordinal) : -1,
  });
  if (!parsed.success) return amuxJsonNoStore({ error: "Invalid request." }, 400);
  try {
    const receipt = await prisma.$transaction((tx) =>
      readAmuxSessionBudgetClaimReceipt(tx, parsed.data),
    { maxWait: 5_000, timeout: 10_000 });
    return amuxJsonNoStore(receipt);
  } catch {
    return amuxJsonNoStore({ error: "outcome_unknown" }, 503);
  }
}
