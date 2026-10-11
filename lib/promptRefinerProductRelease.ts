import {
  PROMPT_REFINER_PRODUCT_ADAPTER_CONFIG_DIGEST,
  PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST,
  PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
} from "@/lib/promptRefinerProductContract";

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const PROMPT_REFINER_AUTO_EXCEPTION_POLICY_COMMIT =
  "75fbeade2a54a863bf94292a75935edf2df59418" as const;
export const PROMPT_REFINER_AUTO_EXCEPTION_POLICY_SHA256 =
  "6080eada4a66d5e9f45b07d6ae9314252119e68d0eb0269e1513a7bfd776c8a3" as const;

export type PromptRefinerProductReleaseEntry = Readonly<{
  version: "prompt-refiner-product-release-v1";
  status: "active";
  approvedBy: string;
  approvedAt: string;
  policyCommit: string;
  policySha256: string;
  gateAuditLogId: string;
  dispositionAuditLogId: string;
  limitedAuditReceiptId: string;
  gateOutcome: "fail";
  gateReasonCodes: readonly ["latency_ceiling_exceeded"];
  latencyOnlyFailure: true;
  limitedAuditDisposition: "pass";
  unresolvedAuditViolations: 0;
  candidateDigest: string;
  pricePinDigest: string;
  adapterConfigDigest: string;
  runtimeCommitSha: string;
  runtimeDeploymentId: string;
  explicitEnabled: boolean;
  autoEnabled: boolean;
}>;

/**
 * Activation records are append-only source facts reviewed with the exact
 * deployment. There is intentionally no entry until the missing content-free
 * B03G, limited-audit and deployment activation evidence exists.
 */
export const PROMPT_REFINER_PRODUCT_RELEASE_REGISTRY:
  readonly PromptRefinerProductReleaseEntry[] = Object.freeze([]);

const nonemptyOpaque = (value: string) =>
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

export function validatePromptRefinerProductReleaseEntry(
  entry: PromptRefinerProductReleaseEntry,
  runtime: Record<string, string | undefined>,
): boolean {
  const approvedAt = Date.parse(entry.approvedAt);
  return entry.version === "prompt-refiner-product-release-v1" &&
    entry.status === "active" && nonemptyOpaque(entry.approvedBy) &&
    Number.isFinite(approvedAt) &&
    entry.policyCommit === PROMPT_REFINER_AUTO_EXCEPTION_POLICY_COMMIT &&
    entry.policySha256 === PROMPT_REFINER_AUTO_EXCEPTION_POLICY_SHA256 &&
    nonemptyOpaque(entry.gateAuditLogId) &&
    nonemptyOpaque(entry.dispositionAuditLogId) &&
    nonemptyOpaque(entry.limitedAuditReceiptId) &&
    entry.gateOutcome === "fail" && entry.latencyOnlyFailure === true &&
    entry.gateReasonCodes.length === 1 &&
    entry.gateReasonCodes[0] === "latency_ceiling_exceeded" &&
    entry.limitedAuditDisposition === "pass" &&
    entry.unresolvedAuditViolations === 0 &&
    entry.candidateDigest === PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST &&
    entry.pricePinDigest === PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST &&
    entry.adapterConfigDigest === PROMPT_REFINER_PRODUCT_ADAPTER_CONFIG_DIGEST &&
    SHA.test(entry.runtimeCommitSha) && UUID.test(entry.runtimeDeploymentId) &&
    runtime.RAILWAY_GIT_COMMIT_SHA?.toLowerCase() === entry.runtimeCommitSha &&
    runtime.RAILWAY_DEPLOYMENT_ID?.toLowerCase() === entry.runtimeDeploymentId &&
    SHA256.test(entry.candidateDigest) && SHA256.test(entry.pricePinDigest) &&
    SHA256.test(entry.adapterConfigDigest) &&
    (entry.explicitEnabled || entry.autoEnabled);
}

export function resolvePromptRefinerProductRelease(
  runtime: Record<string, string | undefined> = process.env,
  registry: readonly PromptRefinerProductReleaseEntry[] =
    PROMPT_REFINER_PRODUCT_RELEASE_REGISTRY,
) {
  const matches = registry.filter((entry) =>
    validatePromptRefinerProductReleaseEntry(entry, runtime));
  if (matches.length !== 1) {
    return Object.freeze({ explicitEnabled: false, autoEnabled: false,
      runtimeDeploymentId: null, runtimeCommitSha: null });
  }
  const entry = matches[0];
  return Object.freeze({ explicitEnabled: entry.explicitEnabled,
    autoEnabled: entry.autoEnabled,
    runtimeDeploymentId: entry.runtimeDeploymentId,
    runtimeCommitSha: entry.runtimeCommitSha });
}

