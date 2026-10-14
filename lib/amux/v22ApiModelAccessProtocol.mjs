import { createHash } from "node:crypto";

export const AMUX_V22_API_MODEL_ACCESS_VERSION = 1;
export const AMUX_V22_API_MODEL_ACCESS_KIND = "api_model_access";
export const AMUX_V22_API_MODEL_ACCESS_TASK_ID =
  "c48886b9-86f8-4631-8db8-c0b288a707af";
export const AMUX_V22_API_MODEL_ACCESS_PRIOR_ATTEMPT_ID =
  "97858395-3d66-42fa-9bfb-0e5a6cba39d8";
export const AMUX_V22_API_MODEL_ACCESS_MAXIMUM_COST_MICROUSD = 3_400_000;
export const AMUX_V22_API_MODEL_ACCESS_WORST_EXPOSURE_MICROUSD = 6_800_000;
export const AMUX_V22_API_MODEL_ACCESS_PROVIDER_HOST = "api.anthropic.com";
export const AMUX_V22_API_MODEL_ACCESS_ANTHROPIC_VERSION = "2023-06-01";
export const AMUX_V22_API_MODEL_ACCESS_TIMEOUT_MS = 3_000;
export const AMUX_V22_API_MODEL_ACCESS_MAX_RESPONSE_BYTES = 32 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const WORKER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODEL = /^claude-[A-Za-z0-9._-]{1,120}$/;
const REQUEST_KEYS = ["apiExecutionFrameDigest", "credentialMetadataDigest",
  "launchProofDigest", "launchProofId", "launcherConfigDigest", "priorAttemptId",
  "provider", "requestId", "selectedModelId", "taskId", "version", "worker"]
  .sort().join(",");
const RESULT_KEYS = ["access", "apiExecutionFrameDigest", "balanceKnown",
  "canonicalModelId", "credentialMetadataDigest", "kind", "launchProofDigest",
  "launchProofId", "launcherConfigDigest", "maximumCostMicroUsd", "priorAttemptId",
  "provider", "providerHost", "reason", "requestId", "selectedModelId", "taskId",
  "version", "worker", "worstExposureMicroUsd"].sort().join(",");
const REASONS = new Set(["auth_failed", "model_unavailable", "rate_limited",
  "provider_unavailable", "request_timeout", "transport_unknown",
  "invalid_response", "outcome_unknown"]);

const exactKeys = (value, keys) => value !== null && typeof value === "object" &&
  !Array.isArray(value) && Object.keys(value).sort().join(",") === keys;

const canonicalJson = value => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
};

export function parseAmuxV22ApiModelAccessRequest(raw) {
  if (!exactKeys(raw, REQUEST_KEYS) ||
      raw.version !== AMUX_V22_API_MODEL_ACCESS_VERSION ||
      !UUID.test(raw.requestId) || raw.launchProofId !== raw.requestId ||
      raw.taskId !== AMUX_V22_API_MODEL_ACCESS_TASK_ID ||
      raw.priorAttemptId !== AMUX_V22_API_MODEL_ACCESS_PRIOR_ATTEMPT_ID ||
      !WORKER.test(raw.worker) || raw.provider !== "anthropic" ||
      !MODEL.test(raw.selectedModelId) ||
      ![raw.launchProofDigest, raw.apiExecutionFrameDigest,
        raw.credentialMetadataDigest, raw.launcherConfigDigest].every(value =>
        DIGEST.test(value))) throw new TypeError("invalid API model access request");
  return Object.freeze({ ...raw });
}

export function amuxV22ApiModelAccessResult(request, input) {
  const parsed = parseAmuxV22ApiModelAccessRequest(request);
  const access = input?.access;
  const canonicalModelId = input?.canonicalModelId ?? null;
  const reason = input?.reason ?? null;
  if (!['verified', 'unavailable', 'unknown'].includes(access) ||
      (access === "verified" ? !MODEL.test(canonicalModelId) || reason !== null :
        canonicalModelId !== null || !REASONS.has(reason)))
    throw new TypeError("invalid API model access result");
  return Object.freeze({
    version: AMUX_V22_API_MODEL_ACCESS_VERSION,
    kind: AMUX_V22_API_MODEL_ACCESS_KIND,
    requestId: parsed.requestId,
    taskId: parsed.taskId,
    priorAttemptId: parsed.priorAttemptId,
    worker: parsed.worker,
    provider: parsed.provider,
    providerHost: AMUX_V22_API_MODEL_ACCESS_PROVIDER_HOST,
    selectedModelId: parsed.selectedModelId,
    canonicalModelId,
    launchProofId: parsed.launchProofId,
    launchProofDigest: parsed.launchProofDigest,
    apiExecutionFrameDigest: parsed.apiExecutionFrameDigest,
    credentialMetadataDigest: parsed.credentialMetadataDigest,
    launcherConfigDigest: parsed.launcherConfigDigest,
    access,
    reason,
    balanceKnown: false,
    maximumCostMicroUsd: AMUX_V22_API_MODEL_ACCESS_MAXIMUM_COST_MICROUSD,
    worstExposureMicroUsd: AMUX_V22_API_MODEL_ACCESS_WORST_EXPOSURE_MICROUSD,
  });
}

export function parseAmuxV22ApiModelAccessResult(raw) {
  if (!exactKeys(raw, RESULT_KEYS) || raw.kind !== AMUX_V22_API_MODEL_ACCESS_KIND ||
      raw.providerHost !== AMUX_V22_API_MODEL_ACCESS_PROVIDER_HOST ||
      raw.balanceKnown !== false ||
      raw.maximumCostMicroUsd !== AMUX_V22_API_MODEL_ACCESS_MAXIMUM_COST_MICROUSD ||
      raw.worstExposureMicroUsd !== AMUX_V22_API_MODEL_ACCESS_WORST_EXPOSURE_MICROUSD)
    throw new TypeError("invalid API model access result");
  const request = parseAmuxV22ApiModelAccessRequest({
    version: raw.version, requestId: raw.requestId, taskId: raw.taskId,
    priorAttemptId: raw.priorAttemptId, worker: raw.worker, provider: raw.provider,
    selectedModelId: raw.selectedModelId, launchProofId: raw.launchProofId,
    launchProofDigest: raw.launchProofDigest,
    apiExecutionFrameDigest: raw.apiExecutionFrameDigest,
    credentialMetadataDigest: raw.credentialMetadataDigest,
    launcherConfigDigest: raw.launcherConfigDigest,
  });
  const expected = amuxV22ApiModelAccessResult(request, {
    access: raw.access, canonicalModelId: raw.canonicalModelId, reason: raw.reason,
  });
  if (canonicalJson(expected) !== canonicalJson(raw))
    throw new TypeError("invalid API model access result");
  return expected;
}

export function amuxV22ApiModelAccessEvidenceDigest(raw) {
  const result = parseAmuxV22ApiModelAccessResult(raw);
  return createHash("sha256")
    .update("amux-v22-api-model-access-evidence-v1\n", "utf8")
    .update(canonicalJson(result), "utf8").digest("hex");
}
