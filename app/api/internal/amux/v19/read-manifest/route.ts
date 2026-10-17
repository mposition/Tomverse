export const dynamic = "force-dynamic";

import { z } from "zod";

import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V19_READ_MANIFEST_RETENTION_ENV,
  amuxV19ReadManifestRetentionEnabled } from
  "@/lib/amux/ideaContentRetentionCore";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV,
  isAmuxV4AnalysisAgentAuthorized } from "@/lib/amux/ideaAnalysisQueueCore";
import { AmuxTrackedCheckoutReadManifestError,
  prepareAmuxTrackedCheckoutReadManifest,
  readAmuxTrackedCheckoutReadManifestKeyIntentReceipt,
  readAmuxTrackedCheckoutReadManifestReceipt,
  recordAmuxTrackedCheckoutReadManifest } from
  "@/lib/amux/ideaTrackedCheckoutReadManifestStore";
import { prisma } from "@/lib/prisma";

const WRITE_ENV = "TOMVERSE_AMUX_V19_READ_MANIFEST_WRITE";
const READ_ENV = "TOMVERSE_AMUX_V19_READ_MANIFEST_READ";
const id = z.string().uuid();
const ordinal = z.number().int().min(0).max(2_147_483_647);
const lookupSchema = z.object({ ideaId: id, referenceOrdinal: ordinal }).strict();
const bodySchema = lookupSchema.extend({
  manifestId: id,
  pinnedCommitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  observed: z.object({ kind: z.literal("verified_success"),
    readFiles: z.array(z.string()) }).strict(),
}).strict();

function authorized(request: Request): boolean {
  return isAmuxV4AnalysisAgentAuthorized(request,
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET);
}

/** Persist an already verified host observation. The client-generated
 * manifestId binds an uncertain POST to its exact-reference GET receipt. The
 * host never retries a POST after an uncertain key-store write or COMMIT. */
export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (process.env[WRITE_ENV] !== "enabled" || process.env[READ_ENV] !== "enabled" ||
      !amuxV19ReadManifestRetentionEnabled(
        process.env[AMUX_V19_READ_MANIFEST_RETENTION_ENV])) {
    return amuxJsonNoStore({ available: false,
      reason: "read_manifest_write_disabled" }, 409);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  }
  let body: z.infer<typeof bodySchema>;
  try {
    // v19 intentionally has no read-file count or byte ceiling; the host
    // reports its complete verified observation, including large manifests.
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) throw new Error("invalid_body");
    body = parsed.data;
  } catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }

  let prepared: Awaited<ReturnType<typeof prepareAmuxTrackedCheckoutReadManifest>>;
  try { prepared = await prepareAmuxTrackedCheckoutReadManifest(body); }
  catch (error) {
    if (error instanceof AmuxTrackedCheckoutReadManifestError &&
        error.code === "invalid_manifest") {
      return amuxJsonNoStore({ error: error.code, retryWrite: false }, 400);
    }
    return amuxJsonNoStore({ error: "outcome_unknown", retryWrite: false }, 503);
  }
  let callbackReturned = false;
  try {
    const receipt = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
               set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
      `;
      const stored = await recordAmuxTrackedCheckoutReadManifest(tx,
        prepared.input, prepared.keys);
      callbackReturned = true;
      return stored;
    }, { maxWait: 3_000, timeout: 12_000 });
    return amuxJsonNoStore({ manifestId: receipt.manifestId,
      ideaId: body.ideaId, referenceOrdinal: body.referenceOrdinal,
      fileCount: receipt.fileCount });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxTrackedCheckoutReadManifestError) {
      // The durable intent retains the key until seven-day retirement. An
      // immediate DeleteObject would create a second versioned-bucket delete
      // marker when the orphan sweeper later visits the same identity.
      return amuxJsonNoStore({ error: error.code, retryWrite: false }, 409);
    }
    return amuxJsonNoStore({ error: "outcome_unknown", retryWrite: false }, 503);
  }
}

/** Content-free recovery remains available after writes stop or paths expire. */
export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (process.env[READ_ENV] !== "enabled") {
    return amuxJsonNoStore({ available: false,
      reason: "read_manifest_read_disabled" }, 409);
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
    const readback = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
               set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
      `;
      const receipt = await readAmuxTrackedCheckoutReadManifestReceipt(tx,
        parsed.data.ideaId, parsed.data.referenceOrdinal);
      if (receipt) return { receipt, intent: null };
      const intent = await readAmuxTrackedCheckoutReadManifestKeyIntentReceipt(tx,
        parsed.data.ideaId, parsed.data.referenceOrdinal);
      return { receipt: null, intent };
    }, { maxWait: 3_000, timeout: 10_000 });
    if (!readback.receipt) {
      if (readback.intent) return amuxJsonNoStore({ status: "key_intent",
        manifestId: readback.intent.id, ideaId: readback.intent.ideaId,
        referenceOrdinal: readback.intent.referenceOrdinal,
        pinnedCommitSha: readback.intent.pinnedCommitSha,
        keyRetirementClaimed: readback.intent.keyRetirementClaimedAt !== null,
        keyRetirementRecorded: readback.intent.keyDeletedAt !== null,
        retryWrite: false });
      return amuxJsonNoStore({ status: "absent",
        ...parsed.data, retryWrite: false }, 404);
    }
    const receipt = readback.receipt;
    return amuxJsonNoStore({ status: "recorded", manifestId: receipt.id,
      ideaId: receipt.ideaId, referenceOrdinal: receipt.referenceOrdinal,
      pinnedCommitSha: receipt.pinnedCommitSha, fileCount: receipt.fileCount,
      digest: receipt.digest, digestKeyId: receipt.digestKeyId,
      bodyPurged: receipt.bodyPurgedAt !== null });
  } catch {
    return amuxJsonNoStore({ error: "readback_unavailable",
      retryWrite: false }, 503);
  }
}
