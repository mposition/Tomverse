export const dynamic = "force-dynamic";

import { z } from "zod";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V19_READ_MANIFEST_RETENTION_ENV,
  amuxV19ReadManifestRetentionEnabled } from
  "@/lib/amux/ideaContentRetentionCore";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV } from
  "@/lib/amux/ideaAnalysisQueueCore";
import { AMUX_V19_MAX_LAUNCHER_SECRET_ENV,
  isAmuxV19MaxLauncherAuthorized } from
  "@/lib/amux/ideaSessionMaxLauncherAuth";
import { AmuxTrackedCheckoutReadManifestError,
  prepareAmuxTrackedCheckoutReadManifest,
  readAmuxMaxManifestForClaim,
  recordAmuxTrackedCheckoutReadManifest } from
  "@/lib/amux/ideaTrackedCheckoutReadManifestStore";
import { prisma } from "@/lib/prisma";

const WRITE_ENV = "TOMVERSE_AMUX_V19_MAX_READ_MANIFEST_WRITE";
const READ_ENV = "TOMVERSE_AMUX_V19_MAX_READ_MANIFEST_READ";
const SHARED_WRITE_ENV = "TOMVERSE_AMUX_V19_READ_MANIFEST_WRITE";
const SHARED_READ_ENV = "TOMVERSE_AMUX_V19_READ_MANIFEST_READ";
const uuid = z.string().uuid();
const ordinal = z.number().int().safe().min(0).max(2_147_483_647);
const identity = z.object({ claimId: uuid, requestId: uuid,
  reservationId: uuid, ideaId: uuid, invocationOrdinal: ordinal,
  referenceOrdinal: ordinal }).strict();
const bodySchema = identity.extend({ manifestId: uuid,
  pinnedCommitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  observed: z.object({ kind: z.literal("verified_success"),
    readFiles: z.array(z.string()) }).strict(),
}).strict();

function authorized(request: Request): boolean {
  return isAmuxV19MaxLauncherAuthorized(request,
    process.env[AMUX_V19_MAX_LAUNCHER_SECRET_ENV],
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET);
}

/** Intent, external key and encrypted paths are prepared only for an active
 * Max claim whose checkout proof was already bound to that exact claim. */
export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if ([WRITE_ENV, READ_ENV, SHARED_WRITE_ENV, SHARED_READ_ENV].some(
    (name) => process.env[name] !== "enabled") ||
      !amuxV19ReadManifestRetentionEnabled(
        process.env[AMUX_V19_READ_MANIFEST_RETENTION_ENV])) {
    return amuxJsonNoStore({ available: false,
      reason: "max_read_manifest_write_disabled" }, 409);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  }
  let body: z.infer<typeof bodySchema>;
  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) throw new Error("invalid_body");
    body = parsed.data;
  } catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
  const { claimId, requestId, reservationId, invocationOrdinal,
    ...manifest } = body;
  const claim = { claimId, requestId, reservationId, invocationOrdinal };
  let prepared: Awaited<ReturnType<typeof prepareAmuxTrackedCheckoutReadManifest>>;
  try { prepared = await prepareAmuxTrackedCheckoutReadManifest(manifest,
    claim); }
  catch (error) {
    if (error instanceof AmuxTrackedCheckoutReadManifestError) {
      return amuxJsonNoStore({ error: error.code, retryWrite: false },
        error.code === "invalid_manifest" ? 400 : 409);
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
        prepared.input, prepared.keys, claim);
      callbackReturned = true;
      return stored;
    }, { maxWait: 3_000, timeout: 12_000 });
    return amuxJsonNoStore({ manifestId: receipt.manifestId,
      ideaId: body.ideaId, referenceOrdinal: body.referenceOrdinal,
      fileCount: receipt.fileCount });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxTrackedCheckoutReadManifestError) {
      return amuxJsonNoStore({ error: error.code, retryWrite: false }, 409);
    }
    return amuxJsonNoStore({ error: "outcome_unknown", retryWrite: false }, 503);
  }
}

/** A pending key intent or completed manifest can be read for its claim after
 * writes stop. A lost POST never authorizes another key creation attempt. */
export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (process.env[READ_ENV] !== "enabled" ||
      process.env[SHARED_READ_ENV] !== "enabled") {
    return amuxJsonNoStore({ available: false,
      reason: "max_read_manifest_read_disabled" }, 409);
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
    const readback = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
               set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
      `;
      return readAmuxMaxManifestForClaim(tx, ideaId, referenceOrdinal, claim);
    }, { maxWait: 3_000, timeout: 10_000 });
    if (!readback) return amuxJsonNoStore({ status: "absent",
      ideaId, referenceOrdinal, retryWrite: false }, 404);
    const { intent, manifest: receipt } = readback;
    if (!receipt) return amuxJsonNoStore({ status: "key_intent",
      manifestId: intent.id, ideaId, referenceOrdinal,
      pinnedCommitSha: intent.pinnedCommitSha,
      keyRetirementClaimed: intent.keyRetirementClaimedAt !== null,
      keyRetirementRecorded: intent.keyDeletedAt !== null,
      retryWrite: false });
    if (receipt.id !== intent.id) return amuxJsonNoStore({ error:
      "readback_unavailable", retryWrite: false }, 503);
    return amuxJsonNoStore({ status: "recorded", manifestId: receipt.id,
      ideaId, referenceOrdinal, pinnedCommitSha: receipt.pinnedCommitSha,
      fileCount: receipt.fileCount, digest: receipt.digest,
      digestKeyId: receipt.digestKeyId,
      bodyPurged: receipt.bodyPurgedAt !== null });
  } catch {
    return amuxJsonNoStore({ error: "readback_unavailable",
      retryWrite: false }, 503);
  }
}
