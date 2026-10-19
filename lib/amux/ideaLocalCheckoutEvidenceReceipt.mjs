import { AMUX_V4_ANALYSIS_APP_ORIGIN_ENV } from "./ideaLocalQueuePoll.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "./ideaLocalSessionAnalysisQueuePoll.mjs";
import { recordAmuxV19LocalReadManifest } from
  "./ideaLocalReadManifestReceipt.mjs";
import { inspectAmuxTrackedCheckoutEvidence } from
  "./ideaTrackedCheckoutEvidenceCore.ts";

const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PATH = "/api/internal/amux/v19/checkout-evidence";
const MAX_PATH = "/api/internal/amux/v19/max-checkout-evidence";
const WRITE_TIMEOUT_MS = 25_000;
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

async function receiptJson(response) {
  if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) return null;
      total += value.byteLength;
      if (total > MAX_RECEIPT_BYTES) return null;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch { return null; }
  finally {
    for (const chunk of chunks) chunk.fill(0);
    try { await reader.cancel(); } catch { /* Never log receipt content. */ }
    reader.releaseLock();
  }
}

const validPostReceipt = (body, expected) =>
  exactKeys(body, ["evidenceId", "ideaId", "referenceOrdinal"]) &&
  UUID.test(body.evidenceId) && body.ideaId === expected.ideaId &&
  body.referenceOrdinal === expected.referenceOrdinal;

const validReadReceipt = (body, expected) =>
  exactKeys(body, ["status", "evidenceId", "ideaId", "referenceOrdinal",
    "pinnedCommitSha", "excludedCount", "excludedReasons",
    "excludedPathDigest", "excludedPathDigestKeyId"]) &&
  body.status === "recorded" && UUID.test(body.evidenceId) &&
  body.ideaId === expected.ideaId &&
  body.referenceOrdinal === expected.referenceOrdinal &&
  body.pinnedCommitSha === expected.pinnedCommitSha &&
  body.excludedCount === expected.excludedCount &&
  body.excludedPathDigest === expected.excludedPathDigest &&
  body.excludedPathDigestKeyId === expected.excludedPathDigestKeyId &&
  exactKeys(body.excludedReasons, ["secret_path", "secret_content",
    "non_regular", "unscannable_content"]) &&
  Object.keys(expected.excludedReasons).every((reason) =>
    body.excludedReasons[reason] === expected.excludedReasons[reason]);

/** Record only the aggregate checkout proof from a verified host attempt.
 * An uncertain POST is reconciled by an exact reference read; never replay it. */
export async function recordAmuxV19LocalCheckoutEvidence(input) {
  return recordCheckoutEvidence(input, null);
}

/** The Max launcher never borrows the v4 credential. Its claim identity is
 * carried on both the write and the recovery read. */
export async function recordAmuxV19MaxLocalCheckoutEvidence(input) {
  const claim = input?.maxClaim;
  if (!exactKeys(claim, ["claimId", "requestId", "reservationId",
    "invocationOrdinal"]) || !UUID.test(claim.claimId) ||
      !UUID.test(claim.requestId) || !UUID.test(claim.reservationId) ||
      !Number.isSafeInteger(claim.invocationOrdinal) ||
      claim.invocationOrdinal < 0 ||
      claim.invocationOrdinal > 2_147_483_647) return { kind: "refused" };
  return recordCheckoutEvidence(input, claim);
}

async function recordCheckoutEvidence(input, maxClaim) {
  const origin = pinnedOrigin(input?.origin, maxClaim);
  if (!origin || typeof input?.agentSecret !== "string" ||
      !SECRET.test(input.agentSecret) || typeof input?.fetchImpl !== "function" ||
      input?.observed?.kind !== "verified_success") return { kind: "refused" };
  const expected = {
    ideaId: input.ideaId, referenceOrdinal: input.referenceOrdinal,
    pinnedCommitSha: input.observed.commitSha,
    excludedCount: input.observed.excludedCount,
    excludedPathDigest: input.observed.excludedPathDigest,
    excludedPathDigestKeyId: input.excludedPathDigestKeyId,
    excludedReasons: input.observed.excludedReasons && {
      secret_path: input.observed.excludedReasons.secret_path,
      secret_content: input.observed.excludedReasons.secret_content,
      non_regular: input.observed.excludedReasons.non_regular,
      unscannable_content: input.observed.excludedReasons.unscannable_content,
    },
  };
  if (!UUID.test(expected.ideaId) ||
      !Number.isSafeInteger(expected.referenceOrdinal) ||
      expected.referenceOrdinal > 2_147_483_647 ||
      !inspectAmuxTrackedCheckoutEvidence(expected)) return { kind: "refused" };

  const path = maxClaim ? MAX_PATH : PATH;
  const endpoint = `${origin}${path}`;
  const headers = { authorization: `Bearer ${input.agentSecret}`,
    "x-amux-agent-id": maxClaim ? "amux-intake-max" : "amux-intake" };
  try {
    const response = await input.fetchImpl(endpoint, {
      method: "POST", redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(maxClaim ? { ...maxClaim, ...expected } : expected),
    });
    if (!response.url || response.url === endpoint) {
      const body = await receiptJson(response);
      if (response.status === 200 && validPostReceipt(body, expected)) {
        return { kind: "recorded", evidenceId: body.evidenceId, via: "post" };
      }
    } else try { await response.body?.cancel(); } catch { /* Ignore redirect body. */ }
  } catch { /* A POST may have committed; read only. */ }

  const url = new URL(path, origin);
  if (maxClaim) for (const [key, value] of Object.entries(maxClaim)) {
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set("ideaId", expected.ideaId);
  url.searchParams.set("referenceOrdinal", String(expected.referenceOrdinal));
  const readEndpoint = url.toString();
  try {
    const response = await input.fetchImpl(readEndpoint, {
      method: "GET", redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS), headers,
    });
    if (!response.url || response.url === readEndpoint) {
      const body = await receiptJson(response);
      if (response.status === 200 && validReadReceipt(body, expected)) {
        return { kind: "recorded", evidenceId: body.evidenceId,
          via: "readback" };
      }
    } else try { await response.body?.cancel(); } catch { /* Ignore redirect body. */ }
  } catch { /* No second POST after an uncertain response. */ }
  return { kind: "outcome_unknown" };
}

/** A read manifest is accepted only after its pinned checkout proof is
 * recorded. Neither step retries a write when its result is uncertain. */
export async function recordAmuxV19VerifiedCheckoutReceipts(input) {
  const checkout = await recordAmuxV19LocalCheckoutEvidence(input);
  if (checkout.kind !== "recorded") {
    return { kind: checkout.kind, stage: "checkout_evidence" };
  }
  const manifest = await recordAmuxV19LocalReadManifest({
    origin: input.origin, agentSecret: input.agentSecret, ideaId: input.ideaId,
    referenceOrdinal: input.referenceOrdinal,
    pinnedCommitSha: input.observed.commitSha,
    observed: input.observed, fetchImpl: input.fetchImpl,
  });
  if (manifest.kind !== "recorded") {
    return { kind: manifest.kind, stage: "read_manifest",
      evidenceId: checkout.evidenceId,
      ...(manifest.manifestId ? { manifestId: manifest.manifestId } : {}) };
  }
  return { kind: "recorded", evidenceId: checkout.evidenceId,
    manifestId: manifest.manifestId, fileCount: manifest.fileCount };
}
