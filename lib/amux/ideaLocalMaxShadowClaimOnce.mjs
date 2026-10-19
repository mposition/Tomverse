import { prepareAmuxV19MaxShadowClaim } from
  "./ideaLocalMaxShadowClaimPreflight.mjs";
import { readAmuxV19SessionBudgetClaimReceipt } from
  "./ideaLocalSessionBudgetClaimReceiptRead.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "./ideaLocalSessionAnalysisQueuePoll.mjs";

const MAX_RESPONSE_BYTES = 1_024;
const USD_MICRO = /^[1-9][0-9]{0,18}$/;

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

/** One fixed-launcher DB claim. No CLI/model call occurs here. Every uncertain
 * POST gets exactly one readback and never a second write. */
export async function claimAmuxV19MaxShadowBudgetOnce({ origin, identity,
  fetchImpl = fetch }) {
  const endpoint = endpointFor(origin);
  if (!endpoint || typeof fetchImpl !== "function") return { kind: "refused" };
  const prepared = await prepareAmuxV19MaxShadowClaim(identity);
  if (prepared.kind !== "ready") return prepared;
  const agentSecret = process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
  let response = null;
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
  return { kind: "outcome_unknown", receiptStatus: receipt.status ?? null,
    retryWrite: false };
}
