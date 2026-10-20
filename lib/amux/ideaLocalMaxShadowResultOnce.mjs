import { amuxV19AppRequest, amuxV19ReplyJson,
  amuxV19UnconfirmedWriteReason } from "./ideaLocalAppRequest.mjs";
import { readAmuxV19SessionBudgetClaimReceipt } from
  "./ideaLocalSessionBudgetClaimReceiptRead.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "./ideaLocalSessionAnalysisQueuePoll.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const MAX_REPLY_BYTES = 1_024;

function endpointFor(origin, path) {
  try {
    const requested = new URL(origin);
    const configured = new URL(process.env[
      AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV]);
    if (requested.protocol !== "https:" || requested.username ||
        requested.password || requested.pathname !== "/" ||
        requested.search || requested.hash ||
        requested.toString() !== configured.toString()) return null;
    return new URL(path, requested).toString();
  } catch { return null; }
}

function validInput(input) {
  return input && typeof input === "object" &&
    ["claimId", "requestId", "reservationId", "ideaId"].every((key) =>
      UUID.test(input[key])) &&
    Number.isSafeInteger(input.invocationOrdinal) &&
    input.invocationOrdinal >= 0 && input.invocationOrdinal <= 2_147_483_647 &&
    (input.outcome === "outcome_unknown" ||
      ["verified_success", "invocation_failed"].includes(input.outcome) &&
      Number.isSafeInteger(input.inputTokens) &&
      Number.isSafeInteger(input.outputTokens) &&
      input.inputTokens >= 0 && input.outputTokens >= 0 &&
      input.inputTokens <= 2_147_483_647 &&
      input.outputTokens <= 2_147_483_647 &&
      input.inputTokens + input.outputTokens > 0);
}

function validResult(value, input) {
  const status = input.outcome === "outcome_unknown" ? "outcome_unknown" :
    input.outcome === "verified_success" ? "succeeded" : "failed";
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 4 && value.claimId === input.claimId &&
    value.status === status &&
    (status === "outcome_unknown" ? value.settledMicroUsd === null :
      typeof value.settledMicroUsd === "string" &&
      /^[1-9][0-9]{0,18}$/.test(value.settledMicroUsd)) &&
    typeof value.auditId === "string" && value.auditId.length > 0 &&
    value.auditId.length <= 128;
}

/** One measured Max settlement or an unknown-outcome hold. Only a POST that
 * never left the host is sent again, with the same bytes; any uncertain
 * response gets the exact receipt readback instead, which waits through a
 * dropped link. An unconfirmed answer names why (`reason`). */
export async function settleAmuxV19MaxShadowResultOnce({ origin, input,
  fetchImpl = fetch }) {
  const agentSecret = process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
  if (!validInput(input) || !SECRET.test(agentSecret ?? "") ||
      typeof fetchImpl !== "function" ||
      (input.outcome === "outcome_unknown" &&
        (input.inputTokens !== null || input.outputTokens !== null))) {
    return { kind: "refused" };
  }
  const path = input.outcome === "outcome_unknown"
    ? "/api/internal/amux/v19/analysis-budget/unknown"
    : "/api/internal/amux/v19/analysis-budget/max-result";
  const endpoint = endpointFor(origin, path);
  if (!endpoint) return { kind: "refused" };
  const written = await amuxV19AppRequest({ fetchImpl, url: endpoint,
    method: "POST", purpose: "write", timeoutMs: 8_000,
    maxBytes: MAX_REPLY_BYTES,
    headers: { authorization: `Bearer ${agentSecret}`,
      "x-amux-agent-id": "amux-intake-max",
      "content-type": "application/json" },
    body: JSON.stringify(input) });
  const value = amuxV19ReplyJson(written);
  if (written.kind === "response" && written.status === 200 &&
      validResult(value, input)) {
    return { kind: "recorded", status: value.status,
      settledMicroUsd: value.settledMicroUsd, recovered: false,
      retryWrite: false };
  }
  const receipt = await readAmuxV19SessionBudgetClaimReceipt({ origin,
    requestId: input.requestId, reservationId: input.reservationId,
    invocationOrdinal: input.invocationOrdinal, agentSecret,
    agentId: "amux-intake-max", fetchImpl, readback: true });
  const expected = input.outcome === "outcome_unknown" ? "outcome_unknown" :
    input.outcome === "verified_success" ? "succeeded" : "failed";
  if (receipt.kind === "committed" && receipt.claimId === input.claimId &&
      receipt.claimStatus === expected) {
    return { kind: "recorded", status: expected,
      settledMicroUsd: null, recovered: true, retryWrite: false };
  }
  return { kind: "outcome_unknown", receiptStatus: receipt.claimStatus ??
    receipt.status ?? null, retryWrite: false,
    reason: amuxV19UnconfirmedWriteReason(written,
      receipt.kind === "unavailable" ? { kind: "failed",
        reason: receipt.reason } : null) };
}
