import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "./ideaLocalSessionAnalysisQueuePoll.mjs";

const UUID = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const CLAIM_STATUS = new Set(["in_flight", "outcome_unknown",
  "succeeded", "failed", "owner_consumed", "released"]);
const MAX_REPLY_BYTES = 512;

function endpointFor(origin, input) {
  try {
    const requested = new URL(origin);
    const configured = new URL(process.env[
      AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV]);
    if (requested.protocol !== "https:" || requested.username ||
        requested.password || requested.pathname !== "/" ||
        requested.search || requested.hash ||
        requested.toString() !== configured.toString()) return null;
    const endpoint = new URL("/api/internal/amux/v19/analysis-budget/claim",
      requested);
    endpoint.searchParams.set("requestId", input.requestId.toLowerCase());
    endpoint.searchParams.set("reservationId", input.reservationId.toLowerCase());
    endpoint.searchParams.set("invocationOrdinal",
      String(input.invocationOrdinal));
    return endpoint.toString();
  } catch { return null; }
}

const exactKeys = (value, names) => value !== null &&
  typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === names.length &&
  names.every((name) => Object.hasOwn(value, name));

/** One readback after an uncertain claim POST. Even a confirmed 'absent'
 * cannot prove the original transaction will not commit later: never re-POST. */
export async function readAmuxV19SessionBudgetClaimReceipt(input) {
  if (!UUID.test(input?.requestId ?? "") ||
      !UUID.test(input?.reservationId ?? "") ||
      !Number.isSafeInteger(input?.invocationOrdinal) ||
      input.invocationOrdinal < 0 || input.invocationOrdinal > 2_147_483_647 ||
      !SECRET.test(input?.agentSecret ?? "") ||
      typeof input?.fetchImpl !== "function") return { kind: "refused" };
  const endpoint = endpointFor(input.origin, input);
  if (!endpoint) return { kind: "refused" };
  try {
    const response = await input.fetchImpl(endpoint, {
      method: "GET", redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(8_000),
      headers: { authorization: `Bearer ${input.agentSecret}`,
        "x-amux-agent-id": "amux-intake" },
    });
    if (response.status !== 200 ||
        (response.url && response.url !== endpoint) ||
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
          "application/json") {
      try { await response.body?.cancel(); } catch { /* No response logging. */ }
      return { kind: "unavailable", retryWrite: false };
    }
    const reader = response.body?.getReader();
    if (!reader) return { kind: "unavailable", retryWrite: false };
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) return {
          kind: "unavailable", retryWrite: false };
        size += value.byteLength;
        if (size > MAX_REPLY_BYTES) return {
          kind: "unavailable", retryWrite: false };
        chunks.push(value);
      }
      const receipt = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
      if (exactKeys(receipt, ["status"]) &&
          ["absent", "partial"].includes(receipt.status)) {
        return { kind: "unresolved", status: receipt.status,
          retryWrite: false };
      }
      if (exactKeys(receipt, ["status", "claimId", "claimStatus"]) &&
          receipt.status === "committed" && UUID.test(receipt.claimId) &&
          CLAIM_STATUS.has(receipt.claimStatus)) {
        return { kind: "committed", claimId: receipt.claimId,
          claimStatus: receipt.claimStatus, retryWrite: false };
      }
      return { kind: "unavailable", retryWrite: false };
    } finally {
      for (const chunk of chunks) chunk.fill(0);
      try { await reader.cancel(); } catch { /* No response logging. */ }
      reader.releaseLock();
    }
  } catch { return { kind: "unavailable", retryWrite: false }; }
}
