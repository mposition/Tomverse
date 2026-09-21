/**
 * Pure admission rules for each marketing-automation capability.
 *
 * Contract: docs/policy/marketing-automation.md §6.1 and the approved S1d
 * implementation plan. This module does not read the database, process
 * environment or filesystem. Callers load those values into `ReadResult`s;
 * an unavailable required value is a denial, never an inferred default.
 */

import { createHash } from "node:crypto";

import { z } from "zod";

import type { DeploymentEnvironment } from "@/lib/deploymentEnvironment";
import type { MarketingWebhookSignatureAuditEvidence } from "@/lib/marketingAuditEvidence";
import type { MarketingChannelStatus } from "@/lib/marketingAutomationSchema";

export type ReadResult<T> = { ok: true; value: T } | { ok: false };

export const MARKETING_AUTOMATION_FEATURES = [
  "adminRead",
  "draftIntake",
  "manualApproval",
  "approvalPublish",
  "autonomousPublish",
  "graduate",
  "experimentActivate",
  "seoAutoMerge",
  "webhookShadow",
  "webhookApply",
] as const;

export type MarketingAutomationFeature =
  (typeof MARKETING_AUTOMATION_FEATURES)[number];

export type MarketingAutomationInputName = keyof MarketingAutomationAccessInputs;

export type MarketingAutomationAccessReason =
  | `input_unreadable:${MarketingAutomationInputName}`
  | `input_false:${MarketingAutomationInputName}`
  | `input_invalid:${MarketingAutomationInputName}`
  | "kill_switch"
  | "channel_o15"
  | "environment_not_staging"
  | "webhook_pipeline_incomplete"
  | "webhook_scope_invalid"
  | "webhook_record_invalid"
  | "webhook_signature_invalid"
  | "webhook_pipeline_fingerprint_stale"
  | "webhook_config_snapshot_invalid"
  | "webhook_config_snapshot_stale"
  | "webhook_record_digest_mismatch"
  | "webhook_audit_invalid"
  | "webhook_record_mismatch"
  | "webhook_scope_not_observed"
  | "webhook_event_outside_scope";

export type MarketingAutomationAccessDecision = {
  enabled: boolean;
  reasons: MarketingAutomationAccessReason[];
};

export const MARKETING_AUTOMATION_KILL_SWITCH_ENV =
  "MARKETING_AUTOMATION_KILL_SWITCH";
export const TOMVERSE_DEPLOY_ENV = "TOMVERSE_DEPLOY_ENV";
export const APP_ENV = "APP_ENV";
export const RAILWAY_ENVIRONMENT_NAME = "RAILWAY_ENVIRONMENT_NAME";

export const MARKETING_DRAFTS_KEY =
  "marketingAutomation.draftsEnabled";
export const MARKETING_PUBLISH_KEY =
  "marketingAutomation.publishEnabled";
export const MARKETING_AUTO_PUBLISH_KEY =
  "marketingAutomation.autoPublishEnabled";
export const MARKETING_EXPERIMENTS_KEY =
  "marketingAutomation.experimentsEnabled";
export const MARKETING_WEBHOOK_SHADOW_KEY =
  "marketingAutomation.webhookShadowEnabled";
export const MARKETING_WEBHOOK_APPLY_SCOPE_KEY =
  "marketingAutomation.webhookApplyScope";

export const marketingAutomationEnabledFromValue = (
  value: string | null | undefined,
): boolean => value === "true";

/** S2/S3 wires the operator alert delivery used by price fallback refusal. */
export const MARKETING_PRICE_FALLBACK_ALERT_READY = false;

/**
 * S1 has no receiver, dedupe, storage, mapping or status-query comparison.
 * S2 may flip this only after all of those files exist and are included in the
 * static fingerprint below.
 */
export const MARKETING_WEBHOOK_PIPELINE_COMPLETE = false;

export const MARKETING_WEBHOOK_SCHEMA_VERSION =
  "marketing-webhook-shadow-v1";
export const MARKETING_WEBHOOK_ACCEPTED_EVENT_TYPES = [] as const;

/** Only pipeline files that exist in S1. S2 must extend this closed list. */
export const MARKETING_WEBHOOK_PIPELINE_FILES = [
  "lib/marketingAutomationSchema.ts",
  "prisma/schema.prisma",
] as const;

export const MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR = {
  appSettingKeys: [MARKETING_WEBHOOK_SHADOW_KEY],
  envNames: [APP_ENV, RAILWAY_ENVIRONMENT_NAME, TOMVERSE_DEPLOY_ENV],
  schemaVersion: MARKETING_WEBHOOK_SCHEMA_VERSION,
} as const;

const codePointCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => codePointCompare(left, right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  return value;
};

export const canonicalMarketingWebhookJson = (value: unknown): string =>
  JSON.stringify(canonicalValue(value));

export const canonicalMarketingWebhookFileText = (value: string): string =>
  value.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");

const canonicalPipelinePath = (value: string): string => {
  const path = value.replaceAll("\\", "/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    /^[A-Za-z]:\//.test(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Marketing webhook pipeline path is not relative POSIX: ${value}`);
  }
  return path;
};

export const computeMarketingWebhookPipelineFingerprint = (
  files: ReadonlyArray<{ path: string; content: string }>,
  descriptor: unknown,
): string => {
  const canonicalFiles = files
    .map((file) => ({
      path: canonicalPipelinePath(file.path),
      content: canonicalMarketingWebhookFileText(file.content),
    }))
    .sort((left, right) => codePointCompare(left.path, right.path));

  if (new Set(canonicalFiles.map((file) => file.path)).size !== canonicalFiles.length) {
    throw new Error("Marketing webhook pipeline file paths must be unique.");
  }

  const hash = createHash("sha256");
  for (const file of canonicalFiles) {
    hash.update(file.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(file.content, "utf8");
    hash.update("\0", "utf8");
  }
  hash.update("\0", "utf8");
  hash.update(canonicalMarketingWebhookJson(descriptor), "utf8");
  return hash.digest("hex");
};

/**
 * Updated only by the fingerprint test after reviewing a declared file change.
 *
 * 2026-09-20: `prisma/schema.prisma` is one of the watched files, and the
 * webhook account contraction changed it -- the old
 * `(provider, providerEventId)` unique and the `providerAccount` default are
 * gone, and `EmailDelivery(providerAccount, providerMessageId)` became unique
 * (docs/policy/email-notifications.md v24).
 *
 * This is not a change the marketing pipeline merely happens to sit beside: it
 * changes the storage rules the pipeline depends on. A marketing webhook event
 * carrying the same provider event id as a transactional one is now stored
 * rather than refused, and a marketing delivery's message id is now unique
 * within the marketing account rather than merely indexed. Both make the
 * per-account matching S1b-2b built true instead of assumed, and neither
 * changes a decision this module makes -- which is what the second look was
 * for.
 *
 * 2026-09-21: the other watched file, `lib/marketingAutomationSchema.ts`,
 * changed too -- `edit_revision.byAuditLogId` became non-null. An edit with no
 * audit row cannot be placed in time against a template marking, and because
 * history is append-only one such entry would have made that post permanently
 * unusable as a template; requiring the field while nothing writes an edit yet
 * is the moment to do it. The value below is recomputed over both changes, not
 * either one: two branches each moved this constant for their own file, and
 * taking one side of that merge would have left a fingerprint describing a
 * pipeline that never existed.
 *
 * 2026-09-21: the AMUX integration adds an isolated set of `Amux*` models to
 * the same watched schema. None changes a marketing model, the descriptor, or
 * an admission decision; the fingerprint moves because the closed file digest
 * deliberately requires this review whenever any schema bytes move.
 *
 * 2026-09-21: Prompt Refiner confirmatory shadow v4 adds nullable evidence
 * columns and a new attempt check to the same schema. Those additions do not
 * touch a marketing model or admission decision; the watched-file digest still
 * moves so the dependency is reviewed explicitly.
 *
 * 2026-09-21, again: the same watched file, and this time the declared change
 * is a documentation comment. `SuppressionCause`'s model comment said the rows
 * were written beside `SuppressionEntry` and read by no send decision, which
 * stopped being true when the send moved onto them
 * (docs/policy/email-notifications.md v26). No column, index, constraint or
 * model changed, so nothing this pipeline stores or reads is different -- but
 * a comment is bytes in a watched file, and the digest asking for a look
 * rather than deciding for itself what is material is the behaviour, not a
 * defect. This was the look.
 *
 * 2026-09-21, S1f: the updated writer preserves the complete resolver digest in
 * `MarketingPost.factsDigest`; legacy/rollout rows remain nullable until row
 * evidence backs a separate NOT NULL transition. Webhook admission never reads
 * this column; the fingerprint moves because the schema is watched as a whole.
 *
 * 2026-09-21: Prompt Refiner confirmatory shadow v4 adds nullable evidence
 * columns and a new attempt check to the same schema. Those additions do not
 * touch a marketing model or admission decision; the watched-file digest still
 * moves so the dependency is reviewed explicitly.
 *
 * 2026-09-21, the permission ledger (S3): six more tables on the same watched
 * schema -- EmailPermissionEvent, EmailSendApproval with its cohort and
 * revocations, EmailPermissionDecision and its evidence. None is a marketing
 * model, none changes the descriptor, the config snapshot or an admission
 * decision, and nothing this pipeline stores or reads is different. The one
 * shared edge is ConsentRecord, which gains a back-relation and no column. The
 * digest moves because schema bytes moved, which is what this constant is for:
 * it asks for a look rather than deciding for itself what is material. This
 * was the look, and the value below was computed over the merged tree rather
 * than taken from either side of the conflict.
 */
export const MARKETING_WEBHOOK_PIPELINE_FINGERPRINT = "d76a14eef1b5a001c316c231b66ca1c5258250e0e35b7492e588709e9f72797d";

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export type MarketingWebhookConfigSnapshot = {
  appSettings: Readonly<Record<string, string | null | undefined>>;
  acceptedEventTypes: readonly string[];
  /** Caller-computed digests only; raw process-environment values never cross this boundary. */
  envDigests: Readonly<Record<string, string | null>>;
  schemaVersion: string;
};

/**
 * Converts the declared environment slice to digests at the process boundary.
 * `null` means missing; an explicitly empty value has the digest of `""`.
 */
export const marketingWebhookEnvDigests = (
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): Readonly<Record<string, string | null>> =>
  Object.fromEntries(
    [...names].sort(codePointCompare).map((name) => [
      name,
      env[name] === undefined ? null : sha256(env[name]),
    ]),
  );

const sameSortedStrings = (
  actual: readonly string[],
  expected: readonly string[],
): boolean => {
  const left = [...actual].sort(codePointCompare);
  const right = [...expected].sort(codePointCompare);
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
};

export const isDeclaredMarketingWebhookConfigSnapshot = (
  snapshot: MarketingWebhookConfigSnapshot,
): boolean =>
  sameSortedStrings(
    Object.keys(snapshot.appSettings),
    MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR.appSettingKeys,
  ) &&
  sameSortedStrings(
    Object.keys(snapshot.envDigests),
    MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR.envNames,
  ) &&
  Object.values(snapshot.envDigests).every(
    (digest) => digest === null || /^[0-9a-f]{64}$/.test(digest),
  ) &&
  sameSortedStrings(
    snapshot.acceptedEventTypes,
    MARKETING_WEBHOOK_ACCEPTED_EVENT_TYPES,
  ) &&
  snapshot.schemaVersion === MARKETING_WEBHOOK_SCHEMA_VERSION;

/**
 * Hashes live configuration without returning any environment value. Missing
 * and empty remain distinct so either change invalidates a signed record.
 */
export const computeMarketingWebhookConfigSnapshotDigest = (
  snapshot: MarketingWebhookConfigSnapshot,
): string => {
  const envDigests = Object.fromEntries(
    Object.keys(snapshot.envDigests)
      .sort(codePointCompare)
      .map((name) => [name, snapshot.envDigests[name]]),
  );
  const appSettings = Object.fromEntries(
    Object.keys(snapshot.appSettings)
      .sort(codePointCompare)
      .map((name) => [name, snapshot.appSettings[name] ?? null]),
  );
  return sha256(
    canonicalMarketingWebhookJson({
      acceptedEventTypes: [...snapshot.acceptedEventTypes].sort(codePointCompare),
      appSettings,
      envDigests,
      schemaVersion: snapshot.schemaVersion,
    }),
  );
};

export const digestMarketingWebhookVerificationRecord = (
  recordFileText: string,
): string => sha256(canonicalMarketingWebhookFileText(recordFileText));

const boundedToken = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const gitCommitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const verificationRecordId = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}__[a-z0-9-]{1,64}$/);

export const marketingWebhookScopeEntrySchema = z
  .object({
    eventType: boundedToken,
    channelId: boundedToken,
  })
  .strict();

const uniqueScope = <T extends z.ZodTypeAny>(entrySchema: T) =>
  z
    .array(entrySchema)
    .min(1)
    .max(200)
    .superRefine((entries, context) => {
      const seen = new Set<string>();
      for (const [index, entry] of entries.entries()) {
        const candidate = entry as { eventType?: unknown; channelId?: unknown };
        const key = `${String(candidate.eventType)}\0${String(candidate.channelId)}`;
        if (seen.has(key)) {
          context.addIssue({
            code: "custom",
            message: "Webhook scope entries must be unique.",
            path: [index],
          });
        }
        seen.add(key);
      }
    });

export const marketingWebhookVerificationRecordSchema = z
  .object({
    recordId: verificationRecordId,
    executor: boundedToken,
    stagingCommitSha: gitCommitSha,
    observedScope: uniqueScope(marketingWebhookScopeEntrySchema),
    conditions: z
      .object({
        c1: z.literal("pass"),
        c2: z.literal("pass"),
        c3: z.literal("pass"),
        c4: z.literal("pass"),
        c5: z.literal("pass"),
      })
      .strict(),
    evidenceRefs: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(2_048)
          .regex(/^[^\u0000-\u001f\u007f]+$/),
      )
      .min(1)
      .max(100),
    pipelineFingerprint: sha256Hex,
    configSnapshotDigest: sha256Hex,
  })
  .strict();

export const marketingWebhookVerificationSignatureSchema = z
  .object({
    recordId: verificationRecordId,
    recordDigest: sha256Hex,
    signatureAuditLogId: boundedToken,
  })
  .strict();

export const marketingWebhookApplyScopeSchema = z
  .object({
    recordId: verificationRecordId,
    scope: uniqueScope(marketingWebhookScopeEntrySchema),
  })
  .strict();

type WebhookScopeEntry = z.infer<typeof marketingWebhookScopeEntrySchema>;

export type MarketingAutomationAccessInputs = {
  killSwitchValue: ReadResult<string | null | undefined>;
  adminAuthenticated: ReadResult<boolean>;
  draftsEnabled: ReadResult<boolean>;
  llmGenerationBudgetAvailable: ReadResult<boolean>;
  generatorAuthenticated: ReadResult<boolean>;
  priceFallbackAlertReady: ReadResult<boolean>;
  adminHasMarketingWrite: ReadResult<boolean>;
  adminStepUpRecent: ReadResult<boolean>;
  publishEnabled: ReadResult<boolean>;
  channelMode: ReadResult<MarketingChannelStatus>;
  adapterHealthy: ReadResult<boolean>;
  recoveryContractAvailable: ReadResult<boolean>;
  platformBudgetAvailable: ReadResult<boolean>;
  autoPublishEnabled: ReadResult<boolean>;
  commentsMonitorHealthy: ReadResult<boolean>;
  publicationCancellable: ReadResult<boolean>;
  o4Eligible: ReadResult<boolean>;
  o15Channel: ReadResult<boolean>;
  o3Satisfied: ReadResult<boolean>;
  experimentsEnabled: ReadResult<boolean>;
  cacheCspSpikePassed: ReadResult<boolean>;
  autonomousSurfaceGraduated: ReadResult<boolean>;
  seoAutoMergeRepositoryEnabled: ReadResult<boolean>;
  surfaceGraduation: ReadResult<boolean>;
  webhookShadowEnabled: ReadResult<boolean>;
  deploymentEnvironment: ReadResult<string | undefined>;
  resolvedDeploymentEnvironment: ReadResult<DeploymentEnvironment>;
  webhookSignatureVerified: ReadResult<boolean>;
  webhookApplyScopeValue: ReadResult<string | null | undefined>;
  webhookVerificationRecordText: ReadResult<string | null | undefined>;
  webhookVerificationSignatureText: ReadResult<string | null | undefined>;
  webhookSignatureAuditEvidence: ReadResult<MarketingWebhookSignatureAuditEvidence>;
  webhookConfigSnapshot: ReadResult<MarketingWebhookConfigSnapshot>;
  webhookEvent: ReadResult<WebhookScopeEntry>;
};

const add = (
  reasons: MarketingAutomationAccessReason[],
  reason: MarketingAutomationAccessReason,
): void => {
  if (!reasons.includes(reason)) reasons.push(reason);
};

const requireTrue = (
  reasons: MarketingAutomationAccessReason[],
  name: MarketingAutomationInputName,
  result: ReadResult<boolean>,
): boolean => {
  if (!result.ok) {
    add(reasons, `input_unreadable:${name}`);
    return false;
  }
  if (result.value !== true) {
    add(reasons, `input_false:${name}`);
    return false;
  }
  return true;
};

const requireNonO15 = (
  reasons: MarketingAutomationAccessReason[],
  result: ReadResult<boolean>,
): boolean => {
  if (!result.ok) {
    add(reasons, "input_unreadable:o15Channel");
    return false;
  }
  if (result.value) {
    add(reasons, "channel_o15");
    return false;
  }
  return true;
};

const decision = (
  reasons: MarketingAutomationAccessReason[],
): MarketingAutomationAccessDecision => ({
  enabled: reasons.length === 0,
  reasons,
});

const readJson = <T>(
  result: ReadResult<string | null | undefined>,
  name: MarketingAutomationInputName,
  reasons: MarketingAutomationAccessReason[],
  invalidReason: MarketingAutomationAccessReason,
  schema: z.ZodType<T>,
): T | null => {
  if (!result.ok) {
    add(reasons, `input_unreadable:${name}`);
    return null;
  }
  if (typeof result.value !== "string") {
    add(reasons, invalidReason);
    return null;
  }
  try {
    const parsed = schema.safeParse(
      JSON.parse(canonicalMarketingWebhookFileText(result.value)),
    );
    if (!parsed.success) {
      add(reasons, invalidReason);
      return null;
    }
    return parsed.data;
  } catch {
    add(reasons, invalidReason);
    return null;
  }
};

const sameScopeEntry = (
  left: WebhookScopeEntry,
  right: WebhookScopeEntry,
): boolean =>
  left.eventType === right.eventType && left.channelId === right.channelId;

const webhookApplyDecision = (
  input: MarketingAutomationAccessInputs,
): MarketingAutomationAccessDecision => {
  const reasons: MarketingAutomationAccessReason[] = [];
  if (!MARKETING_WEBHOOK_PIPELINE_COMPLETE) {
    add(reasons, "webhook_pipeline_incomplete");
  }

  const configured = readJson(
    input.webhookApplyScopeValue,
    "webhookApplyScopeValue",
    reasons,
    "webhook_scope_invalid",
    marketingWebhookApplyScopeSchema,
  );
  const record = readJson(
    input.webhookVerificationRecordText,
    "webhookVerificationRecordText",
    reasons,
    "webhook_record_invalid",
    marketingWebhookVerificationRecordSchema,
  );
  const signature = readJson(
    input.webhookVerificationSignatureText,
    "webhookVerificationSignatureText",
    reasons,
    "webhook_signature_invalid",
    marketingWebhookVerificationSignatureSchema,
  );

  if (record && record.pipelineFingerprint !== MARKETING_WEBHOOK_PIPELINE_FINGERPRINT) {
    add(reasons, "webhook_pipeline_fingerprint_stale");
  }
  if (!input.webhookConfigSnapshot.ok) {
    add(reasons, "input_unreadable:webhookConfigSnapshot");
  } else if (!isDeclaredMarketingWebhookConfigSnapshot(input.webhookConfigSnapshot.value)) {
    add(reasons, "webhook_config_snapshot_invalid");
  } else if (record) {
    const currentConfigDigest = computeMarketingWebhookConfigSnapshotDigest(
      input.webhookConfigSnapshot.value,
    );
    if (record.configSnapshotDigest !== currentConfigDigest) {
      add(reasons, "webhook_config_snapshot_stale");
    }
  }

  if (record && signature) {
    const recordText = input.webhookVerificationRecordText;
    if (
      signature.recordId !== record.recordId ||
      !recordText.ok ||
      typeof recordText.value !== "string" ||
      signature.recordDigest !==
        digestMarketingWebhookVerificationRecord(recordText.value)
    ) {
      add(reasons, "webhook_record_digest_mismatch");
    }
  }

  if (!input.webhookSignatureAuditEvidence.ok) {
    add(reasons, "input_unreadable:webhookSignatureAuditEvidence");
  } else if (
    !signature ||
    !input.webhookSignatureAuditEvidence.value.verified ||
    input.webhookSignatureAuditEvidence.value.auditLogId !==
      signature.signatureAuditLogId ||
    input.webhookSignatureAuditEvidence.value.action !==
      "marketing_webhook.verification_signed" ||
    input.webhookSignatureAuditEvidence.value.targetId !== signature.recordId ||
    input.webhookSignatureAuditEvidence.value.recordDigest !==
      signature.recordDigest
  ) {
    add(reasons, "webhook_audit_invalid");
  }

  if (configured && record) {
    if (configured.recordId !== record.recordId) {
      add(reasons, "webhook_record_mismatch");
    }
    if (
      configured.scope.some(
        (entry) =>
          !record.observedScope.some((observed) => sameScopeEntry(entry, observed)),
      )
    ) {
      add(reasons, "webhook_scope_not_observed");
    }
  }

  if (!input.webhookEvent.ok) {
    add(reasons, "input_unreadable:webhookEvent");
  } else {
    const event = input.webhookEvent.value;
    if (
      !configured ||
      !configured.scope.some((entry) => sameScopeEntry(entry, event))
    ) {
      add(reasons, "webhook_event_outside_scope");
    }
  }

  return decision(reasons);
};

export const resolveMarketingAutomationAccess = (
  input: MarketingAutomationAccessInputs,
): Record<MarketingAutomationFeature, MarketingAutomationAccessDecision> => {
  const result = Object.fromEntries(
    MARKETING_AUTOMATION_FEATURES.map((feature) => [
      feature,
      { enabled: false, reasons: [] as MarketingAutomationAccessReason[] },
    ]),
  ) as Record<MarketingAutomationFeature, MarketingAutomationAccessDecision>;

  const adminReadReasons: MarketingAutomationAccessReason[] = [];
  requireTrue(adminReadReasons, "adminAuthenticated", input.adminAuthenticated);
  result.adminRead = decision(adminReadReasons);

  if (!input.killSwitchValue.ok) {
    for (const feature of MARKETING_AUTOMATION_FEATURES) {
      if (feature !== "adminRead") {
        result[feature] = decision(["input_unreadable:killSwitchValue"]);
      }
    }
    return result;
  }
  if (
    typeof input.killSwitchValue.value === "string" &&
    input.killSwitchValue.value.trim().length > 0
  ) {
    for (const feature of MARKETING_AUTOMATION_FEATURES) {
      if (feature !== "adminRead") result[feature] = decision(["kill_switch"]);
    }
    return result;
  }

  const draftReasons: MarketingAutomationAccessReason[] = [];
  requireTrue(draftReasons, "draftsEnabled", input.draftsEnabled);
  requireTrue(
    draftReasons,
    "llmGenerationBudgetAvailable",
    input.llmGenerationBudgetAvailable,
  );
  requireTrue(
    draftReasons,
    "generatorAuthenticated",
    input.generatorAuthenticated,
  );
  requireTrue(
    draftReasons,
    "priceFallbackAlertReady",
    input.priceFallbackAlertReady,
  );
  result.draftIntake = decision(draftReasons);

  const approvalReasons: MarketingAutomationAccessReason[] = [];
  requireTrue(
    approvalReasons,
    "adminHasMarketingWrite",
    input.adminHasMarketingWrite,
  );
  requireTrue(approvalReasons, "adminStepUpRecent", input.adminStepUpRecent);
  requireTrue(approvalReasons, "draftsEnabled", input.draftsEnabled);
  result.manualApproval = decision(approvalReasons);

  const publishReasons: MarketingAutomationAccessReason[] = [];
  requireTrue(publishReasons, "publishEnabled", input.publishEnabled);
  if (!input.channelMode.ok) {
    add(publishReasons, "input_unreadable:channelMode");
  } else if (
    input.channelMode.value !== "approval_mode" &&
    input.channelMode.value !== "autonomous_mode"
  ) {
    add(publishReasons, "input_invalid:channelMode");
  }
  requireTrue(publishReasons, "adapterHealthy", input.adapterHealthy);
  requireTrue(
    publishReasons,
    "recoveryContractAvailable",
    input.recoveryContractAvailable,
  );
  requireTrue(
    publishReasons,
    "platformBudgetAvailable",
    input.platformBudgetAvailable,
  );
  requireTrue(
    publishReasons,
    "priceFallbackAlertReady",
    input.priceFallbackAlertReady,
  );
  result.approvalPublish = decision(publishReasons);

  const autonomousReasons = [...publishReasons];
  if (input.channelMode.ok && input.channelMode.value !== "autonomous_mode") {
    add(autonomousReasons, "input_invalid:channelMode");
  }
  requireTrue(
    autonomousReasons,
    "autoPublishEnabled",
    input.autoPublishEnabled,
  );
  requireTrue(
    autonomousReasons,
    "commentsMonitorHealthy",
    input.commentsMonitorHealthy,
  );
  requireTrue(
    autonomousReasons,
    "publicationCancellable",
    input.publicationCancellable,
  );
  requireTrue(autonomousReasons, "o4Eligible", input.o4Eligible);
  requireNonO15(autonomousReasons, input.o15Channel);
  result.autonomousPublish = decision(autonomousReasons);

  const graduateReasons: MarketingAutomationAccessReason[] = [];
  requireTrue(
    graduateReasons,
    "adminHasMarketingWrite",
    input.adminHasMarketingWrite,
  );
  requireTrue(graduateReasons, "adminStepUpRecent", input.adminStepUpRecent);
  requireTrue(graduateReasons, "o3Satisfied", input.o3Satisfied);
  requireTrue(
    graduateReasons,
    "commentsMonitorHealthy",
    input.commentsMonitorHealthy,
  );
  requireNonO15(graduateReasons, input.o15Channel);
  result.graduate = decision(graduateReasons);

  const experimentReasons: MarketingAutomationAccessReason[] = [];
  requireTrue(
    experimentReasons,
    "experimentsEnabled",
    input.experimentsEnabled,
  );
  requireTrue(
    experimentReasons,
    "cacheCspSpikePassed",
    input.cacheCspSpikePassed,
  );
  const approvalExperimentPath =
    input.adminHasMarketingWrite.ok &&
    input.adminHasMarketingWrite.value === true &&
    input.adminStepUpRecent.ok &&
    input.adminStepUpRecent.value === true;
  const autonomousExperimentPath =
    input.autonomousSurfaceGraduated.ok &&
    input.autonomousSurfaceGraduated.value === true;
  if (!approvalExperimentPath && !autonomousExperimentPath) {
    requireTrue(
      experimentReasons,
      "adminHasMarketingWrite",
      input.adminHasMarketingWrite,
    );
    requireTrue(
      experimentReasons,
      "adminStepUpRecent",
      input.adminStepUpRecent,
    );
    requireTrue(
      experimentReasons,
      "autonomousSurfaceGraduated",
      input.autonomousSurfaceGraduated,
    );
  }
  result.experimentActivate = decision(experimentReasons);

  const seoReasons: MarketingAutomationAccessReason[] = [];
  requireTrue(
    seoReasons,
    "seoAutoMergeRepositoryEnabled",
    input.seoAutoMergeRepositoryEnabled,
  );
  requireTrue(seoReasons, "surfaceGraduation", input.surfaceGraduation);
  result.seoAutoMerge = decision(seoReasons);

  const shadowReasons: MarketingAutomationAccessReason[] = [];
  requireTrue(
    shadowReasons,
    "webhookShadowEnabled",
    input.webhookShadowEnabled,
  );
  if (!input.deploymentEnvironment.ok) {
    add(shadowReasons, "input_unreadable:deploymentEnvironment");
  } else if (input.deploymentEnvironment.value !== "staging") {
    add(shadowReasons, "environment_not_staging");
  }
  if (!input.resolvedDeploymentEnvironment.ok) {
    add(shadowReasons, "input_unreadable:resolvedDeploymentEnvironment");
  } else if (input.resolvedDeploymentEnvironment.value !== "staging") {
    add(shadowReasons, "environment_not_staging");
  }
  requireTrue(
    shadowReasons,
    "webhookSignatureVerified",
    input.webhookSignatureVerified,
  );
  result.webhookShadow = decision(shadowReasons);

  result.webhookApply = webhookApplyDecision(input);
  return result;
};
