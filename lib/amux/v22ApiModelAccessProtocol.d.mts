export type AmuxV22ApiModelAccessRequest = Readonly<{
  version: 1;
  requestId: string;
  taskId: string;
  priorAttemptId: string;
  worker: string;
  provider: "anthropic";
  selectedModelId: string;
  launchProofId: string;
  launchProofDigest: string;
  apiExecutionFrameDigest: string;
  credentialMetadataDigest: string;
  launcherConfigDigest: string;
}>;

export type AmuxV22ApiModelAccessResult = Readonly<{
  version: 1;
  kind: "api_model_access";
  requestId: string;
  taskId: string;
  priorAttemptId: string;
  worker: string;
  provider: "anthropic";
  providerHost: "api.anthropic.com";
  selectedModelId: string;
  canonicalModelId: string | null;
  launchProofId: string;
  launchProofDigest: string;
  apiExecutionFrameDigest: string;
  credentialMetadataDigest: string;
  launcherConfigDigest: string;
  access: "verified" | "unavailable" | "unknown";
  reason: "auth_failed" | "model_unavailable" | "rate_limited" |
    "provider_unavailable" | "request_timeout" | "transport_unknown" |
    "invalid_response" | "outcome_unknown" | null;
  balanceKnown: false;
  maximumCostMicroUsd: 3400000;
  worstExposureMicroUsd: 6800000;
}>;

export declare const AMUX_V22_API_MODEL_ACCESS_VERSION: 1;
export declare const AMUX_V22_API_MODEL_ACCESS_KIND: "api_model_access";
export declare const AMUX_V22_API_MODEL_ACCESS_TASK_ID: string;
export declare const AMUX_V22_API_MODEL_ACCESS_PRIOR_ATTEMPT_ID: string;
export declare const AMUX_V22_API_MODEL_ACCESS_MAXIMUM_COST_MICROUSD: 3400000;
export declare const AMUX_V22_API_MODEL_ACCESS_WORST_EXPOSURE_MICROUSD: 6800000;
export declare const AMUX_V22_API_MODEL_ACCESS_PROVIDER_HOST: "api.anthropic.com";
export declare const AMUX_V22_API_MODEL_ACCESS_ANTHROPIC_VERSION: "2023-06-01";
export declare const AMUX_V22_API_MODEL_ACCESS_TIMEOUT_MS: 3000;
export declare const AMUX_V22_API_MODEL_ACCESS_MAX_RESPONSE_BYTES: 32768;
export declare function parseAmuxV22ApiModelAccessRequest(
  raw: unknown,
): AmuxV22ApiModelAccessRequest;
export declare function amuxV22ApiModelAccessResult(
  request: unknown,
  input: { access: AmuxV22ApiModelAccessResult["access"];
    canonicalModelId?: string | null; reason?: AmuxV22ApiModelAccessResult["reason"] },
): AmuxV22ApiModelAccessResult;
export declare function parseAmuxV22ApiModelAccessResult(
  raw: unknown,
): AmuxV22ApiModelAccessResult;
export declare function amuxV22ApiModelAccessEvidenceDigest(raw: unknown): string;
