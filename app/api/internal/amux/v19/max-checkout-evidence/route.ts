export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV } from
  "@/lib/amux/ideaAnalysisQueueCore";
import { AMUX_V19_MAX_LAUNCHER_SECRET_ENV,
  isAmuxV19MaxLauncherAuthorized } from
  "@/lib/amux/ideaSessionMaxLauncherAuth";
import { AmuxTrackedCheckoutEvidenceError,
  readAmuxMaxTrackedCheckoutEvidence,
  recordAmuxTrackedCheckoutEvidence } from
  "@/lib/amux/ideaTrackedCheckoutEvidenceStore";
import { prisma } from "@/lib/prisma";

const WRITE_ENV = "TOMVERSE_AMUX_V19_MAX_CHECKOUT_EVIDENCE_WRITE";
const READ_ENV = "TOMVERSE_AMUX_V19_MAX_CHECKOUT_EVIDENCE_READ";
const SHARED_WRITE_ENV = "TOMVERSE_AMUX_V19_CHECKOUT_EVIDENCE_WRITE";
const SHARED_READ_ENV = "TOMVERSE_AMUX_V19_CHECKOUT_EVIDENCE_READ";
const uuid = z.string().uuid();
const ordinal = z.number().int().safe().min(0).max(2_147_483_647);
const identity = z.object({ claimId: uuid, requestId: uuid,
  reservationId: uuid, ideaId: uuid, invocationOrdinal: ordinal,
  referenceOrdinal: ordinal }).strict();
const bodySchema = identity.extend({
  pinnedCommitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  excludedCount: ordinal,
  excludedPathDigest: z.string().regex(/^[a-f0-9]{64}$/),
  excludedPathDigestKeyId: z.string().min(1).max(128),
  excludedReasons: z.object({ secret_path: ordinal,
    secret_content: ordinal, non_regular: ordinal,
    unscannable_content: ordinal }).strict(),
}).strict();

function authorized(request: Request): boolean {
  return isAmuxV19MaxLauncherAuthorized(request,
    process.env[AMUX_V19_MAX_LAUNCHER_SECRET_ENV],
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET);
}

/** Only the exact active Max claim may record this content-free proof. */
export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if ([WRITE_ENV, READ_ENV, SHARED_WRITE_ENV, SHARED_READ_ENV].some(
    (name) => process.env[name] !== "enabled")) {
    return amuxJsonNoStore({ available: false,
      reason: "max_checkout_evidence_write_disabled" }, 409);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  }
  let body: z.infer<typeof bodySchema>;
  try { body = await readLimitedJson(request, 4 * 1024, bodySchema); }
  catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
  const { claimId, requestId, reservationId, invocationOrdinal, ...proof } = body;
  let callbackReturned = false;
  try {
    const stored = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
               set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
      `;
      const result = await recordAmuxTrackedCheckoutEvidence(tx, proof,
        { claimId, requestId, reservationId, invocationOrdinal });
      callbackReturned = true;
      return result;
    }, { maxWait: 3_000, timeout: 12_000 });
    return amuxJsonNoStore({ evidenceId: stored.evidenceId,
      ideaId: stored.ideaId, referenceOrdinal: stored.referenceOrdinal });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxTrackedCheckoutEvidenceError) {
      return amuxJsonNoStore({ error: error.code, retryWrite: false }, 409);
    }
    return amuxJsonNoStore({ error: "outcome_unknown", retryWrite: false }, 503);
  }
}

/** Exact-claim readback remains available after the claim closes. */
export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (process.env[READ_ENV] !== "enabled" ||
      process.env[SHARED_READ_ENV] !== "enabled") {
    return amuxJsonNoStore({ available: false,
      reason: "max_checkout_evidence_read_disabled" }, 409);
  }
  const params = new URL(request.url).searchParams;
  const keys = ["claimId", "requestId", "reservationId", "ideaId",
    "invocationOrdinal", "referenceOrdinal"];
  if (params.size !== keys.length || keys.some((key) =>
    params.getAll(key).length !== 1)) {
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  }
  const parsed = identity.safeParse({ claimId: params.get("claimId"),
    requestId: params.get("requestId"), reservationId: params.get("reservationId"),
    ideaId: params.get("ideaId"),
    invocationOrdinal: Number(params.get("invocationOrdinal")),
    referenceOrdinal: Number(params.get("referenceOrdinal")) });
  if (!parsed.success ||
      String(parsed.data.invocationOrdinal) !== params.get("invocationOrdinal") ||
      String(parsed.data.referenceOrdinal) !== params.get("referenceOrdinal")) {
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  }
  const { ideaId, referenceOrdinal, ...claim } = parsed.data;
  try {
    const evidence = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
               set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
      `;
      return readAmuxMaxTrackedCheckoutEvidence(tx, ideaId,
        referenceOrdinal, claim);
    }, { maxWait: 3_000, timeout: 10_000 });
    if (!evidence) return amuxJsonNoStore({ status: "absent",
      ideaId, referenceOrdinal, retryWrite: false }, 404);
    return amuxJsonNoStore({ status: "recorded",
      evidenceId: evidence.evidenceId, ideaId, referenceOrdinal,
      pinnedCommitSha: evidence.pinnedCommitSha,
      excludedCount: evidence.excludedCount,
      excludedReasons: evidence.excludedReasons,
      excludedPathDigest: evidence.excludedPathDigest,
      excludedPathDigestKeyId: evidence.excludedPathDigestKeyId });
  } catch {
    return amuxJsonNoStore({ error: "readback_unavailable",
      retryWrite: false }, 503);
  }
}
