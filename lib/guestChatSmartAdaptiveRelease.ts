import { createHash } from "node:crypto";

import { chatRefinerInitialAutoRuntimeBinding } from
  "@/lib/chatRefinerInitialAutoRelease";
import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";
import { ROUTER_VERSIONS } from "@/lib/routerDecision";
import {
  PROMPT_REFINER_PRODUCT_ADAPTER_CONFIG_DIGEST,
  PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST,
  PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
} from "@/lib/promptRefinerProductContract";

export const GUEST_CHAT_SMART_ADAPTIVE_POLICY_VERSION = 1 as const;
export const GUEST_CHAT_SMART_ADAPTIVE_POLICY_SHA256 =
  "611d01eb393be9508be760aa9aedb95d0238d30008e5de1d5ca5dae1f0c73cc9" as const;
export const GUEST_CHAT_SMART_ADAPTIVE_ACTION =
  "chat_guest.smart_adaptive_release_activated" as const;
export const GUEST_CHAT_SMART_ADAPTIVE_SUMMARY =
  "Activated Guest Chat Smart Adaptive and Prompt Refiner for the exact deployment." as const;
export const GUEST_CHAT_SMART_ADAPTIVE_ROLLOUT_ENV =
  "CHAT_GUEST_SMART_ADAPTIVE_ROLLOUT_ENABLED" as const;
export const GUEST_CHAT_SMART_ADAPTIVE_WRITER_ENV =
  "CHAT_GUEST_SMART_ADAPTIVE_ACTIVATION_WRITER_ENABLED" as const;
export const GUEST_CHAT_SMART_ADAPTIVE_AUTHORITY_SECRET_ENV =
  "CHAT_GUEST_SMART_ADAPTIVE_AUTHORITY_SECRET" as const;
export const GUEST_CHAT_SMART_ADAPTIVE_AUTHORITY_TTL_ENV =
  "CHAT_GUEST_SMART_ADAPTIVE_AUTHORITY_TTL_SECONDS" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const sha256 = (value: unknown) => createHash("sha256")
  .update(typeof value === "string" ? value : canonicalBenchmarkJson(value), "utf8")
  .digest("hex");

export type GuestChatSmartAdaptiveRuntimeBinding = Readonly<{
  runtimeCommitSha: string;
  runtimeDeploymentId: string;
  configDigest: string;
  baseRouterConfigDigest: string;
  promptRefinerCandidateDigest: string;
  promptRefinerPricePinDigest: string;
  promptRefinerAdapterConfigDigest: string;
}>;

export function guestChatSmartAdaptiveAuthorityTtlSeconds(
  runtime: Record<string, string | undefined> = process.env,
) {
  const raw = runtime[GUEST_CHAT_SMART_ADAPTIVE_AUTHORITY_TTL_ENV]?.trim();
  if (!raw) return 60;
  if (!/^\d+$/.test(raw)) {
    throw new Error("guest_chat_smart_adaptive_authority_ttl_invalid");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 15 || value > 300) {
    throw new Error("guest_chat_smart_adaptive_authority_ttl_invalid");
  }
  return value;
}

/** Exact deployment controls. Secrets are checked for presence, never hashed. */
export function guestChatSmartAdaptiveRuntimeBinding(
  runtime: Record<string, string | undefined> = process.env,
): GuestChatSmartAdaptiveRuntimeBinding {
  if (runtime[GUEST_CHAT_SMART_ADAPTIVE_ROLLOUT_ENV] !== "1") {
    throw new Error("guest_chat_smart_adaptive_rollout_disabled");
  }
  const secret = runtime[GUEST_CHAT_SMART_ADAPTIVE_AUTHORITY_SECRET_ENV] ?? "";
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("guest_chat_smart_adaptive_authority_secret_invalid");
  }
  guestChatSmartAdaptiveAuthorityTtlSeconds(runtime);
  const base = chatRefinerInitialAutoRuntimeBinding(runtime);
  const configDigest = sha256({
    version: "guest-chat-smart-adaptive-config-v1",
    policyVersion: GUEST_CHAT_SMART_ADAPTIVE_POLICY_VERSION,
    policySha256: GUEST_CHAT_SMART_ADAPTIVE_POLICY_SHA256,
    runtimeCommitSha: base.runtimeCommitSha,
    runtimeDeploymentId: base.runtimeDeploymentId,
    baseRouterConfigDigest: base.routerConfigDigest,
    routerVersions: ROUTER_VERSIONS,
    promptRefinerCandidateDigest: PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST,
    promptRefinerPricePinDigest: PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
    promptRefinerAdapterConfigDigest:
      PROMPT_REFINER_PRODUCT_ADAPTER_CONFIG_DIGEST,
    guestQuotaContract: "shared-guest-subject-and-ip-v1",
    guestCreditPhaseContract: "prehold-convert-exact-v1",
    retryCount: 0,
  });
  if (!SHA256.test(configDigest)) {
    throw new Error("guest_chat_smart_adaptive_config_invalid");
  }
  return Object.freeze({ runtimeCommitSha: base.runtimeCommitSha,
    runtimeDeploymentId: base.runtimeDeploymentId,
    configDigest, baseRouterConfigDigest: base.routerConfigDigest,
    promptRefinerCandidateDigest: PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST,
    promptRefinerPricePinDigest: PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
    promptRefinerAdapterConfigDigest:
      PROMPT_REFINER_PRODUCT_ADAPTER_CONFIG_DIGEST });
}

export function guestChatSmartAdaptiveActivationMetadata(input: Readonly<{
  binding: GuestChatSmartAdaptiveRuntimeBinding;
  baseRouterActivationAuditLogId: string;
  baseProductActivationAuditLogId: string;
}>) {
  return Object.freeze({
    version: "guest-chat-smart-adaptive-release-v1",
    policyVersion: GUEST_CHAT_SMART_ADAPTIVE_POLICY_VERSION,
    policySha256: GUEST_CHAT_SMART_ADAPTIVE_POLICY_SHA256,
    runtimeCommitSha: input.binding.runtimeCommitSha,
    runtimeDeploymentId: input.binding.runtimeDeploymentId,
    configDigest: input.binding.configDigest,
    baseRouterConfigDigest: input.binding.baseRouterConfigDigest,
    promptRefinerCandidateDigest:
      input.binding.promptRefinerCandidateDigest,
    promptRefinerPricePinDigest: input.binding.promptRefinerPricePinDigest,
    promptRefinerAdapterConfigDigest:
      input.binding.promptRefinerAdapterConfigDigest,
    baseRouterActivationAuditLogId: input.baseRouterActivationAuditLogId,
    baseProductActivationAuditLogId: input.baseProductActivationAuditLogId,
    product: "chat",
    subjectKind: "guest",
    existingGuestQuotaOnly: true,
    logicalAnswersPerTurn: 1,
    promptRetention: "request_memory_only",
    refinerRetryCount: 0,
  });
}

export function guestChatSmartAdaptiveActivationPairDigest(input: Readonly<{
  activationAuditLogId: string;
  activationEntryHash: string;
  metadata: unknown;
}>) {
  return sha256({ version: "guest-chat-smart-adaptive-activation-pair-v1",
    ...input });
}

export const exactGuestChatSmartAdaptiveMetadata = (
  actual: unknown,
  expected: unknown,
) => canonicalBenchmarkJson(actual ?? null) === canonicalBenchmarkJson(expected);
