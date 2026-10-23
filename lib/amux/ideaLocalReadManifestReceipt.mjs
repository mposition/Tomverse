import { randomUUID } from "node:crypto";

import { amuxV19AppRequest, amuxV19ReplyJson,
  amuxV19UnconfirmedWriteReason } from "./ideaLocalAppRequest.mjs";
import { AMUX_V4_ANALYSIS_APP_ORIGIN_ENV } from "./ideaLocalQueuePoll.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "./ideaLocalSessionAnalysisQueuePoll.mjs";
import { inspectAmuxTrackedCheckoutReadManifest } from
  "./ideaTrackedCheckoutReadManifestCore.ts";

const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PATH = "/api/internal/amux/v19/read-manifest";
const MAX_PATH = "/api/internal/amux/v19/max-read-manifest";
const WRITE_TIMEOUT_MS = 45_000;
const READ_TIMEOUT_MS = 8_000;
const MAX_RECEIPT_BYTES = 4_096;

const exactKeys = (value, names) => value !== null &&
  typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === names.length &&
  names.every((name) => Object.hasOwn(value, name));

function pinnedOrigin(value, maxClaim) {
  try {
    const target = new URL(value);
    const configured = new URL(process.env[maxClaim
      ? AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV
      : AMUX_V4_ANALYSIS_APP_ORIGIN_ENV] ?? "");
    return target.protocol === "https:" && !target.username && !target.password &&
      target.pathname === "/" && !target.search && !target.hash &&
      target.toString() === configured.toString() ? target.origin : null;
  } catch { return null; }
}

function validPostReceipt(body, input) {
  return exactKeys(body, ["manifestId", "ideaId", "referenceOrdinal",
    "fileCount"]) && body.manifestId === input.manifestId &&
    body.ideaId === input.ideaId &&
    body.referenceOrdinal === input.referenceOrdinal &&
    body.fileCount === input.observed.readFiles.length;
}

function validReadReceipt(body, input) {
  return exactKeys(body, ["status", "manifestId", "ideaId",
    "referenceOrdinal", "pinnedCommitSha", "fileCount", "digest",
    "digestKeyId", "bodyPurged"]) && body.status === "recorded" &&
    body.manifestId === input.manifestId &&
    body.ideaId === input.ideaId &&
    body.referenceOrdinal === input.referenceOrdinal &&
    body.pinnedCommitSha === input.pinnedCommitSha &&
    body.fileCount === input.observed.readFiles.length &&
    typeof body.digest === "string" && body.digest.length > 0 &&
    typeof body.digestKeyId === "string" && body.digestKeyId.length > 0 &&
    body.bodyPurged === false;
}

/** One verified CLI observation becomes one POST. A lost response permits an
 * exact manifest-ID readback only; even an absent receipt never replays paths. */
export async function recordAmuxV19LocalReadManifest(input) {
  return recordReadManifest(input, null);
}

export async function recordAmuxV19MaxLocalReadManifest(input) {
  const claim = input?.maxClaim;
  if (!exactKeys(claim, ["claimId", "requestId", "reservationId",
    "invocationOrdinal"]) || !UUID.test(claim.claimId) ||
      !UUID.test(claim.requestId) || !UUID.test(claim.reservationId) ||
      !Number.isSafeInteger(claim.invocationOrdinal) ||
      claim.invocationOrdinal < 0 ||
      claim.invocationOrdinal > 2_147_483_647) return { kind: "refused" };
  return recordReadManifest(input, claim);
}

async function recordReadManifest(input, maxClaim) {
  const origin = pinnedOrigin(input?.origin, maxClaim);
  if (!origin || !UUID.test(input?.ideaId) ||
      !Number.isSafeInteger(input?.referenceOrdinal) ||
      input.referenceOrdinal < 0 || input.referenceOrdinal > 2_147_483_647 ||
      typeof input?.agentSecret !== "string" ||
      !SECRET.test(input.agentSecret) ||
      typeof input?.fetchImpl !== "function" ||
      input?.observed?.kind !== "verified_success") return { kind: "refused" };
  const manifestId = randomUUID();
  const prepared = { manifestId, ideaId: input.ideaId,
    referenceOrdinal: input.referenceOrdinal,
    pinnedCommitSha: input.pinnedCommitSha,
    observed: { kind: "verified_success", readFiles: input.observed.readFiles } };
  const inspected = inspectAmuxTrackedCheckoutReadManifest(prepared);
  if (!inspected) return { kind: "refused" };
  inspected.plaintext.fill(0);
  prepared.observed.readFiles = inspected.files;

  const path = maxClaim ? MAX_PATH : PATH;
  const endpoint = `${origin}${path}`;
  const headers = { authorization: `Bearer ${input.agentSecret}`,
    "x-amux-agent-id": maxClaim ? "amux-intake-max" : "amux-intake" };
  // Only a POST that never left is sent again (same bytes, same manifest
  // ID); one that may have committed is only read back.
  const written = await amuxV19AppRequest({ fetchImpl: input.fetchImpl,
    url: endpoint, method: "POST", purpose: "write",
    timeoutMs: WRITE_TIMEOUT_MS, maxBytes: MAX_RECEIPT_BYTES,
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(maxClaim ? { ...maxClaim, ...prepared } : prepared) });
  const posted = amuxV19ReplyJson(written);
  if (written.kind === "response" && written.status === 200 &&
      validPostReceipt(posted, prepared)) {
    return { kind: "recorded", manifestId, fileCount: inspected.files.length,
      via: "post" };
  }

  const url = new URL(path, origin);
  if (maxClaim) for (const [key, value] of Object.entries(maxClaim)) {
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set("ideaId", input.ideaId);
  url.searchParams.set("referenceOrdinal", String(input.referenceOrdinal));
  const read = await amuxV19AppRequest({ fetchImpl: input.fetchImpl,
    url: url.toString(), method: "GET", purpose: "readback",
    timeoutMs: READ_TIMEOUT_MS, maxBytes: MAX_RECEIPT_BYTES, headers });
  const receipt = amuxV19ReplyJson(read);
  if (read.kind === "response" && read.status === 200 &&
      validReadReceipt(receipt, prepared)) {
    return { kind: "recorded", manifestId, fileCount: inspected.files.length,
      via: "readback" };
  }
  // No second POST after a lost or uncertain response.
  return { kind: "outcome_unknown", manifestId,
    reason: amuxV19UnconfirmedWriteReason(written, read) };
}
