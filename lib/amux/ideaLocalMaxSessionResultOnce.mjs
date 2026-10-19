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
    input.inputTokens + input.outputTokens > 0;
}

async function boundedJson(response) {
  if (response.headers.get("content-type")?.split(";")[0]?.trim()
    .toLowerCase() !== "application/json") return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) return null;
      bytes += value.byteLength;
      if (bytes > 1_024) return null;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch { return null; }
  finally {
    for (const chunk of chunks) chunk.fill(0);
    try { await reader.cancel(); } catch { /* Never log response data. */ }
    reader.releaseLock();
  }
}

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

/** Exactly one result write after the verified Max checkout receipts. A
 * lost response gets one content-free read; it never resends model output. */
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
  let response = null;
  try {
    response = await fetchImpl(endpoint, { method: "POST",
      redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
      headers, body: JSON.stringify(input) });
    if (response.status === 200 &&
        (!response.url || response.url === endpoint)) {
      const value = await boundedJson(response);
      if (validWrite(value, input)) return { kind: "recorded",
        recovered: false, retryWrite: false,
        digest: value.digest, digestKeyId: value.digestKeyId,
        planState: value.plan.state,
        registrationState: value.registration.state };
    }
  } catch { /* Unknown write outcome. */ }
  try { await response?.body?.cancel(); } catch { /* No raw output in logs. */ }
  const receiptUrl = new URL(endpoint);
  for (const name of ["claimId", "requestId", "reservationId", "ideaId",
    "invocationOrdinal"]) receiptUrl.searchParams.set(name,
    String(input[name]));
  const readEndpoint = receiptUrl.toString();
  try {
    const receipt = await fetchImpl(readEndpoint, { method: "GET",
      redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS), headers });
    if (receipt.status === 200 &&
        (!receipt.url || receipt.url === readEndpoint)) {
      const value = await boundedJson(receipt);
      if (validRead(value, input)) return { kind: "recorded",
        recovered: true, retryWrite: false,
        digest: value.digest, digestKeyId: value.digestKeyId };
    }
    try { await receipt.body?.cancel(); } catch { /* No response logging. */ }
  } catch { /* The owner must resolve an unknown outcome. */ }
  return { kind: "outcome_unknown", retryWrite: false };
}
