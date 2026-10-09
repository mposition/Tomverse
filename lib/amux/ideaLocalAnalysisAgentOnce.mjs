import { randomUUID } from "node:crypto";
import { executeAmuxCliWithUsageReceipt } from
  "./cliUsageExecutionWrapper.mjs";
import { amuxV4AnalysisCliDiagnostic, amuxV4AnalysisWithCliDiagnostic } from
  "./ideaLocalAnalysisDiagnostics.mjs";

import { pollAmuxV4AnalysisCandidateIds,
  AMUX_V4_ANALYSIS_APP_ORIGIN_ENV } from "./ideaLocalQueuePoll.mjs";
import { amuxV4ApprovedAnalysisCliForModel,
  amuxV4CanClaimAnalysisCli } from
  "./ideaLocalApprovedCliCatalog.mjs";
import { AMUX_V4_LIVE_ANALYSIS_CLI_ENV,
  amuxV4LiveAnalysisCliEnabled,
  runAmuxV4IsolatedApprovedAnalysis } from
  "./ideaLocalIsolatedCliRunner.mjs";

const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const MAX_CLAIM_BYTES = 64 * 1024;
const READ_TIMEOUT_MS = 8_000;
// Claim and result writers can each wait five seconds for a transaction and
// run for fifteen. A shorter HTTP timeout turns a valid commit into unknown.
const WRITE_TIMEOUT_MS = 25_000;

const exactKeys = (value, names) => value !== null &&
  typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === names.length &&
  names.every((name) => Object.hasOwn(value, name));

const pinnedOrigin = (value) => {
  try {
    const target = new URL(value);
    const configured = new URL(process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV] ?? "");
    return target.protocol === "https:" && !target.username && !target.password &&
      target.pathname === "/" && !target.search && !target.hash &&
      target.toString() === configured.toString() ? target.origin : null;
  } catch { return null; }
};

const boundedJson = async (response, limit) => {
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
      if (total > limit) return null;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch { return null; }
  finally {
    for (const chunk of chunks) chunk.fill(0);
    try { await reader.cancel(); } catch { /* Never log response content. */ }
    reader.releaseLock();
  }
};

const appPost = async (origin, path, secret, body, fetchImpl) => {
  const endpoint = `${origin}${path}`;
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST", redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
      headers: { authorization: `Bearer ${secret}`,
        "x-amux-agent-id": "amux-intake", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.url && response.url !== endpoint) {
      try { await response.body?.cancel(); } catch { /* No response body in diagnostics. */ }
      return null;
    }
    return { status: response.status, body: await boundedJson(response, MAX_CLAIM_BYTES) };
  } catch { return null; }
};

const resultReadBack = async (origin, secret, requestId, previewId, fetchImpl) => {
  const url = new URL("/api/internal/amux/v4/analysis-result", origin);
  url.searchParams.set("requestId", requestId);
  url.searchParams.set("previewId", previewId);
  const endpoint = url.toString();
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET", redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      headers: { authorization: `Bearer ${secret}`,
        "x-amux-agent-id": "amux-intake" },
    });
    if (response.url && response.url !== endpoint) return null;
    return response.status === 200
      ? await boundedJson(response, MAX_CLAIM_BYTES) : null;
  } catch { return null; }
};

/** A lost claim reply may already have consumed the owner's preview. Only
 * read back a content-free receipt: never replay the claim or run the CLI
 * from this result, even when the app confirms that the claim committed. */
const claimReadBack = async (origin, secret, requestId, previewId, fetchImpl) => {
  const url = new URL("/api/internal/amux/v4/analysis-claim", origin);
  url.searchParams.set("requestId", requestId);
  url.searchParams.set("previewId", previewId);
  const endpoint = url.toString();
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET", redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      headers: { authorization: `Bearer ${secret}`,
        "x-amux-agent-id": "amux-intake" },
    });
    if (response.url && response.url !== endpoint) return null;
    return response.status === 200
      ? await boundedJson(response, MAX_CLAIM_BYTES) : null;
  } catch { return null; }
};

const cliUsageReadBack = async (origin, secret, invocationId, fetchImpl) => {
  const url = new URL("/api/internal/amux/cli-usage", origin);
  url.searchParams.set("invocationId", invocationId);
  const endpoint = url.toString();
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET", redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      headers: { authorization: `Bearer ${secret}`,
        "x-amux-agent-id": "amux-intake" },
    });
    if (response.url && response.url !== endpoint) return null;
    return response.status === 200
      ? await boundedJson(response, 1024) : null;
  } catch { return null; }
};

const validClaim = (claim, candidate) => exactKeys(claim,
  ["previewId", "ideaId", "holdId", "leaseGeneration", "provider",
    "modelId", "reasoningEffort", "prompt", "auditId"]) &&
  claim.previewId === candidate.previewId && claim.ideaId === candidate.ideaId &&
  claim.modelId === candidate.modelId && claim.leaseGeneration === 1 &&
  ["openai", "anthropic"].includes(claim.provider) &&
  [claim.previewId, claim.ideaId, claim.holdId, claim.auditId]
    .every((value) => typeof value === "string" && ID.test(value)) &&
  typeof claim.reasoningEffort === "string" &&
  ["low", "medium", "high", "xhigh", "max", "ultra"]
    .includes(claim.reasoningEffort) &&
  typeof claim.prompt === "string" &&
  Buffer.byteLength(claim.prompt, "utf8") <= 32_768 &&
  claim.prompt.includes(`"previewId":"${candidate.previewId}"`);

/** Synthetic transport proof only. NODE_ENV=test and a caller-provided fake
 * executor are mandatory, while the real app claim route remains code-latched
 * off. This cannot call a provider CLI or persist a live result. The local
 * supervisor always stops on a lost claim or result and never retries. */
async function runAmuxV4AnalysisAgentOnce(input, execute, admitCandidate) {
  const origin = pinnedOrigin(input.origin);
  if (!origin) return { kind: "refused" };
  const queue = await pollAmuxV4AnalysisCandidateIds({ origin,
    agentSecret: input.agentSecret, fetchImpl: input.fetchImpl });
  if (queue.kind !== "candidates") return { kind: queue.kind };
  if (queue.candidates.length === 0) return { kind: "idle" };
  // An unsupported model at the front of the page must not starve an
  // independently approved candidate. Never claim or inspect its prompt.
  const candidate = queue.candidates.find(admitCandidate);
  if (!candidate) return { kind: "catalog_unapproved" };
  const claimRequestId = randomUUID();
  const claimed = await appPost(origin, "/api/internal/amux/v4/analysis-claim",
    input.agentSecret, { previewId: candidate.previewId,
      requestId: claimRequestId }, input.fetchImpl);
  if (claimed?.status === 409 && exactKeys(claimed.body,
    ["available", "reason"]) && claimed.body.available === false &&
      claimed.body.reason === "analysis_claim_disabled") return { kind: "disabled" };
  if (!claimed || claimed.status !== 200 || !validClaim(claimed.body, candidate)) {
    const readBack = await claimReadBack(origin, input.agentSecret,
      claimRequestId, candidate.previewId, input.fetchImpl);
    return exactKeys(readBack, ["status", "requestId", "previewId", "ideaId"]) &&
      readBack.status === "committed" && readBack.requestId === claimRequestId &&
      readBack.previewId === candidate.previewId &&
      readBack.ideaId === candidate.ideaId
      ? { kind: "claim_committed_unexecuted" } : { kind: "claim_unknown" };
  }
  const prompt = Buffer.from(claimed.body.prompt, "utf8");
  let produced;
  try {
    produced = await execute({ prompt, provider: claimed.body.provider,
      modelId: claimed.body.modelId,
      reasoningEffort: claimed.body.reasoningEffort }, {
      holdId: claimed.body.holdId, origin, agentSecret: input.agentSecret,
      fetchImpl: input.fetchImpl });
  } catch { produced = null; }
  finally { prompt.fill(0); }
  const measured = produced && Number.isSafeInteger(produced.inputTokens) &&
    produced.inputTokens >= 0 && Number.isSafeInteger(produced.outputTokens) &&
    produced.outputTokens >= 0 &&
    produced.inputTokens + produced.outputTokens > 0;
  const boundedOutput = measured && typeof produced.rawModelOutput === "string" &&
    Buffer.byteLength(produced.rawModelOutput, "utf8") <= 65_536;
  const outcome = !measured ? "outcome_unknown" :
    boundedOutput ? "verified_success" : "invocation_failed";
  const requestId = randomUUID();
  const result = await appPost(origin, "/api/internal/amux/v4/analysis-result",
    input.agentSecret, { requestId, previewId: claimed.body.previewId,
      ideaId: claimed.body.ideaId, holdId: claimed.body.holdId,
      leaseGeneration: 1, outcome,
      rawModelOutput: boundedOutput ? produced.rawModelOutput : null,
      inputTokens: measured ? produced.inputTokens : null,
      outputTokens: measured ? produced.outputTokens : null }, input.fetchImpl);
  if (result?.status === 409 && exactKeys(result.body,
    ["available", "reason"]) && result.body.available === false &&
      result.body.reason === "analysis_result_disabled") {
    // The CLI has already run. A disabled result writer is not a known-safe
    // idle outcome; preserve the local halt and the app's in-flight hold.
    return { kind: "result_unknown" };
  }
  const expectedState = outcome === "verified_success" ? "draft_ready" :
    outcome === "invocation_failed" ? "provider_failed" : "outcome_unknown";
  const acceptableStates = outcome === "verified_success"
    ? ["draft_ready", "provider_failed"] : [expectedState];
  if (result?.status === 200 && exactKeys(result.body,
    ["previewId", "ideaId", "state", "duplicate", "auditId"]) &&
      result.body.previewId === claimed.body.previewId &&
      result.body.ideaId === claimed.body.ideaId &&
      acceptableStates.includes(result.body.state) &&
      typeof result.body.duplicate === "boolean" &&
      typeof result.body.auditId === "string" && ID.test(result.body.auditId)) {
    return { kind: result.body.state };
  }
  const readBack = await resultReadBack(origin, input.agentSecret, requestId,
    claimed.body.previewId, input.fetchImpl);
  return exactKeys(readBack,
    ["status", "previewId", "ideaId", "state", "duplicate", "auditId"]) &&
    readBack.status === "committed" &&
    readBack.previewId === claimed.body.previewId &&
    readBack.ideaId === claimed.body.ideaId &&
    acceptableStates.includes(readBack.state) &&
    readBack.duplicate === true &&
    typeof readBack.auditId === "string" && ID.test(readBack.auditId)
    ? { kind: readBack.state } : { kind: "result_unknown" };
}

export async function runAmuxV4SyntheticAnalysisAgentOnce(input) {
  if (process.env.NODE_ENV !== "test" || !input ||
      typeof input.fakeExecute !== "function" ||
      (input.fakeAdmit !== undefined && typeof input.fakeAdmit !== "function") ||
      typeof input.fetchImpl !== "function" ||
      typeof input.agentSecret !== "string" || !SECRET.test(input.agentSecret)) {
    return { kind: "refused" };
  }
  return runAmuxV4AnalysisAgentOnce(input, input.fakeExecute,
    input.fakeAdmit ?? (() => true));
}

/** Synthetic contract check for the future live admission path. The live CLI
 * connector is deliberately absent until isolation and catalog review pass. */
export async function runAmuxV4LocalAnalysisAdmissionForTest(input) {
  if (process.env.NODE_ENV !== "test" || !input ||
      typeof input.fakeExecute !== "function" ||
      typeof input.fetchImpl !== "function" ||
      typeof input.agentSecret !== "string" || !SECRET.test(input.agentSecret)) {
    return { kind: "refused" };
  }
  return runAmuxV4AnalysisAgentOnce(input, input.fakeExecute,
    (candidate) => amuxV4ApprovedAnalysisCliForModel(candidate.modelId) !== null);
}

/** Only verified CLI output may become a draft; queue, claim, result and the
 * exact CLI tuple retain independent admission gates. */
export const amuxV4VerifiedCliOutputOrNull = (result) =>
  result?.kind === "verified_success" ? result : null;

export async function runAmuxV4LocalAnalysisAgentOnce(input) {
  if (!amuxV4LiveAnalysisCliEnabled(
        process.env[AMUX_V4_LIVE_ANALYSIS_CLI_ENV]) ||
      process.platform !== "linux" || !input ||
      typeof input.agentSecret !== "string" || !SECRET.test(input.agentSecret) ||
      typeof input.fetchImpl !== "function") return { kind: "refused" };
  let cliDiagnostic = null;
  const result = await runAmuxV4AnalysisAgentOnce(input, async (execution, binding) => {
    const wrapped = await executeAmuxCliWithUsageReceipt({
      binding: { kind: "idea_analysis", holdId: binding.holdId },
      worker: "amux-intake", selectedModelId: execution.modelId,
      invoke: async () => {
        const cliResult = await runAmuxV4IsolatedApprovedAnalysis(execution);
        cliDiagnostic = amuxV4AnalysisCliDiagnostic(cliResult);
        return cliResult;
      },
      record: async (receipt) => {
        const saved = await appPost(binding.origin,
          "/api/internal/amux/cli-usage", binding.agentSecret, receipt,
          binding.fetchImpl);
        return saved?.status === 200 ? saved.body : null;
      },
      readBack: (invocationId) => cliUsageReadBack(binding.origin,
        binding.agentSecret, invocationId, binding.fetchImpl),
    });
    if (wrapped.kind !== "recorded") return null;
    // A requested Codex model is not served-model attestation. Never submit
    // its text or usage as a verified draft, even if transport succeeded.
    return amuxV4VerifiedCliOutputOrNull(wrapped.result);
  }, (candidate) => amuxV4CanClaimAnalysisCli(
    amuxV4ApprovedAnalysisCliForModel(candidate.modelId), candidate.modelId));
  return amuxV4AnalysisWithCliDiagnostic(result,
    cliDiagnostic ? { kind: "outcome_unknown", ...cliDiagnostic } : null);
}
