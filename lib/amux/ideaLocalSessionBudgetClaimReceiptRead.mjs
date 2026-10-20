import { amuxV19AppRequest, amuxV19ReplyJson, amuxV19ReplyReason } from
  "./ideaLocalAppRequest.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "./ideaLocalSessionAnalysisQueuePoll.mjs";

const UUID = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
const CANONICAL_UUID = new RegExp(UUID.source);
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const CLAIM_STATUS = new Set(["in_flight", "outcome_unknown",
  "succeeded", "failed", "owner_consumed", "released"]);
const MAX_REPLY_BYTES = 512;
const AGENT_IDS = new Set(["amux-intake", "amux-intake-max"]);

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
    endpoint.searchParams.set("requestId", input.requestId);
    endpoint.searchParams.set("reservationId", input.reservationId);
    endpoint.searchParams.set("invocationOrdinal",
      String(input.invocationOrdinal));
    return endpoint.toString();
  } catch { return null; }
}

const exactKeys = (value, names) => value !== null &&
  typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === names.length &&
  names.every((name) => Object.hasOwn(value, name));

/** One bounded exact-claim observation before checkout or after an uncertain
 * POST (`readback: true`, which waits longer through a dropped link). Even
 * 'absent' cannot prove a late commit impossible: never re-POST. An
 * unavailable answer names why (`reason`). */
export async function readAmuxV19SessionBudgetClaimReceipt(input) {
  const agentId = input?.agentId ?? "amux-intake";
  if (!CANONICAL_UUID.test(input?.requestId ?? "") ||
      !CANONICAL_UUID.test(input?.reservationId ?? "") ||
      !Number.isSafeInteger(input?.invocationOrdinal) ||
      input.invocationOrdinal < 0 || input.invocationOrdinal > 2_147_483_647 ||
      !SECRET.test(input?.agentSecret ?? "") ||
      !AGENT_IDS.has(agentId) ||
      typeof input?.fetchImpl !== "function") return { kind: "refused" };
  const endpoint = endpointFor(input.origin, input);
  if (!endpoint) return { kind: "refused" };
  const reply = await amuxV19AppRequest({ fetchImpl: input.fetchImpl,
    url: endpoint, method: "GET", timeoutMs: 8_000,
    purpose: input.readback === true ? "readback" : "read",
    maxBytes: MAX_REPLY_BYTES,
    headers: { authorization: `Bearer ${input.agentSecret}`,
      "x-amux-agent-id": agentId } });
  const receipt = amuxV19ReplyJson(reply);
  if (reply.kind !== "response" || reply.status !== 200) return {
    kind: "unavailable", retryWrite: false, reason: amuxV19ReplyReason(reply) };
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
  return { kind: "unavailable", retryWrite: false,
    reason: "response_invalid" };
}
