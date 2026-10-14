/**
 * Signing the production webhook configuration generation (S2 plan, S2f;
 * `marketing_webhook.production_config_signed`, S1 r7 amendment 1).
 *
 * An operator signs what the production screen showed: the next generation,
 * the signed staging verification record it rests on, the deploy commit, the
 * pipeline fingerprint and the live production configuration digest. Every one
 * of those is computed again here, inside the transaction that writes the
 * human audit row, and a value that moved since the screen read it is refused
 * rather than signed. The stored generation is `OLD+1` under compare-and-set on
 * the stored value (AppSetting has no version column; the generation inside the
 * value names one write and no other).
 *
 * **Production, exactly, or nothing.** Staging and an unlabelled build refuse
 * before anything is read: the staging record is evidence about the pipeline,
 * and a production signature made anywhere else would bind nothing.
 */

import "server-only";

import {
  MARKETING_WEBHOOK_APPLY_SCOPE_KEY,
  MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
  MARKETING_WEBHOOK_SHADOW_KEY,
  canonicalMarketingWebhookFileText,
  digestMarketingWebhookVerificationRecord,
  marketingWebhookVerificationRecordSchema,
} from "@/lib/marketingAutomationAccess";
import {
  MARKETING_WEBHOOK_VERIFICATION_SIGNED_ACTION,
  verifyMarketingAuditEvidence,
  type MarketingAuditRequirement,
  type MarketingAuditVerdict,
} from "@/lib/marketingAuditEvidence";
import type { MarketingTransaction } from "@/lib/marketingStore";
import {
  MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY,
  MARKETING_WEBHOOK_PRODUCTION_CONFIG_SIGNED_ACTION,
  MarketingWebhookProductionConfigRefusedError,
  marketingWebhookProductionConfigRefusals,
  marketingWebhookProductionConfigSnapshotDigest,
  marketingWebhookScopeOutsideObserved,
  marketingWebhookStoredValueDigest,
  nextMarketingWebhookProductionConfigGeneration,
  readMarketingWebhookProductionApplyScope,
  readMarketingWebhookProductionConfig,
  serializeMarketingWebhookProductionApplyScope,
  serializeMarketingWebhookProductionConfig,
  type MarketingWebhookProductionApplyScope,
  type MarketingWebhookProductionApplyScopeRead,
  type MarketingWebhookProductionConfigGeneration,
  type MarketingWebhookProductionConfigRead,
} from "@/lib/marketingWebhookProductionConfig";
import { validateEnvironment } from "@/lib/deploymentEnvironment";
import { readMarketingWebhookVerificationRecordFile } from "@/lib/marketingWebhookVerification";

export { MarketingWebhookProductionConfigRefusedError };

function refuse(code: string, message: string): never {
  throw new MarketingWebhookProductionConfigRefusedError(code, message);
}

const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The environment this deployment is explicitly labelled as, or `unlabelled`.
 *
 * Deliberately not `resolveDeploymentEnvironment()`: that answers
 * `production` for any production build with no label at all (its
 * `NODE_ENV` fallback), which is the right default for deciding how strict to
 * be and the wrong one for deciding where a production signature may be made.
 * A signature needs the deployment to say it is production.
 */
export const marketingWebhookExplicitEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
): string =>
  validateEnvironment(env.APP_ENV) ?? validateEnvironment(env.RAILWAY_ENVIRONMENT_NAME) ?? "unlabelled";

/** The deploy commit Railway gives the running build, or null when it gives none. */
export const marketingWebhookLiveDeployCommitSha = (
  env: Readonly<Record<string, string | undefined>>,
): string | null => {
  const value = env.RAILWAY_GIT_COMMIT_SHA?.trim().toLowerCase();
  return value && COMMIT_SHA.test(value) ? value : null;
};

/**
 * The audit claim a production configuration signature has to prove.
 *
 * The record signature it rested on is bound when the caller knows it -- the
 * signing transaction does -- and left out later, when only the stored
 * generation is at hand: the generation does not carry it, and the signing
 * transaction already proved it before the row could commit.
 */
export const marketingWebhookProductionConfigAuditRequirement = (
  value: MarketingWebhookProductionConfigGeneration,
  verificationSignatureAuditLogId?: string,
): MarketingAuditRequirement => ({
  auditLogId: value.signatureAuditLogId,
  action: MARKETING_WEBHOOK_PRODUCTION_CONFIG_SIGNED_ACTION,
  targetId: MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY,
  metadata: {
    generation: value.generation,
    recordId: value.recordId,
    deployCommitSha: value.deployCommitSha,
    pipelineFingerprint: value.pipelineFingerprint,
    productionConfigSnapshotDigest: value.productionConfigSnapshotDigest,
    ...(verificationSignatureAuditLogId === undefined ? {} : { verificationSignatureAuditLogId }),
  },
});

export type MarketingWebhookProductionConfigLive = {
  readonly environment: string;
  readonly deployCommitSha: string | null;
  readonly pipelineFingerprint: string;
  readonly productionConfigSnapshotDigest: string;
  readonly stored: MarketingWebhookProductionConfigRead;
  /** Null when the stored value refuses a signature over it. */
  readonly nextGeneration: number | null;
  /** The stored apply scope, and the digest a change has to name to replace it. */
  readonly applyScope: MarketingWebhookProductionApplyScopeRead & { readonly storedDigest: string };
};

/**
 * What the production screen shows before signing, read in one pass: the same
 * shadow value and Zernio channel bindings the receiver reads, digested under
 * the name `production`.
 */
export async function readMarketingWebhookProductionConfigLive(
  db: Pick<MarketingTransaction, "appSetting" | "marketingChannel">,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MarketingWebhookProductionConfigLive> {
  const [shadowRow, configRow, scopeRow, channels] = await Promise.all([
    db.appSetting.findUnique({ where: { key: MARKETING_WEBHOOK_SHADOW_KEY }, select: { value: true } }),
    db.appSetting.findUnique({
      where: { key: MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY },
      select: { value: true },
    }),
    db.appSetting.findUnique({ where: { key: MARKETING_WEBHOOK_APPLY_SCOPE_KEY }, select: { value: true } }),
    db.marketingChannel.findMany({
      where: { provider: "zernio", externalAccountRef: { not: null } },
      select: { id: true, externalAccountRef: true },
    }),
  ]);
  const bindings = channels.flatMap((channel) =>
    channel.externalAccountRef ? [{ id: channel.id, externalAccountRef: channel.externalAccountRef }] : [],
  );
  const stored = readMarketingWebhookProductionConfig(configRow?.value);
  return {
    environment: marketingWebhookExplicitEnvironment(env),
    deployCommitSha: marketingWebhookLiveDeployCommitSha(env),
    pipelineFingerprint: MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
    productionConfigSnapshotDigest: marketingWebhookProductionConfigSnapshotDigest(
      env,
      shadowRow?.value ?? null,
      bindings,
    ),
    stored,
    nextGeneration: nextMarketingWebhookProductionConfigGeneration({ ok: true, value: stored }),
    applyScope: {
      ...readMarketingWebhookProductionApplyScope(scopeRow?.value),
      storedDigest: marketingWebhookStoredValueDigest(scopeRow?.value),
    },
  };
}

export type MarketingWebhookProductionConfigSignRequest = {
  readonly generation: number;
  readonly recordId: string;
  readonly recordDigest: string;
  readonly verificationSignatureAuditLogId: string;
  readonly deployCommitSha: string;
  readonly pipelineFingerprint: string;
  readonly productionConfigSnapshotDigest: string;
};

export type MarketingWebhookProductionConfigSignDeps = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readRecordFile?: (recordId: string) => Promise<string | null>;
  readonly verifyAudit?: (
    tx: MarketingTransaction,
    requirement: MarketingAuditRequirement,
  ) => Promise<MarketingAuditVerdict>;
};

/**
 * Sign one production configuration generation, inside the transaction that
 * wrote this request's human audit row (`auditLogId`).
 *
 * Order matters only in that every check runs before the write and the audit
 * row is read back last: a refusal anywhere rolls the audit row back with it.
 */
export async function signMarketingWebhookProductionConfig(
  tx: MarketingTransaction,
  request: MarketingWebhookProductionConfigSignRequest,
  auditLogId: string,
  deps: MarketingWebhookProductionConfigSignDeps = {},
): Promise<MarketingWebhookProductionConfigGeneration> {
  const env = deps.env ?? process.env;
  const readRecordFile = deps.readRecordFile ?? readMarketingWebhookVerificationRecordFile;
  const verifyAudit = deps.verifyAudit ?? verifyMarketingAuditEvidence;

  if (marketingWebhookExplicitEnvironment(env) !== "production") {
    refuse("environment_not_production", "A production configuration is signed in production only.");
  }

  // The staging record it rests on: in this tree, the digest the screen named,
  // this build's pipeline, and signed by a verified human audit row.
  const fileText = await readRecordFile(request.recordId);
  if (fileText === null) {
    refuse("record_not_found", "No verification record with this id is in the deployed tree.");
  }
  let recordJson: unknown = null;
  try {
    recordJson = JSON.parse(canonicalMarketingWebhookFileText(fileText as string));
  } catch {
    refuse("record_invalid", "The verification record is not JSON.");
  }
  const record = marketingWebhookVerificationRecordSchema.safeParse(recordJson);
  if (!record.success || record.data.recordId !== request.recordId) {
    refuse("record_invalid", "The verification record does not match the strict record schema.");
  }
  if (digestMarketingWebhookVerificationRecord(fileText as string) !== request.recordDigest) {
    refuse("record_digest_mismatch", "The digest does not match the record the deployed tree carries.");
  }
  if (
    record.success &&
    record.data.pipelineFingerprint !== MARKETING_WEBHOOK_PIPELINE_FINGERPRINT
  ) {
    refuse("record_pipeline_stale", "The record was made against a different webhook pipeline than this build.");
  }
  const recordSignature = await verifyAudit(tx, {
    auditLogId: request.verificationSignatureAuditLogId,
    action: MARKETING_WEBHOOK_VERIFICATION_SIGNED_ACTION,
    targetId: request.recordId,
    metadata: { recordDigest: request.recordDigest },
  });
  if (!recordSignature.ok) {
    refuse(
      "record_signature_unverified",
      `The verification record's signature does not verify (${recordSignature.problem}).`,
    );
  }

  // What the screen showed, computed again now.
  const live = await readMarketingWebhookProductionConfigLive(tx, env);
  if (request.pipelineFingerprint !== live.pipelineFingerprint) {
    refuse("pipeline_fingerprint_changed", "This build's webhook pipeline is not the one the screen showed.");
  }
  if (live.deployCommitSha === null) {
    refuse("deploy_commit_unknown", "This deployment does not report its commit.");
  }
  if (request.deployCommitSha !== live.deployCommitSha) {
    refuse("deploy_commit_changed", "Production was redeployed since the screen read it.");
  }
  if (request.productionConfigSnapshotDigest !== live.productionConfigSnapshotDigest) {
    refuse("config_snapshot_changed", "The production webhook configuration changed since the screen read it.");
  }
  if (live.stored.status === "invalid" || live.nextGeneration === null) {
    refuse("production_config_unreadable", "The stored production configuration is not one this build can sign over.");
  }
  if (request.generation !== live.nextGeneration) {
    refuse("production_config_conflict", "The production configuration changed since the screen read it.");
  }

  const value: MarketingWebhookProductionConfigGeneration = {
    generation: request.generation,
    recordId: request.recordId,
    environment: "production",
    deployCommitSha: request.deployCommitSha,
    pipelineFingerprint: request.pipelineFingerprint,
    productionConfigSnapshotDigest: request.productionConfigSnapshotDigest,
    signatureAuditLogId: auditLogId,
  };
  const serialized = serializeMarketingWebhookProductionConfig(value);

  if (live.stored.status === "absent") {
    try {
      await tx.appSetting.create({ data: { key: MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY, value: serialized } });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "P2002") {
        refuse("production_config_conflict", "The production configuration changed since the screen read it.");
      }
      throw error;
    }
  } else {
    const current = await tx.appSetting.findUnique({
      where: { key: MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY },
      select: { value: true },
    });
    const currentRead = readMarketingWebhookProductionConfig(current?.value);
    if (
      current === null ||
      currentRead.status !== "valid" ||
      currentRead.value.generation + 1 !== request.generation
    ) {
      refuse("production_config_conflict", "The production configuration changed since the screen read it.");
    }
    const moved = await tx.appSetting.updateMany({
      where: { key: MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY, value: current!.value },
      data: { value: serialized },
    });
    if (moved.count !== 1) {
      refuse("production_config_conflict", "The production configuration changed since the screen read it.");
    }
  }

  // The row just written, read back through the verifier the apply decision
  // uses: without an audit integrity key it is stored unhashed and no apply
  // could ever accept it, so a signature that "succeeded" here would bind
  // nothing. Refusing rolls the write and the row back together.
  const own = await verifyAudit(
    tx,
    marketingWebhookProductionConfigAuditRequirement(value, request.verificationSignatureAuditLogId),
  );
  if (!own.ok) {
    refuse("signature_audit_unverifiable", `The signing audit entry does not verify (${own.problem}).`);
  }
  return value;
}

export type MarketingWebhookApplyScopeRequest = MarketingWebhookProductionApplyScope & {
  /** `marketingWebhookStoredValueDigest()` of the value the screen read. */
  readonly expectedStoredDigest: string;
};

/**
 * Set the production apply scope (`marketing_webhook.apply_scope_changed`),
 * against the stored value the screen read.
 *
 * A non-empty scope needs the signed production generation it names to still
 * bind the live configuration -- the same check the apply decision makes --
 * and every pair it lists to have been observed by that generation's record.
 * An empty scope applies nothing, so it needs none of that: stopping
 * production applying events has to work exactly when something else is wrong.
 */
export async function setMarketingWebhookProductionApplyScope(
  tx: MarketingTransaction,
  request: MarketingWebhookApplyScopeRequest,
  deps: MarketingWebhookProductionConfigSignDeps = {},
): Promise<MarketingWebhookProductionApplyScope> {
  const env = deps.env ?? process.env;
  const readRecordFile = deps.readRecordFile ?? readMarketingWebhookVerificationRecordFile;
  const verifyAudit = deps.verifyAudit ?? verifyMarketingAuditEvidence;

  if (marketingWebhookExplicitEnvironment(env) !== "production") {
    refuse("environment_not_production", "The production apply scope is set in production only.");
  }

  let serialized = "";
  try {
    serialized = serializeMarketingWebhookProductionApplyScope({
      recordId: request.recordId,
      productionConfigGeneration: request.productionConfigGeneration,
      scope: request.scope.map((entry) => ({ eventType: entry.eventType, channelId: entry.channelId })),
    });
  } catch {
    refuse("apply_scope_invalid", "The apply scope is not a valid value.");
  }
  const parsed = readMarketingWebhookProductionApplyScope(serialized);
  if (parsed.status !== "valid") {
    refuse("apply_scope_invalid", "The apply scope is not a valid value.");
  }
  const value = parsed.value;

  if (value.scope.length > 0) {
    const live = await readMarketingWebhookProductionConfigLive(tx, env);
    if (live.stored.status !== "valid" || live.stored.value.generation !== value.productionConfigGeneration) {
      refuse("production_config_mismatch", "The scope names a production generation that is not the signed one.");
    }
    const signed = live.stored.value;
    const audit = await verifyAudit(tx, marketingWebhookProductionConfigAuditRequirement(signed));
    const reasons = marketingWebhookProductionConfigRefusals({
      stored: { ok: true, value: live.stored },
      audit: {
        ok: true,
        value: {
          auditLogId: signed.signatureAuditLogId,
          verified: audit.ok,
          generation: signed.generation,
          recordId: signed.recordId,
          deployCommitSha: signed.deployCommitSha,
          pipelineFingerprint: signed.pipelineFingerprint,
          productionConfigSnapshotDigest: signed.productionConfigSnapshotDigest,
        },
      },
      liveEnvironment: { ok: true, value: live.environment },
      liveSnapshotDigest: { ok: true, value: live.productionConfigSnapshotDigest },
      recordId: value.recordId,
    });
    if (reasons.length > 0) {
      refuse(
        "production_config_not_binding",
        `The signed production configuration does not bind (${reasons.join(", ")}).`,
      );
    }

    const fileText = await readRecordFile(value.recordId);
    let recordJson: unknown = null;
    try {
      recordJson = fileText === null ? null : JSON.parse(canonicalMarketingWebhookFileText(fileText));
    } catch {
      recordJson = null;
    }
    const record = marketingWebhookVerificationRecordSchema.safeParse(recordJson);
    if (!record.success || record.data.recordId !== value.recordId) {
      refuse("record_invalid", "The verification record is not in the deployed tree, or is not a strict record.");
    }
    if (marketingWebhookScopeOutsideObserved(value.scope, record.data.observedScope).length > 0) {
      refuse("scope_not_observed", "The scope lists a pair the verification record never observed.");
    }
  }

  const current = await tx.appSetting.findUnique({
    where: { key: MARKETING_WEBHOOK_APPLY_SCOPE_KEY },
    select: { value: true },
  });
  if (marketingWebhookStoredValueDigest(current?.value) !== request.expectedStoredDigest) {
    refuse("apply_scope_conflict", "The apply scope changed since the screen read it.");
  }
  if (current?.value === serialized) {
    refuse("apply_scope_noop", "The apply scope is already this value.");
  }
  if (current === null) {
    try {
      await tx.appSetting.create({ data: { key: MARKETING_WEBHOOK_APPLY_SCOPE_KEY, value: serialized } });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "P2002") {
        refuse("apply_scope_conflict", "The apply scope changed since the screen read it.");
      }
      throw error;
    }
  } else {
    const moved = await tx.appSetting.updateMany({
      where: { key: MARKETING_WEBHOOK_APPLY_SCOPE_KEY, value: current.value },
      data: { value: serialized },
    });
    if (moved.count !== 1) {
      refuse("apply_scope_conflict", "The apply scope changed since the screen read it.");
    }
  }
  return value;
}
