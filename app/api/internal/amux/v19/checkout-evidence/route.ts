export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV,
  isAmuxV4AnalysisAgentAuthorized } from "@/lib/amux/ideaAnalysisQueueCore";
import { AmuxTrackedCheckoutEvidenceError,
  readAmuxTrackedCheckoutEvidence,
  recordAmuxTrackedCheckoutEvidence } from
  "@/lib/amux/ideaTrackedCheckoutEvidenceStore";
import { prisma } from "@/lib/prisma";

const WRITE_ENV = "TOMVERSE_AMUX_V19_CHECKOUT_EVIDENCE_WRITE";
const READ_ENV = "TOMVERSE_AMUX_V19_CHECKOUT_EVIDENCE_READ";
const id = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
// These values land in PostgreSQL Int columns, not BigInt columns.
const ordinal = z.number().int().min(0).max(2_147_483_647);
const lookupSchema = z.object({ ideaId: id, referenceOrdinal: ordinal }).strict();
const bodySchema = lookupSchema.extend({
  pinnedCommitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  excludedCount: ordinal,
  excludedPathDigest: z.string().regex(/^[a-f0-9]{64}$/),
  excludedPathDigestKeyId: z.string().min(1).max(128),
  excludedReasons: z.object({ secret_path: ordinal,
    secret_content: ordinal, non_regular: ordinal,
    unscannable_content: ordinal }).strict(),
}).strict();

function authorized(request: Request): boolean {
  return isAmuxV4AnalysisAgentAuthorized(request,
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET);
}

/** A content-free proof from the isolated analysis worker. Admission and the
 * CLI run have their own existing switches; this records an already prepared
 * checkout, even if admission has since stopped. Its dedicated write switch
 * can stop evidence writes. A lost reply is read back by idea/reference; the
 * worker never blindly repeats POST. */
export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  // Readback must be available before a write can have an unknown outcome.
  if (process.env[WRITE_ENV] !== "enabled" || process.env[READ_ENV] !== "enabled") {
    return amuxJsonNoStore({ available: false,
      reason: "checkout_evidence_write_disabled" }, 409);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  }
  let body: z.infer<typeof bodySchema>;
  try { body = await readLimitedJson(request, 4 * 1024, bodySchema); }
  catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
  let callbackReturned = false;
  try {
    const receipt = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
               set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
      `;
      const stored = await recordAmuxTrackedCheckoutEvidence(tx, body);
      callbackReturned = true;
      return stored;
    }, { maxWait: 3_000, timeout: 12_000 });
    return amuxJsonNoStore({ evidenceId: receipt.evidenceId,
      ideaId: receipt.ideaId, referenceOrdinal: receipt.referenceOrdinal });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxTrackedCheckoutEvidenceError) {
      return amuxJsonNoStore({ error: error.code, retryWrite: false }, 409);
    }
    return amuxJsonNoStore({ error: "outcome_unknown", retryWrite: false }, 503);
  }
}

/** Exact-reference, content-free recovery stays available after writes stop. */
export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (process.env[READ_ENV] !== "enabled") {
    return amuxJsonNoStore({ available: false,
      reason: "checkout_evidence_read_disabled" }, 409);
  }
  const params = new URL(request.url).searchParams;
  if (params.size !== 2 || params.getAll("ideaId").length !== 1 ||
      params.getAll("referenceOrdinal").length !== 1) {
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  }
  const parsed = lookupSchema.safeParse({ ideaId: params.get("ideaId"),
    referenceOrdinal: Number(params.get("referenceOrdinal")) });
  if (!parsed.success || String(parsed.data.referenceOrdinal) !==
      params.get("referenceOrdinal")) {
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  }
  try {
    const evidence = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
               set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
      `;
      return readAmuxTrackedCheckoutEvidence(tx, parsed.data.ideaId,
        parsed.data.referenceOrdinal);
    },
    { maxWait: 3_000, timeout: 10_000 });
    if (!evidence) return amuxJsonNoStore({ status: "absent",
      ...parsed.data, retryWrite: false }, 404);
    return amuxJsonNoStore({ status: "recorded",
      evidenceId: evidence.evidenceId, ideaId: evidence.ideaId,
      referenceOrdinal: evidence.referenceOrdinal,
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
