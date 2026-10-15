// The production configuration generation (S2 plan, S2f; S1 r7 amendment 1).
//
// A staging verification record proves the receiver pipeline; it says nothing
// about production, whose environment identity, switches and secrets are meant
// to differ. Production is bound by its own, separately signed generation: an
// operator signs the live production configuration digest, and the apply
// decision later refuses unless the stored generation, its audit row and the
// configuration it reads at that moment all still agree. Only the pipeline
// fingerprint crosses environments.
//
// Pure: no database, no environment read, no clock. The route that signs and
// the receiver that applies (later S2f slices) supply the live values.

import { createHash } from "node:crypto";
import { z } from "zod";

import {
  MARKETING_WEBHOOK_ACCEPTED_EVENT_TYPES,
  MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR,
  MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
  MARKETING_WEBHOOK_SCHEMA_VERSION,
  MARKETING_WEBHOOK_SHADOW_KEY,
  canonicalMarketingWebhookFileText,
  canonicalMarketingWebhookJson,
  computeMarketingWebhookConfigSnapshotDigest,
  marketingWebhookEnvDigests,
  type ReadResult,
} from "@/lib/marketingAutomationAccess";
import type { MarketingWebhookChannelBinding } from "@/lib/marketingWebhookCore";

export const MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY =
  "marketingAutomation.webhookProductionConfig";

export const MARKETING_WEBHOOK_PRODUCTION_CONFIG_SIGNED_ACTION =
  "marketing_webhook.production_config_signed";

/**
 * A production configuration signature refused, with a closed code. Here rather
 * than beside the store so a route can recognise it without importing anything
 * that reaches the store.
 */
export class MarketingWebhookProductionConfigRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MarketingWebhookProductionConfigRefusedError";
    this.code = code;
  }
}

// The same field rules as the verification record and signature in
// lib/marketingAutomationAccess.ts. Repeated rather than exported from there:
// that file is sealed into another contract's reviewed closure, and a new
// export moves its bytes.
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const gitCommitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const verificationRecordId = z.string().regex(/^\d{4}-\d{2}-\d{2}__[a-z0-9-]{1,64}$/);
const boundedToken = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

export const marketingWebhookProductionConfigGenerationSchema = z
  .object({
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    recordId: verificationRecordId,
    environment: z.literal("production"),
    deployCommitSha: gitCommitSha,
    pipelineFingerprint: sha256Hex,
    productionConfigSnapshotDigest: sha256Hex,
    signatureAuditLogId: boundedToken,
  })
  .strict();

export type MarketingWebhookProductionConfigGeneration = z.infer<
  typeof marketingWebhookProductionConfigGenerationSchema
>;

export type MarketingWebhookProductionConfigRead =
  | { readonly status: "absent" }
  | { readonly status: "invalid" }
  | { readonly status: "valid"; readonly value: MarketingWebhookProductionConfigGeneration };

/**
 * The stored AppSetting value, judged once. `absent` (no row) and `invalid`
 * (a row this module refuses) stay distinct: the first is the state before any
 * signature, the second is somebody's mistake, and neither may be signed over.
 */
export const readMarketingWebhookProductionConfig = (
  value: string | null | undefined,
): MarketingWebhookProductionConfigRead => {
  if (value === null || value === undefined) return { status: "absent" };
  try {
    const parsed = marketingWebhookProductionConfigGenerationSchema.safeParse(
      JSON.parse(canonicalMarketingWebhookFileText(value)),
    );
    return parsed.success ? { status: "valid", value: parsed.data } : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
};

export const serializeMarketingWebhookProductionConfig = (
  value: MarketingWebhookProductionConfigGeneration,
): string =>
  canonicalMarketingWebhookJson(marketingWebhookProductionConfigGenerationSchema.parse(value));

/**
 * The generation a new signature writes: one more than the stored one, or 1
 * when nothing was signed yet. `null` refuses: an unreadable or invalid stored
 * value is never overwritten by a signature that could not see what it replaced.
 */
export const nextMarketingWebhookProductionConfigGeneration = (
  current: ReadResult<MarketingWebhookProductionConfigRead>,
): number | null => {
  if (!current.ok) return null;
  if (current.value.status === "absent") return 1;
  if (current.value.status === "invalid") return null;
  const next = current.value.value.generation + 1;
  return Number.isSafeInteger(next) ? next : null;
};

/**
 * The live production configuration digest: the same declared slice the
 * staging snapshot hashes -- webhook switch values, accepted events, schema
 * version, hashes (never values) of the declared environment names, and which
 * Zernio account each channel answers for -- under the name `production`, so a
 * staging digest can never be presented as a production one. The apply-scope
 * value is deliberately not in it: scope is checked separately against the
 * signed generation, and narrowing it must not invalidate the signature.
 */
export const marketingWebhookProductionConfigSnapshotDigest = (
  env: Readonly<Record<string, string | undefined>>,
  shadowValue: string | null,
  channels: readonly MarketingWebhookChannelBinding[],
): string =>
  createHash("sha256")
    .update(
      canonicalMarketingWebhookJson({
        environment: "production",
        snapshot: computeMarketingWebhookConfigSnapshotDigest({
          appSettings: { [MARKETING_WEBHOOK_SHADOW_KEY]: shadowValue },
          acceptedEventTypes: [...MARKETING_WEBHOOK_ACCEPTED_EVENT_TYPES],
          envDigests: marketingWebhookEnvDigests(env, MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR.envNames),
          schemaVersion: MARKETING_WEBHOOK_SCHEMA_VERSION,
        }),
        channels: channels
          .map((channel) => JSON.stringify([channel.id, channel.externalAccountRef]))
          .sort(),
      }),
      "utf8",
    )
    .digest("hex");

/**
 * What the signing audit row recorded, as read back through the hash-chain
 * verifier. `verified` is that verifier's verdict on the row as a whole (human
 * actor, permission flag, exact action, valid chain); the other fields are the
 * values it bound, compared here against the stored generation.
 */
export type MarketingWebhookProductionConfigAuditEvidence = {
  readonly auditLogId: string;
  readonly verified: boolean;
  readonly generation: number;
  readonly recordId: string;
  readonly deployCommitSha: string;
  readonly pipelineFingerprint: string;
  readonly productionConfigSnapshotDigest: string;
};

export type MarketingWebhookProductionConfigRefusal =
  | "production_config_unreadable"
  | "production_config_absent"
  | "production_config_invalid"
  | "production_config_not_production"
  | "production_config_record_mismatch"
  | "production_config_fingerprint_stale"
  | "production_config_snapshot_mismatch"
  | "production_config_audit_unreadable"
  | "production_config_audit_invalid";

export type MarketingWebhookProductionConfigCheck = {
  readonly stored: ReadResult<MarketingWebhookProductionConfigRead>;
  readonly audit: ReadResult<MarketingWebhookProductionConfigAuditEvidence>;
  /** `resolveDeploymentEnvironment()` of the process deciding. */
  readonly liveEnvironment: ReadResult<string>;
  /** The live production digest, computed by the caller in the same read. */
  readonly liveSnapshotDigest: ReadResult<string>;
  /** The verification record the apply scope names. */
  readonly recordId: string | null;
};

/**
 * Every reason the signed generation does not bind the live production
 * configuration, all of them -- not the first. Empty means it binds.
 *
 * The deploy commit is recorded for provenance and is not compared with the
 * live one: the pipeline fingerprint is what must not move, and a release that
 * leaves it unchanged must not silently stop production applying events.
 */
export const marketingWebhookProductionConfigRefusals = (
  input: MarketingWebhookProductionConfigCheck,
): MarketingWebhookProductionConfigRefusal[] => {
  const reasons: MarketingWebhookProductionConfigRefusal[] = [];
  const add = (reason: MarketingWebhookProductionConfigRefusal) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (!input.liveEnvironment.ok || input.liveEnvironment.value !== "production") {
    add("production_config_not_production");
  }

  let signed: MarketingWebhookProductionConfigGeneration | null = null;
  if (!input.stored.ok) add("production_config_unreadable");
  else if (input.stored.value.status === "absent") add("production_config_absent");
  else if (input.stored.value.status === "invalid") add("production_config_invalid");
  else signed = input.stored.value.value;

  if (signed) {
    if (input.recordId === null || signed.recordId !== input.recordId) {
      add("production_config_record_mismatch");
    }
    if (signed.pipelineFingerprint !== MARKETING_WEBHOOK_PIPELINE_FINGERPRINT) {
      add("production_config_fingerprint_stale");
    }
    if (
      !input.liveSnapshotDigest.ok ||
      input.liveSnapshotDigest.value !== signed.productionConfigSnapshotDigest
    ) {
      add("production_config_snapshot_mismatch");
    }
  }

  if (!input.audit.ok) {
    add("production_config_audit_unreadable");
  } else {
    const audit = input.audit.value;
    if (
      !signed ||
      !audit.verified ||
      audit.auditLogId !== signed.signatureAuditLogId ||
      audit.generation !== signed.generation ||
      audit.recordId !== signed.recordId ||
      audit.deployCommitSha !== signed.deployCommitSha ||
      audit.pipelineFingerprint !== signed.pipelineFingerprint ||
      audit.productionConfigSnapshotDigest !== signed.productionConfigSnapshotDigest
    ) {
      add("production_config_audit_invalid");
    }
  }

  return reasons;
};

// ---------------------------------------------------------------------------
// The apply scope (`marketing_webhook.apply_scope_changed`)
// ---------------------------------------------------------------------------

export const MARKETING_WEBHOOK_APPLY_SCOPE_CHANGED_ACTION =
  "marketing_webhook.apply_scope_changed";

const scopeEntry = z
  .object({
    eventType: boundedToken,
    channelId: boundedToken,
  })
  .strict();

/**
 * The stored apply scope: which exact (event type, channel) pairs production may
 * apply, under which verification record and which signed production
 * generation. An empty scope is storable and applies nothing -- it is how an
 * operator stops production applying without touching the signature.
 */
export const marketingWebhookProductionApplyScopeSchema = z
  .object({
    recordId: verificationRecordId,
    productionConfigGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    scope: z
      .array(scopeEntry)
      .max(200)
      .superRefine((entries, context) => {
        const seen = new Set<string>();
        for (const entry of entries) {
          const key = JSON.stringify([entry.eventType, entry.channelId]);
          if (seen.has(key)) {
            context.addIssue({ code: "custom", message: "duplicate scope entry" });
            return;
          }
          seen.add(key);
        }
      }),
  })
  .strict();

export type MarketingWebhookProductionApplyScope = z.infer<
  typeof marketingWebhookProductionApplyScopeSchema
>;

export type MarketingWebhookProductionApplyScopeRead =
  | { readonly status: "absent" }
  | { readonly status: "invalid" }
  | { readonly status: "valid"; readonly value: MarketingWebhookProductionApplyScope };

export const readMarketingWebhookProductionApplyScope = (
  value: string | null | undefined,
): MarketingWebhookProductionApplyScopeRead => {
  if (value === null || value === undefined) return { status: "absent" };
  try {
    const parsed = marketingWebhookProductionApplyScopeSchema.safeParse(
      JSON.parse(canonicalMarketingWebhookFileText(value)),
    );
    return parsed.success ? { status: "valid", value: parsed.data } : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
};

/** Entries sorted, so the same set of pairs is always the same bytes. */
export const serializeMarketingWebhookProductionApplyScope = (
  value: MarketingWebhookProductionApplyScope,
): string => {
  const parsed = marketingWebhookProductionApplyScopeSchema.parse(value);
  return canonicalMarketingWebhookJson({
    ...parsed,
    scope: [...parsed.scope].sort((left, right) =>
      JSON.stringify([left.eventType, left.channelId]) < JSON.stringify([right.eventType, right.channelId])
        ? -1
        : 1,
    ),
  });
};

/**
 * The digest a screen reads the stored scope as, and sends back as the value it
 * expects to replace: `absent` for no row, otherwise the sha-256 of the stored
 * bytes exactly -- not of their parse, so a row something else wrote is still a
 * value the caller has to have seen.
 */
export const marketingWebhookStoredValueDigest = (value: string | null | undefined): string =>
  value === null || value === undefined
    ? "absent"
    : createHash("sha256").update(value, "utf8").digest("hex");

/** The pairs of `requested` that the record never observed. */
export const marketingWebhookScopeOutsideObserved = (
  requested: readonly { readonly eventType: string; readonly channelId: string }[],
  observed: readonly { readonly eventType: string; readonly channelId: string }[],
): Array<{ eventType: string; channelId: string }> =>
  requested
    .filter(
      (entry) =>
        !observed.some(
          (seen) => seen.eventType === entry.eventType && seen.channelId === entry.channelId,
        ),
    )
    .map((entry) => ({ eventType: entry.eventType, channelId: entry.channelId }));
