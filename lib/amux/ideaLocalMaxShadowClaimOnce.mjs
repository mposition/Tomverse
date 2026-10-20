import { prepareAmuxV19MaxShadowClaim } from
  "./ideaLocalMaxShadowClaimPreflight.mjs";
import { readAmuxV19SessionBudgetClaimReceipt } from
  "./ideaLocalSessionBudgetClaimReceiptRead.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "./ideaLocalSessionAnalysisQueuePoll.mjs";

const MAX_RESPONSE_BYTES = 1_024;
const USD_MICRO = /^[1-9][0-9]{0,18}$/;
/** The claim route's store refusals. Each is thrown inside the claim
 * transaction, which then rolls back, and is answered 409 `{ error, reason? }`
 * (app/api/internal/amux/v19/analysis-budget/claim/route.ts). */
const STORE_REFUSALS = new Set(["not_ready", "budget_hold",
  "budget_unavailable", "integrity_unavailable"]);
const REFUSAL_REASON = /^[a-z_]{1,40}$/;
/** Kinds a confirmed pre-write refusal returns instead of outcome_unknown.
 * No claim exists for them, so the local halt marker is not kept. */
export const AMUX_V19_MAX_CLAIM_REFUSAL_KINDS = Object.freeze([
  ...STORE_REFUSALS, "claim_disabled"]);

/** A 409 body the route sends only before any claim write can commit: a
 * store refusal, or the claim write switch being off. Anything else is not
 * a refusal and keeps the uncertain-POST path. */
function preWriteRefusal(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const keys = Object.keys(value);
  if (keys.length === 2 && value.available === false &&
      value.reason === "session_budget_claim_disabled") {
    return { kind: "claim_disabled" };
  }
  if (!STORE_REFUSALS.has(value.error) || keys.length > 2 ||
      !keys.every((key) => key === "error" || key === "reason") ||
      (Object.hasOwn(value, "reason") && (typeof value.reason !== "string" ||
        !REFUSAL_REASON.test(value.reason)))) return null;
  return { kind: value.error,
    ...(Object.hasOwn(value, "reason") ? { reason: value.reason } : {}) };
}

function endpointFor(origin) {
  try {
    const requested = new URL(origin);
    const configured = new URL(process.env[
      AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV]);
    if (requested.protocol !== "https:" || requested.username ||
        requested.password || requested.pathname !== "/" ||
        requested.search || requested.hash ||
        requested.toString() !== configured.toString()) return null;
    return new URL("/api/internal/amux/v19/analysis-budget/claim",
      requested).toString();
  } catch { return null; }
}

async function readBoundedJson(response) {
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
      if (total > MAX_RESPONSE_BYTES) return null;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch { return null; }
  finally {
    for (const chunk of chunks) chunk.fill(0);
    try { await reader.cancel(); } catch { /* No response logging. */ }
    reader.releaseLock();
  }
}

function validClaim(value, identity) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 6 &&
    value.claimId === identity.claimId &&
    value.requestId === identity.requestId &&
    value.reservationId === identity.reservationId &&
    value.invocationOrdinal === identity.invocationOrdinal &&
    typeof value.reservedMicroUsd === "string" &&
    USD_MICRO.test(value.reservedMicroUsd) &&
    typeof value.auditId === "string" && value.auditId.length > 0 &&
    value.auditId.length <= 128;
}

/** One fixed-launcher DB claim. No CLI/model call occurs here. Every POST
 * without a valid 200 gets exactly one readback and never a second write. A
 * known pre-write refusal (409) whose readback finds no claim returns its own
 * quiet kind; any other answer, or a readback that is not `absent`, stays
 * outcome_unknown. */
export async function claimAmuxV19MaxShadowBudgetOnce({ origin, identity,
  fetchImpl = fetch }, prepare = prepareAmuxV19MaxShadowClaim) {
  const endpoint = endpointFor(origin);
  if (!endpoint || typeof fetchImpl !== "function") return { kind: "refused" };
  const prepared = await prepare(identity);
  if (prepared.kind !== "ready") return prepared;
  const agentSecret = process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
  let response = null;
  let refusal = null;
  try {
    response = await fetchImpl(endpoint, { method: "POST", redirect: "manual",
      cache: "no-store", signal: AbortSignal.timeout(8_000),
      headers: { authorization: `Bearer ${agentSecret}`,
        "x-amux-agent-id": "amux-intake-max",
        "content-type": "application/json" },
      body: JSON.stringify({ ...prepared.identity,
        authVerifiedAt: prepared.authVerifiedAt,
        authProof: prepared.authProof }),
    });
    if (response.status === 200 &&
        (!response.url || response.url === endpoint)) {
      const value = await readBoundedJson(response);
      if (validClaim(value, prepared.identity)) {
        return { kind: "claimed", claimId: prepared.identity.claimId,
          reservationId: prepared.identity.reservationId,
          requestId: prepared.identity.requestId,
          reservedMicroUsd: value.reservedMicroUsd, recovered: false,
          retryWrite: false };
      }
    } else if (response.status === 409 &&
        (!response.url || response.url === endpoint)) {
      refusal = preWriteRefusal(await readBoundedJson(response));
    }
  } catch { /* The write outcome is unknown; read once and stop. */ }
  try { await response?.body?.cancel(); } catch { /* No response logging. */ }
  const receipt = await readAmuxV19SessionBudgetClaimReceipt({ origin,
    requestId: prepared.identity.requestId,
    reservationId: prepared.identity.reservationId,
    invocationOrdinal: prepared.identity.invocationOrdinal,
    agentSecret, agentId: "amux-intake-max", fetchImpl });
  if (receipt.kind === "committed" &&
      receipt.claimId === prepared.identity.claimId &&
      receipt.claimStatus === "in_flight") {
    return { kind: "claimed", claimId: receipt.claimId,
      reservationId: prepared.identity.reservationId,
      requestId: prepared.identity.requestId,
      reservedMicroUsd: null, recovered: true, retryWrite: false };
  }
  // The route refused before writing and the exact readback finds nothing:
  // no claim to hold, so this is the refusal itself, not an unknown outcome.
  if (refusal && receipt.kind === "unresolved" && receipt.status === "absent") {
    return { ...refusal, retryWrite: false };
  }
  return { kind: "outcome_unknown", receiptStatus: receipt.status ?? null,
    retryWrite: false };
}
