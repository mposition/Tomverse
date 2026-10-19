export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV,
  isAmuxV4AnalysisAgentAuthorized } from "@/lib/amux/ideaAnalysisQueueCore";
import { AMUX_V19_MAX_LAUNCHER_SECRET_ENV,
  isAmuxV19MaxLauncherAuthorized } from
  "@/lib/amux/ideaSessionMaxLauncherAuth";
import { verifyAmuxV19MaxClaimAttestation } from
  "@/lib/amux/ideaSessionMaxLauncherAttestation.mjs";
import { AmuxSessionBudgetClaimError, commitAmuxSessionBudgetClaim,
  readAmuxSessionBudgetClaimReceipt } from
  "@/lib/amux/ideaSessionAnalysisBudgetClaimService";
import { prisma } from "@/lib/prisma";

const CLAIM_CODE_LATCH = true;
const WRITE_ENV = "TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_WRITE";
const READ_ENV = "TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_READ";
const STOP_READ_ENV = "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_STOP_POLL_READ";
const uuid = z.string().uuid();
const identity = z.object({ requestId: uuid, reservationId: uuid,
  invocationOrdinal: z.number().int().min(0).max(2_147_483_647) }).strict();
const claimBody = identity.extend({ claimId: uuid, ideaId: uuid,
  priceVersionId: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/),
  modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/),
  reasoningEffort: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  authVerifiedAt: z.string().datetime(),
  authProof: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** Only the dedicated Ubuntu Max launcher can create a shadow claim. The
 * request cannot assert its own authentication or runner capabilities. A
 * response loss is reconciled by exact-ID GET, never by another POST. */
export async function POST(request: Request): Promise<Response> {
  const launcherSecret = process.env[AMUX_V19_MAX_LAUNCHER_SECRET_ENV];
  if (!isAmuxV19MaxLauncherAuthorized(request,
    launcherSecret,
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!CLAIM_CODE_LATCH || process.env[WRITE_ENV] !== "enabled" ||
      process.env[READ_ENV] !== "enabled" ||
      process.env[STOP_READ_ENV] !== "enabled") {
    return amuxJsonNoStore({ available: false,
      reason: "session_budget_claim_disabled" }, 409);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  }
  let body: z.infer<typeof claimBody>;
  try { body = await readLimitedJson(request, 1_024, claimBody); }
  catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
  const authEvidenceDigest = verifyAmuxV19MaxClaimAttestation(
    launcherSecret!, body, body.authVerifiedAt, body.authProof);
  if (!authEvidenceDigest) {
    return amuxJsonNoStore({ error: "Invalid Max authentication evidence." }, 400);
  }
  let callbackReturned = false;
  try {
    const claimed = await prisma.$transaction(async (tx) => {
      const result = await commitAmuxSessionBudgetClaim(tx, {
        claimId: body.claimId, requestId: body.requestId,
        reservationId: body.reservationId,
        invocationOrdinal: body.invocationOrdinal,
        priceVersionId: body.priceVersionId,
        maxLauncherIdentity: { ideaId: body.ideaId, modelId: body.modelId,
          reasoningEffort: body.reasoningEffort, authEvidenceDigest },
        runner: { tokenCapsEnforceable: false, billableToolsDisabled: true,
          maxSubscriptionAuthenticated: true },
      });
      callbackReturned = true;
      return result;
    }, { maxWait: 5_000, timeout: 15_000 });
    return amuxJsonNoStore(claimed);
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxSessionBudgetClaimError) {
      return amuxJsonNoStore({ error: error.code, reason: error.reason }, 409);
    }
    return amuxJsonNoStore({ error: "outcome_unknown" }, 503);
  }
}

/** An unknown claim is checked once by exact request/reservation/ordinal.
 * Even an absent receipt never authorizes replay of its POST. Readback stays
 * available when claim writes are disabled for operator reconciliation. */
export async function GET(request: Request): Promise<Response> {
  if (!isAmuxV4AnalysisAgentAuthorized(request,
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET) &&
      !isAmuxV19MaxLauncherAuthorized(request,
        process.env[AMUX_V19_MAX_LAUNCHER_SECRET_ENV],
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
