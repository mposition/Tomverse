import { createHash } from "node:crypto";

export const AMUX_V22_READ_ONLY_API_EXECUTOR_KIND = "read_only_api_retry_v1";
export const AMUX_V22_READ_ONLY_API_CAPABILITY = "read_only_api_retry_v1";
export const AMUX_V22_READ_ONLY_API_FRAME_VERSION = 1;
export const AMUX_V22_READ_ONLY_API_RECEIPT_VERSION = 1;
export const AMUX_V22_READ_ONLY_API_MAX_PROVIDER_TURNS = 8;
export const AMUX_V22_READ_ONLY_API_MAX_RETRIES = 0;
export const AMUX_V22_READ_ONLY_API_MAX_COST_MICROUSD = 3_400_000;
export const AMUX_V22_READ_ONLY_API_MAX_EXPOSURE_MICROUSD = 6_800_000;
export const AMUX_V22_READ_ONLY_API_PROVIDER_URL =
  "https://api.anthropic.com/v1/messages";
export const AMUX_V22_READ_ONLY_API_COUNT_TOKENS_URL =
  "https://api.anthropic.com/v1/messages/count_tokens";
export const AMUX_V22_READ_ONLY_API_ANTHROPIC_VERSION = "2023-06-01";

export const AMUX_V22_READ_ONLY_API_HOST_ERRORS = Object.freeze({
  disabled: "read_only_api_executor_disabled",
  frameInvalid: "read_only_api_frame_invalid",
  receiptIncomplete: "read_only_api_receipt_incomplete",
  outcomeUnknown: "read_only_api_outcome_unknown",
});

const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9._:/-]{1,160}$/;
const MODEL = /^claude-[A-Za-z0-9._:-]{1,152}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const FRAME_KEYS = [
  "brokerPolicyDigest", "cacheReadMicroUsdPerMillion",
  "cacheWriteMicroUsdPerMillion", "catalogApprovalId", "catalogDigest",
  "catalogVersion", "credentialMetadataDigest", "credentialProfileId",
  "executorArtifactDigest", "executorKind", "maxOutputTokensPerTurn",
  "maxProviderTurns", "maxRetries", "maximumCostMicroUsd", "modelId",
  "outputMicroUsdPerMillion", "pricingExpiresAt", "pricingSource",
  "pricingVerifiedAt", "pricingVersion", "provider", "repositoryScopeDigest",
  "routeId", "routePolicyDigest", "settingsDigest", "tokenLimits",
  "toolSchemaDigest", "uncachedInputMicroUsdPerMillion", "version",
].sort().join(",");
const TOKEN_LIMIT_KEYS = [
  "cacheReadTokens", "cacheWriteTokens", "outputTokens", "uncachedInputTokens",
].sort().join(",");
const SCOPE_KEYS = [
  "apiExecutionFrameDigest", "executorKind", "launcherConfigDigest", "version",
].sort().join(",");
const RECEIPT_BODY_KEYS = [
  "actualModelId", "actualModelUniform", "apiExecutionFrameDigest", "attemptId",
  "cacheReadTokens", "cacheWriteTokens", "executorKind", "invocationId",
  "outputTokens", "projectedCostMicroUsd", "providerTurnCount", "selectedModelId",
  "terminalStatus", "uncachedInputTokens", "usageComplete", "version",
].sort().join(",");
const RECEIPT_KEYS = `${RECEIPT_BODY_KEYS},digest`.split(",").sort().join(",");

const exactKeys = (value, keys) => value !== null && typeof value === "object" &&
  !Array.isArray(value) && Object.keys(value).sort().join(",") === keys;
const nonnegativeSafeInteger = value => Number.isSafeInteger(value) && value >= 0;
const positiveSafeInteger = value => Number.isSafeInteger(value) && value > 0;
const validUtc = value => typeof value === "string" && UTC.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function amuxV22ReadOnlyApiCanonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(amuxV22ReadOnlyApiCanonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${amuxV22ReadOnlyApiCanonicalJson(value[key])}`).join(",")}}`;
}

const digestValue = (domain, value) => createHash("sha256")
  .update(`amux-v22-${domain}-v1\n`, "utf8")
  .update(amuxV22ReadOnlyApiCanonicalJson(value), "utf8")
  .digest("hex");

export const AMUX_V22_READ_ONLY_API_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: "Read",
    description: "Read bounded UTF-8 lines from one approved repository-relative file.",
    input_schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({
        path: Object.freeze({ type: "string", minLength: 1, maxLength: 512 }),
        offset: Object.freeze({ type: "integer", minimum: 1, maximum: 1_000_000 }),
        limit: Object.freeze({ type: "integer", minimum: 1, maximum: 200 }),
      }),
      required: Object.freeze(["path"]),
    }),
  }),
  Object.freeze({
    name: "Grep",
    description: "Find a bounded literal UTF-8 string in approved repository files.",
    input_schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({
        pattern: Object.freeze({ type: "string", minLength: 1, maxLength: 256 }),
        path: Object.freeze({ type: "string", minLength: 1, maxLength: 512 }),
      }),
      required: Object.freeze(["pattern", "path"]),
    }),
  }),
  Object.freeze({
    name: "Glob",
    description: "List bounded approved repository-relative paths matching a glob.",
    input_schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({
        pattern: Object.freeze({ type: "string", minLength: 1, maxLength: 256 }),
      }),
      required: Object.freeze(["pattern"]),
    }),
  }),
]);

const BROKER_POLICY = Object.freeze({
  version: 2,
  tools: Object.freeze(["Glob", "Grep", "Read"]),
  maxReadBytes: 65_536,
  maxResultBytes: 65_536,
  maxScannedBytes: 4 * 1024 * 1024,
  maxFiles: 2_000,
  maxMatches: 200,
  maxLines: 200,
  maxDepth: 32,
  timeoutMs: 2_000,
  sort: "utf8_bytewise",
  symlinks: "refuse",
  specialFiles: "refuse",
  secretScan: "before_model_output",
  repositoryProvenance: Object.freeze({
    nativeLooseObjects: true,
    packedObjectFallback: "fixed_protected_git_v1",
    fixedOperations: Object.freeze(["cat-file", "ls-tree", "rev-parse"]),
    fixedBinary: "host_path_sha256_and_identity",
    inheritedEnvironment: false,
    systemGlobalConfig: "disabled",
    localConfig: "strict_core_plus_remote_origin_verified_but_not_loaded_by_child",
    childGitDir: "configless_reflog_directory_pre_and_post_verified",
    childTimeoutMs: 750,
    maxConcurrentChildren: 1,
    alternates: "refuse",
    replaceObjects: "disabled",
    lazyFetch: "disabled",
    network: "disabled",
    writes: "disabled",
  }),
});

const EXECUTOR_SETTINGS = Object.freeze({
  version: 1,
  providerUrl: AMUX_V22_READ_ONLY_API_PROVIDER_URL,
  countTokensUrl: AMUX_V22_READ_ONLY_API_COUNT_TOKENS_URL,
  anthropicVersion: AMUX_V22_READ_ONLY_API_ANTHROPIC_VERSION,
  redirect: "error",
  transportRetries: 0,
  requestTimeoutMs: 120_000,
  maxProviderTurns: AMUX_V22_READ_ONLY_API_MAX_PROVIDER_TURNS,
});

export const AMUX_V22_READ_ONLY_API_BROKER_POLICY = BROKER_POLICY;
export const AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST =
  digestValue("read-only-api-broker-policy", BROKER_POLICY);
export const AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST =
  digestValue("read-only-api-tool-schema", AMUX_V22_READ_ONLY_API_TOOL_DEFINITIONS);
export const AMUX_V22_READ_ONLY_API_SETTINGS = EXECUTOR_SETTINGS;
export const AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST =
  digestValue("read-only-api-settings", EXECUTOR_SETTINGS);

function structuralFrame(raw) {
  if (!exactKeys(raw, FRAME_KEYS) ||
      raw.version !== AMUX_V22_READ_ONLY_API_FRAME_VERSION ||
      raw.executorKind !== AMUX_V22_READ_ONLY_API_EXECUTOR_KIND ||
      raw.provider !== "anthropic" || !MODEL.test(raw.modelId) ||
      !ID.test(raw.routeId) || !DIGEST.test(raw.routePolicyDigest) ||
      !ID.test(raw.catalogApprovalId) || !ID.test(raw.catalogVersion) ||
      !DIGEST.test(raw.catalogDigest) || !ID.test(raw.pricingVersion) ||
      !ID.test(raw.pricingSource) || !validUtc(raw.pricingVerifiedAt) ||
      !validUtc(raw.pricingExpiresAt) ||
      !positiveSafeInteger(raw.uncachedInputMicroUsdPerMillion) ||
      !nonnegativeSafeInteger(raw.cacheReadMicroUsdPerMillion) ||
      !nonnegativeSafeInteger(raw.cacheWriteMicroUsdPerMillion) ||
      !positiveSafeInteger(raw.outputMicroUsdPerMillion) ||
      !exactKeys(raw.tokenLimits, TOKEN_LIMIT_KEYS) ||
      !positiveSafeInteger(raw.tokenLimits.uncachedInputTokens) ||
      !nonnegativeSafeInteger(raw.tokenLimits.cacheReadTokens) ||
      !nonnegativeSafeInteger(raw.tokenLimits.cacheWriteTokens) ||
      !positiveSafeInteger(raw.tokenLimits.outputTokens) ||
      raw.maxProviderTurns !== AMUX_V22_READ_ONLY_API_MAX_PROVIDER_TURNS ||
      raw.maxOutputTokensPerTurn !== raw.tokenLimits.outputTokens ||
      raw.maxRetries !== AMUX_V22_READ_ONLY_API_MAX_RETRIES ||
      !positiveSafeInteger(raw.maximumCostMicroUsd) ||
      raw.maximumCostMicroUsd > AMUX_V22_READ_ONLY_API_MAX_COST_MICROUSD ||
      !ID.test(raw.credentialProfileId) ||
      [raw.credentialMetadataDigest, raw.executorArtifactDigest, raw.settingsDigest,
        raw.repositoryScopeDigest, raw.brokerPolicyDigest, raw.toolSchemaDigest]
        .some(value => !DIGEST.test(value))) return false;
  if (raw.settingsDigest !== AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST ||
      raw.brokerPolicyDigest !== AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST ||
      raw.toolSchemaDigest !== AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST) return false;
  if (raw.pricingVerifiedAt >= raw.pricingExpiresAt ||
      (raw.tokenLimits.cacheReadTokens > 0 && raw.cacheReadMicroUsdPerMillion < 1) ||
      (raw.tokenLimits.cacheWriteTokens > 0 && raw.cacheWriteMicroUsdPerMillion < 1))
    return false;
  const ceiling = [
    [raw.tokenLimits.uncachedInputTokens, raw.uncachedInputMicroUsdPerMillion],
    [raw.tokenLimits.cacheReadTokens, raw.cacheReadMicroUsdPerMillion],
    [raw.tokenLimits.cacheWriteTokens, raw.cacheWriteMicroUsdPerMillion],
    [raw.tokenLimits.outputTokens, raw.outputMicroUsdPerMillion],
  ].reduce((total, [tokens, rate]) => total +
    (BigInt(tokens) * BigInt(rate) + 999_999n) / 1_000_000n, 0n);
  return ceiling <= BigInt(raw.maximumCostMicroUsd);
}

export function parseAmuxV22ReadOnlyApiExecutionFrame(raw, options = {}) {
  if (!structuralFrame(raw)) throw new TypeError(AMUX_V22_READ_ONLY_API_HOST_ERRORS.frameInvalid);
  if (Object.hasOwn(options, "now")) {
    const now = options.now instanceof Date ? options.now : new Date(options.now);
    if (!Number.isFinite(now.getTime()) || raw.pricingVerifiedAt > now.toISOString() ||
        raw.pricingExpiresAt <= now.toISOString())
      throw new TypeError(AMUX_V22_READ_ONLY_API_HOST_ERRORS.frameInvalid);
  }
  return raw;
}

export function amuxV22ReadOnlyApiExecutionFrameDigest(frame) {
  return digestValue("read-only-api-execution-frame",
    parseAmuxV22ReadOnlyApiExecutionFrame(frame));
}

function parseScope(raw) {
  if (!exactKeys(raw, SCOPE_KEYS) || raw.version !== 1 ||
      raw.executorKind !== AMUX_V22_READ_ONLY_API_EXECUTOR_KIND ||
      !DIGEST.test(raw.launcherConfigDigest) || !DIGEST.test(raw.apiExecutionFrameDigest))
    throw new TypeError(AMUX_V22_READ_ONLY_API_HOST_ERRORS.frameInvalid);
  return raw;
}

export function amuxV22ReadOnlyApiNominalLaunchScope(frame, launcherConfigDigest) {
  if (!DIGEST.test(launcherConfigDigest))
    throw new TypeError(AMUX_V22_READ_ONLY_API_HOST_ERRORS.frameInvalid);
  return Object.freeze({
    version: 1,
    executorKind: AMUX_V22_READ_ONLY_API_EXECUTOR_KIND,
    launcherConfigDigest,
    apiExecutionFrameDigest: amuxV22ReadOnlyApiExecutionFrameDigest(frame),
  });
}

export function amuxV22ReadOnlyApiActualLaunchScope(nominal, actualLauncherConfigDigest) {
  const parsed = parseScope(nominal);
  if (!DIGEST.test(actualLauncherConfigDigest))
    throw new TypeError(AMUX_V22_READ_ONLY_API_HOST_ERRORS.frameInvalid);
  return Object.freeze({ ...parsed, launcherConfigDigest: actualLauncherConfigDigest });
}

export function matchAmuxV22ReadOnlyApiLaunchScopes(nominal, actual) {
  let left;
  let right;
  try { left = parseScope(nominal); right = parseScope(actual); }
  catch { return false; }
  return left.version === right.version && left.executorKind === right.executorKind &&
    left.apiExecutionFrameDigest === right.apiExecutionFrameDigest;
}

export const amuxV22ReadOnlyApiLaunchScopeDigest = scope =>
  digestValue("read-only-api-launch-scope", parseScope(scope));

export function amuxV22ReadOnlyApiRepositoryScopeDigest(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope) ||
      Object.keys(scope).sort().join(",") !== "allowedPrefixes,sourceRevision" ||
      typeof scope.sourceRevision !== "string" ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(scope.sourceRevision) ||
      !Array.isArray(scope.allowedPrefixes) || scope.allowedPrefixes.length < 1 ||
      scope.allowedPrefixes.length > 32 ||
      scope.allowedPrefixes.some(prefix => typeof prefix !== "string" || prefix.length < 1 ||
        prefix.length > 256 || prefix.startsWith("/") || prefix.endsWith("/") ||
        prefix.includes("\\") || prefix.split("/").some(part => !part || part === "." ||
          part === ".." || part.includes("\0") || /^(?:\.git|\.env.*|\.ssh|\.claude|\.codex)$/i.test(part) ||
          /(?:credential|credentials|secret|secrets|id_rsa|id_ed25519|\.npmrc|\.netrc)/i.test(part))) ||
      [...scope.allowedPrefixes].sort((left, right) =>
        Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))).join("\0") !==
        scope.allowedPrefixes.join("\0") || new Set(scope.allowedPrefixes).size !==
        scope.allowedPrefixes.length)
    throw new TypeError(AMUX_V22_READ_ONLY_API_HOST_ERRORS.frameInvalid);
  return digestValue("read-only-api-repository-scope", scope);
}

const ceilMicroUsd = (tokens, rate) =>
  (BigInt(tokens) * BigInt(rate) + 999_999n) / 1_000_000n;

export function projectAmuxV22ReadOnlyApiCost(frame, usage) {
  const parsed = parseAmuxV22ReadOnlyApiExecutionFrame(frame);
  if (!usage || typeof usage !== "object" ||
      ![usage.uncachedInputTokens, usage.cacheReadTokens, usage.cacheWriteTokens,
        usage.outputTokens].every(nonnegativeSafeInteger))
    throw new TypeError(AMUX_V22_READ_ONLY_API_HOST_ERRORS.receiptIncomplete);
  return Number(
    ceilMicroUsd(usage.uncachedInputTokens, parsed.uncachedInputMicroUsdPerMillion) +
    ceilMicroUsd(usage.cacheReadTokens, parsed.cacheReadMicroUsdPerMillion) +
    ceilMicroUsd(usage.cacheWriteTokens, parsed.cacheWriteMicroUsdPerMillion) +
    ceilMicroUsd(usage.outputTokens, parsed.outputMicroUsdPerMillion));
}

export function amuxV22ReadOnlyApiExecutionReceiptDigest(receiptWithoutDigest) {
  if (!exactKeys(receiptWithoutDigest, RECEIPT_BODY_KEYS))
    throw new TypeError(AMUX_V22_READ_ONLY_API_HOST_ERRORS.receiptIncomplete);
  return digestValue("read-only-api-execution-receipt", receiptWithoutDigest);
}

export function parseAmuxV22ReadOnlyApiExecutionReceipt(raw, frame) {
  const parsedFrame = parseAmuxV22ReadOnlyApiExecutionFrame(frame);
  if (!exactKeys(raw, RECEIPT_KEYS) ||
      raw.version !== AMUX_V22_READ_ONLY_API_RECEIPT_VERSION ||
      raw.executorKind !== AMUX_V22_READ_ONLY_API_EXECUTOR_KIND ||
      !UUID.test(raw.attemptId) || !UUID.test(raw.invocationId) ||
      raw.selectedModelId !== parsedFrame.modelId ||
      raw.actualModelId !== raw.selectedModelId || raw.actualModelUniform !== true ||
      !positiveSafeInteger(raw.providerTurnCount) ||
      raw.providerTurnCount > parsedFrame.maxProviderTurns ||
      ![raw.uncachedInputTokens, raw.cacheReadTokens, raw.cacheWriteTokens,
        raw.outputTokens, raw.projectedCostMicroUsd].every(nonnegativeSafeInteger) ||
      raw.usageComplete !== true ||
      !["succeeded", "failed"].includes(raw.terminalStatus) ||
      raw.apiExecutionFrameDigest !== amuxV22ReadOnlyApiExecutionFrameDigest(parsedFrame) ||
      !DIGEST.test(raw.digest))
    throw new TypeError(AMUX_V22_READ_ONLY_API_HOST_ERRORS.receiptIncomplete);
  if (raw.uncachedInputTokens > parsedFrame.tokenLimits.uncachedInputTokens ||
      raw.cacheReadTokens > parsedFrame.tokenLimits.cacheReadTokens ||
      raw.cacheWriteTokens > parsedFrame.tokenLimits.cacheWriteTokens ||
      raw.outputTokens > parsedFrame.tokenLimits.outputTokens ||
      raw.projectedCostMicroUsd !== projectAmuxV22ReadOnlyApiCost(parsedFrame, raw) ||
      raw.projectedCostMicroUsd > parsedFrame.maximumCostMicroUsd)
    throw new TypeError(AMUX_V22_READ_ONLY_API_HOST_ERRORS.receiptIncomplete);
  const body = { ...raw };
  delete body.digest;
  if (raw.digest !== amuxV22ReadOnlyApiExecutionReceiptDigest(body))
    throw new TypeError(AMUX_V22_READ_ONLY_API_HOST_ERRORS.receiptIncomplete);
  return raw;
}
