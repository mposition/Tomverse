export type AmuxV22ReadOnlyApiTokenLimits = {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
};

export type AmuxV22ReadOnlyApiExecutionFrame = {
  version: 1;
  executorKind: "read_only_api_retry_v1";
  provider: "anthropic";
  modelId: string;
  routeId: string;
  routePolicyDigest: string;
  catalogApprovalId: string;
  catalogVersion: string;
  catalogDigest: string;
  pricingVersion: string;
  pricingSource: string;
  pricingVerifiedAt: string;
  pricingExpiresAt: string;
  uncachedInputMicroUsdPerMillion: number;
  cacheReadMicroUsdPerMillion: number;
  cacheWriteMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
  tokenLimits: AmuxV22ReadOnlyApiTokenLimits;
  maxProviderTurns: 8;
  maxOutputTokensPerTurn: number;
  maxRetries: 0;
  maximumCostMicroUsd: number;
  credentialProfileId: string;
  credentialMetadataDigest: string;
  executorArtifactDigest: string;
  settingsDigest: string;
  repositoryScopeDigest: string;
  brokerPolicyDigest: string;
  toolSchemaDigest: string;
};

export type AmuxV22ReadOnlyApiLaunchScope = {
  version: 1;
  executorKind: "read_only_api_retry_v1";
  launcherConfigDigest: string;
  apiExecutionFrameDigest: string;
};

export type AmuxV22ReadOnlyApiExecutionReceipt = {
  version: 1;
  executorKind: "read_only_api_retry_v1";
  attemptId: string;
  invocationId: string;
  selectedModelId: string;
  actualModelId: string;
  actualModelUniform: true;
  providerTurnCount: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  usageComplete: true;
  terminalStatus: "succeeded" | "failed";
  apiExecutionFrameDigest: string;
  projectedCostMicroUsd: number;
  digest: string;
};

export declare const AMUX_V22_READ_ONLY_API_EXECUTOR_KIND: "read_only_api_retry_v1";
export declare const AMUX_V22_READ_ONLY_API_CAPABILITY: "read_only_api_retry_v1";
export declare const AMUX_V22_READ_ONLY_API_MAX_PROVIDER_TURNS: 8;
export declare const AMUX_V22_READ_ONLY_API_MAX_RETRIES: 0;
export declare const AMUX_V22_READ_ONLY_API_MAX_COST_MICROUSD: 3400000;
export declare const AMUX_V22_READ_ONLY_API_MAX_EXPOSURE_MICROUSD: 6800000;
export declare const AMUX_V22_READ_ONLY_API_PROVIDER_URL:
  "https://api.anthropic.com/v1/messages";
export declare const AMUX_V22_READ_ONLY_API_COUNT_TOKENS_URL:
  "https://api.anthropic.com/v1/messages/count_tokens";
export declare const AMUX_V22_READ_ONLY_API_BROKER_POLICY: Readonly<{
  version: 2;
  tools: readonly ["Glob", "Grep", "Read"];
  maxReadBytes: number;
  maxResultBytes: number;
  maxScannedBytes: number;
  maxFiles: number;
  maxMatches: number;
  maxLines: number;
  maxDepth: number;
  timeoutMs: number;
  sort: string;
  symlinks: string;
  specialFiles: string;
  secretScan: string;
  repositoryProvenance: Readonly<Record<string, unknown>>;
}>;
export declare const AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST: string;
export declare const AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST: string;
export declare const AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST: string;
export declare const AMUX_V22_READ_ONLY_API_TOOL_DEFINITIONS: readonly unknown[];
export declare const AMUX_V22_READ_ONLY_API_HOST_ERRORS: Readonly<Record<string, string>>;

export declare function parseAmuxV22ReadOnlyApiExecutionFrame(
  raw: unknown,
  options?: { now?: Date | string | number },
): AmuxV22ReadOnlyApiExecutionFrame;
export declare function amuxV22ReadOnlyApiExecutionFrameDigest(
  frame: AmuxV22ReadOnlyApiExecutionFrame,
): string;
export declare function amuxV22ReadOnlyApiNominalLaunchScope(
  frame: AmuxV22ReadOnlyApiExecutionFrame,
  launcherConfigDigest: string,
): Readonly<AmuxV22ReadOnlyApiLaunchScope>;
export declare function amuxV22ReadOnlyApiActualLaunchScope(
  nominal: AmuxV22ReadOnlyApiLaunchScope,
  actualLauncherConfigDigest: string,
): Readonly<AmuxV22ReadOnlyApiLaunchScope>;
export declare function matchAmuxV22ReadOnlyApiLaunchScopes(
  nominal: unknown,
  actual: unknown,
): boolean;
export declare function amuxV22ReadOnlyApiLaunchScopeDigest(
  scope: AmuxV22ReadOnlyApiLaunchScope,
): string;
export declare function amuxV22ReadOnlyApiRepositoryScopeDigest(scope: {
  sourceRevision: string;
  allowedPrefixes: string[];
}): string;
export declare function projectAmuxV22ReadOnlyApiCost(
  frame: AmuxV22ReadOnlyApiExecutionFrame,
  usage: AmuxV22ReadOnlyApiTokenLimits,
): number;
export declare function amuxV22ReadOnlyApiExecutionReceiptDigest(
  receiptWithoutDigest: Omit<AmuxV22ReadOnlyApiExecutionReceipt, "digest">,
): string;
export declare function parseAmuxV22ReadOnlyApiExecutionReceipt(
  raw: unknown,
  frame: AmuxV22ReadOnlyApiExecutionFrame,
): AmuxV22ReadOnlyApiExecutionReceipt;
