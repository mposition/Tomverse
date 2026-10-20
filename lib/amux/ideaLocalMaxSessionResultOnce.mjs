import { isAmuxIdeaAnalysisProvider } from "./ideaAnalysisChannelCore.ts";
import { amuxV19AppRequest, amuxV19ReplyJson,
  amuxV19UnconfirmedWriteReason } from "./ideaLocalAppRequest.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "./ideaLocalSessionAnalysisQueuePoll.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const AUDIT_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const PATH = "/api/internal/amux/v19/session-analysis-result";
const WRITE_TIMEOUT_MS = 90_000;
const READ_TIMEOUT_MS = 8_000;
const MAX_REPLY_BYTES = 1_024;

function endpointFor(origin) {
  try {
    const target = new URL(origin);
    const configured = new URL(process.env[
      AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV]);
    if (target.protocol !== "https:" || target.username ||
        target.password || target.pathname !== "/" ||
        target.search || target.hash ||
        target.toString() !== configured.toString()) return null;
    return new URL(PATH, target).toString();
  } catch { return null; }
}

function validInput(input) {
  return input && typeof input === "object" &&
    ["claimId", "requestId", "reservationId", "ideaId",
      "evidenceId", "manifestId"].every((name) =>
      UUID.test(input[name])) &&
    Number.isSafeInteger(input.invocationOrdinal) &&
    input.invocationOrdinal >= 0 &&
    input.invocationOrdinal <= 2_147_483_647 &&
    Number.isSafeInteger(input.referenceOrdinal) &&
    input.referenceOrdinal >= 0 &&
    input.referenceOrdinal <= 2_147_483_647 &&
    typeof input.rawModelOutput === "string" &&
    Buffer.byteLength(input.rawModelOutput, "utf8") >= 1 &&
    Buffer.byteLength(input.rawModelOutput, "utf8") <= 65_536 &&
    [input.inputTokens, input.outputTokens].every((n) =>
      Number.isSafeInteger(n) && n >= 0 && n <= 2_147_483_647) &&
    input.inputTokens + input.outputTokens > 0 &&
    validAttestation(input.cliAttestation);
}

const validAttestation = (value) => value !== null && typeof value === "object" &&
  !Array.isArray(value) && Object.keys(value).length === 3 &&
  isAmuxIdeaAnalysisProvider(value.provider) &&
  (value.modelAttestation === "served" || value.modelAttestation === "requested") &&
  typeof value.cliSha256 === "string" && DIGEST.test(value.cliSha256);

const PLAN_REFUSALS = new Set(["invalid_result", "needs_owner_input",
  "continuation_unavailable"]);
const REGISTRATION_STATE = /^[a-z_]{1,40}$/;

/** The plan the app made from this answer, and what registration did. */
function validPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return false;
  return plan.state === "plan_ready" || plan.state === "plan_continues"
    ? Object.keys(plan).length === 3 && UUID.test(plan.planId) &&
      Number.isSafeInteger(plan.unitCount) && plan.unitCount >= 0
    : plan.state === "plan_refused" && Object.keys(plan).length === 2 &&
      PLAN_REFUSALS.has(plan.reason);
}

function validWrite(value, input) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 7 &&
    value.claimId === input.claimId && validPlan(value.plan) &&
    value.registration && typeof value.registration === "object" &&
    Object.keys(value.registration).length === 1 &&
    REGISTRATION_STATE.test(value.registration.state ?? "") &&
    AUDIT_ID.test(value.resultAuditId) &&
    AUDIT_ID.test(value.settlementAuditId) &&
    DIGEST.test(value.digest) && KEY_ID.test(value.digestKeyId);
}

function validRead(value, input) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 4 &&
    value.status === "committed" &&
    value.claimId === input.claimId &&
    DIGEST.test(value.digest) && KEY_ID.test(value.digestKeyId);
}

/** Exactly one result write after the verified Max checkout receipts. Only a
 * POST that never left the host is sent again, with the same bytes. A lost
 * response gets a content-free readback; it never resends model output. */
export async function recordAmuxV19MaxSessionResultOnce({ origin, input,
  fetchImpl = fetch }) {
  const endpoint = endpointFor(origin);
  const secret = process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
  if (!endpoint || !SECRET.test(secret ?? "") ||
      !validInput(input) || typeof fetchImpl !== "function") {
    return { kind: "refused", retryWrite: false };
  }
  const headers = { authorization: `Bearer ${secret}`,
    "x-amux-agent-id": "amux-intake-max",
    "content-type": "application/json" };
  const written = await amuxV19AppRequest({ fetchImpl, url: endpoint,
    method: "POST", purpose: "write", timeoutMs: WRITE_TIMEOUT_MS,
    maxBytes: MAX_REPLY_BYTES, headers, body: JSON.stringify(input) });
  const posted = amuxV19ReplyJson(written);
  if (written.kind === "response" && written.status === 200 &&
      validWrite(posted, input)) return { kind: "recorded",
    recovered: false, retryWrite: false,
    digest: posted.digest, digestKeyId: posted.digestKeyId,
    planState: posted.plan.state,
    registrationState: posted.registration.state };
  const receiptUrl = new URL(endpoint);
  for (const name of ["claimId", "requestId", "reservationId", "ideaId",
    "invocationOrdinal"]) receiptUrl.searchParams.set(name,
    String(input[name]));
  const read = await amuxV19AppRequest({ fetchImpl,
    url: receiptUrl.toString(), method: "GET", purpose: "readback",
    timeoutMs: READ_TIMEOUT_MS, maxBytes: MAX_REPLY_BYTES, headers });
  const receipt = amuxV19ReplyJson(read);
  if (read.kind === "response" && read.status === 200 &&
      validRead(receipt, input)) return { kind: "recorded",
    recovered: true, retryWrite: false,
    digest: receipt.digest, digestKeyId: receipt.digestKeyId };
  // The owner must resolve an unknown outcome.
  return { kind: "outcome_unknown", retryWrite: false,
    reason: amuxV19UnconfirmedWriteReason(written, read) };
}
