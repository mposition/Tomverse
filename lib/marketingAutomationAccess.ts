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

export type MarketingAutomationInputName =
  keyof MarketingAutomationAccessInputs;

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
  | "webhook_production_config_unsigned"
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
export const ZERNIO_WEBHOOK_SECRET_ENV = "ZERNIO_WEBHOOK_SECRET";
export const ZERNIO_API_KEY_ENV = "ZERNIO_API_KEY";

export const MARKETING_DRAFTS_KEY = "marketingAutomation.draftsEnabled";
export const MARKETING_PUBLISH_KEY = "marketingAutomation.publishEnabled";
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
 * The S2e receiver, dedupe, storage, mapping and status-query comparison now
 * exist and are in the fingerprint below. This stays false until S2f adds the
 * separately signed production configuration generation (S1 r7 amendment 1):
 * a staging record alone never applies an event in production.
 */
export const MARKETING_WEBHOOK_PIPELINE_COMPLETE = false;

export const MARKETING_WEBHOOK_SCHEMA_VERSION = "marketing-webhook-shadow-v1";
/** Written out, not imported: the receiver's core imports this module. */
export const MARKETING_WEBHOOK_ACCEPTED_EVENT_TYPES = [
  "post.published",
  "post.failed",
  "post.partial",
  "post.cancelled",
  "post.platform.published",
  "post.platform.failed",
  "post.platform.deleted",
] as const;

/**
 * Every file whose bytes can decide what a received event becomes: the whole
 * local import closure of the receiver route (receiver, signature, dedupe,
 * storage and audit transaction, mapping, status query), plus the schema's receiver
 * models (MARKETING_WEBHOOK_SCHEMA_MODELS, not the whole file) and
 * the dedupe index it cannot see. Not a hand-picked subset -- the test derives
 * the closure and refuses any difference. This module itself is left out: it
 * holds the fingerprint, and its webhook inputs are in the descriptor below.
 * A change to any listed file makes a signed staging record stale.
 */
export const MARKETING_WEBHOOK_PIPELINE_FILES = [
  "app/api/_marketing/zernioAdapter.ts",
  "app/api/webhooks/zernio/route.ts",
  "lib/adminAudit.ts",
  "lib/adminAuditIntegrityCore.ts",
  "lib/adminAuditSystemActors.ts",
  "lib/clientIp.ts",
  "lib/deploymentEnvironment.ts",
  "lib/marketingAuditEvidence.ts",
  "lib/marketingAutomationSchema.ts",
  "lib/marketingBannedClaims.ts",
  "lib/marketingClaimVerbs.ts",
  "lib/marketingFacts.ts",
  "lib/marketingGuardCore.ts",
  "lib/marketingGuardNormalise.ts",
  "lib/marketingGuardRules.ts",
  "lib/marketingKoreanClaims.ts",
  "lib/marketingMemoryClaims.ts",
  "lib/marketingMinorsClaims.ts",
  "lib/marketingNegation.ts",
  "lib/marketingPublishAdapter.ts",
  "lib/marketingStore.ts",
  "lib/marketingWebhookCore.ts",
  "lib/marketingWebhookReceiver.ts",
  "lib/marketingWebhookSettings.ts",
  "lib/postgresConnectionConfigCore.mjs",
  "lib/prisma.ts",
  "lib/zernioPublishAdapter.ts",
  "prisma/migrations/20261002120000_marketing_webhook_shadow_event_unique/migration.sql",
  "prisma/schema.prisma",
] as const;

/** The route whose import closure the list above must equal. */
export const MARKETING_WEBHOOK_PIPELINE_ROOT = "app/api/webhooks/zernio/route.ts";

/**
 * Names only. The staging snapshot hashes these environment values; the
 * fingerprint carries the names, never a value.
 */
export const MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR = {
  appSettingKeys: [MARKETING_WEBHOOK_SHADOW_KEY],
  envNames: [
    APP_ENV,
    RAILWAY_ENVIRONMENT_NAME,
    TOMVERSE_DEPLOY_ENV,
    ZERNIO_API_KEY_ENV,
    ZERNIO_WEBHOOK_SECRET_ENV,
  ],
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
    throw new Error(
      `Marketing webhook pipeline path is not relative POSIX: ${value}`,
    );
  }
  return path;
};

/**
 * The schema models the receiver path reads or writes. These blocks, their
 * enums, datasource and generator enter the fingerprint (operator decision
 * 2026-10-03): an unrelated model added elsewhere in the schema no longer
 * stales a signed record, and a change to any of these still does.
 */
export const MARKETING_WEBHOOK_SCHEMA_MODELS = [
  "AdminAuditLog",
  "AppSetting",
  "MarketingChannel",
  "MarketingReport",
] as const;

const MARKETING_WEBHOOK_SCHEMA_PATH = "prisma/schema.prisma";

/**
 * The declared models' blocks, the enums their fields use, and the datasource
 * and generator blocks (a provider or relationMode change alters what the
 * receiver can store), in schema order. Blocks end at a `}` in column 0, which
 * `prisma format` guarantees; a watched model that cannot be found throws.
 */
export const marketingWebhookSchemaSlice = (schemaText: string): string => {
  const blocks = new Map<string, string>();
  const order: string[] = [];
  for (const match of canonicalMarketingWebhookFileText(schemaText).matchAll(
    /^(model|enum|datasource|generator)\s+(\w+)\s*\{[\s\S]*?^\}/gm,
  )) {
    const key = `${match[1]} ${match[2]}`;
    blocks.set(key, match[0]);
    order.push(key);
  }
  const wanted = new Set<string>(
    order.filter((key) => key.startsWith("datasource ") || key.startsWith("generator ")),
  );
  for (const model of MARKETING_WEBHOOK_SCHEMA_MODELS) {
    const block = blocks.get(`model ${model}`);
    if (block === undefined) {
      throw new Error(`Marketing webhook schema model is missing: ${model}`);
    }
    wanted.add(`model ${model}`);
    for (const line of block.split("\n").slice(1)) {
      const field = /^\s*\w+\s+(\w+)/.exec(line);
      if (field && blocks.has(`enum ${field[1]}`)) wanted.add(`enum ${field[1]}`);
    }
  }
  return `${order
    .filter((key) => wanted.has(key))
    .map((key) => blocks.get(key))
    .join("\n\n")}\n`;
};

export const computeMarketingWebhookPipelineFingerprint = (
  files: ReadonlyArray<{ path: string; content: string }>,
  descriptor: unknown,
): string => {
  const canonicalFiles = files
    .map((file) => {
      const path = canonicalPipelinePath(file.path);
      const content = canonicalMarketingWebhookFileText(file.content);
      return {
        path,
        content:
          path === MARKETING_WEBHOOK_SCHEMA_PATH
            ? marketingWebhookSchemaSlice(content)
            : content,
      };
    })
    .sort((left, right) => codePointCompare(left.path, right.path));

  if (
    new Set(canonicalFiles.map((file) => file.path)).size !==
    canonicalFiles.length
  ) {
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
 * `MarketingPost.factsDigest`, nullable for rows predating the column. S2b3
 * (2026-09-23) made it NOT NULL once both databases read zero. Webhook
 * admission never reads it; the fingerprint moves because the schema is watched.
 *
 * 2026-09-21: Prompt Refiner confirmatory shadow v4 adds nullable evidence
 * columns and a new attempt check to the same schema. Those additions do not
 * touch a marketing model or admission decision; the watched-file digest still
 * moves so the dependency is reviewed explicitly.
 *
 * 2026-09-23, S2b1: `MARKETING_PAUSE_REASON_CODES` and its type moved into
 * the watched schema module from `lib/marketingStore.ts`, which is server-only
 * and therefore unreadable by the console that has to offer the list. The
 * store re-exports the same names, so no caller changed and no value changed.
 * Webhook admission reads none of it -- the pause reasons are not an input to
 * any webhook decision -- but the file is watched whole, so the digest moves
 * and the move is recorded here rather than absorbed.
 *
 * 2026-09-22: AMUX backlog default and source-provenance columns change only
 * `AmuxWorkItem`. They do not change a marketing model, webhook writer, or
 * admission decision; the whole-schema fingerprint moves by design.
 *
 * 2026-09-22: the catalog-import approval table is another `Amux*` model on
 * the same watched schema. It does not change a marketing model, webhook
 * writer, or admission decision. The digest moves because the schema file
 * is watched as a whole.
 *
 * 2026-09-21, the permission ledger (S3): six more tables on the same watched
 * schema -- EmailPermissionEvent, EmailSendApproval with its cohort and
 * revocations, EmailPermissionDecision and its evidence. None is a marketing
 * model, none changes the descriptor, the config snapshot or an admission
 * decision, and nothing this pipeline stores or reads is different. The one
 * shared edge is ConsentRecord, which gains a back-relation and no column.
 *
 * Both notes stand because both changes are in this tree, and the value below
 * is computed over the merged schema rather than taken from either side of
 * the conflict -- the merged tree is the only one that will exist.
 *
 * 2026-09-23, the multi-provider routing identity schema: twelve tables --
 * ProviderEndpoint, EndpointResidencyApproval, ModelDeployment,
 * RoutingIdentityManifest and its entries, DeploymentCacheAffinity,
 * ProviderRegistryEntry, QuotaScope, CredentialBinding,
 * RoutingCandidateVerdict, QuotaCapacityState, AvailabilityObservation --
 * plus columns on RoutingRun, RoutingAttempt, ProviderProbeResult and
 * ModelDeployment. Every one of them is dark: `npm run check:dark-tables`
 * fails if any runtime source reads or writes one.
 *
 * None is a marketing model, none touches the descriptor, the config
 * snapshot, a webhook writer or an admission decision. The shared edges are
 * back-relations only -- `User` gains two and `Conversation` gains one, and
 * neither gains a column. The digest moves because the schema file is
 * watched whole.
 *
 * 2026-09-23, the version gate columns on ModelDeployment and
 * RoutingIdentityManifestEntry. Both tables are already dark. The columns
 * are not marketing models and do not touch a webhook writer. The digest
 * moves because the schema file is watched whole.
 *
 * 2026-09-23, rotation and expiry instants on CredentialBinding. The table
 * is already dark. Neither column is a marketing model, and neither touches
 * a webhook writer. The digest moves because the schema file is watched whole.
 *
 * 2026-09-23, two nullable version columns on RoutingRun for the versions a
 * request holds from the moment it starts. The table is already a marketing
 * neighbour only by living in the same schema file. The columns are not
 * marketing models and do not touch a webhook writer. The digest moves
 * because the schema file is watched whole.
 *
 * 2026-09-23, a nullable millisecond deadline on RoutingRun and two nullable
 * affinity columns on the dark cache-affinity table. None is a marketing
 * model and none touches a webhook writer. The digest moves because the
 * schema file is watched whole.
 *
 * 2026-09-23, a nullable pre-commit buffer duration on RoutingRun. The
 * column is not a marketing model and does not touch a webhook writer.
 * The digest moves because the schema file is watched whole.
 *
 * 2026-09-23, the routing snapshot ceiling, merged onto the stack above:
 * RoutingSnapshotCeilingApproval, two columns on RoutingIdentityManifest
 * that cite it, a `slot` column on RoutingIdentityManifestEntry and an
 * index the migration already created. All dark, none a marketing model,
 * nothing here touches the descriptor, the config snapshot, a webhook
 * writer or an admission decision. The digest below is the merged schema,
 * not either parent's.
 *
 * 2026-09-24, AvailabilityRollupApplication. Dark, no marketing model, no
 * webhook writer. The digest moves because the schema file is watched whole.
 *
 * 2026-09-24, DeploymentPriceSnapshot. Dark, no marketing model, no webhook
 * writer, and not the credit reservation snapshot. Its amount is one rate
 * per million tokens. The digest moves because the schema is watched whole.
 *
 * 2026-09-24, PinnedDeploymentExperiment and its hold. Not a marketing
 * model, not a webhook writer, and not a credit balance. The limit is
 * whatever row is stored; the schema has no default amount. The digest
 * moves because the schema is watched whole.
 *
 * 2026-09-24: the release reconciliation adds the latched-off
 * `AmuxBoardPromotionApproval` model and nullable execution-brief evidence to
 * `AmuxWorkItem`. Neither is a marketing model or webhook input. The digest
 * still moves because the whole Prisma schema is deliberately watched.
 *
 * 2026-09-27: the Prompt Refiner stage successor updates two contract comments
 * in the watched schema: the runtime manifest is now v4 over 189 files, and the
 * evidence-spec requirement applies to every v4-or-later shadow run. No model,
 * column, constraint, webhook writer, descriptor or admission decision changes;
 * the fingerprint moves because schema comments are watched bytes too.
 *
 * 2026-09-27: the AMUX back-merge adds the latched-off recommendation pool
 * and the closed auto-promotion gate. Neither is a marketing model or a
 * webhook input. The digest moves because the whole Prisma schema is
 * deliberately watched.
 *
 * 2026-09-28: the engineering agent's seven state tables
 * (EngineeringAgentRun through EngineeringAgentRequest) and their back
 * relations on AmuxWorkItem, AmuxExecutionAttempt and AdminAuditLog. None is
 * a marketing model or a webhook input, and no descriptor, webhook writer or
 * admission decision changes. The digest moves because the whole Prisma
 * schema is deliberately watched. develop moved the schema in the same days,
 * so the value below is computed over the merged schema, not either side's.
 *
 * 2026-09-29: the AMUX back-merge of orchestration policy v15 binds
 * auto-promotion grants to one item and one cent amount (three nullable
 * columns on `AmuxRecommendationAutoGrant`) and adds
 * `AmuxRecommendationAutoUnknown`. Neither is a marketing model or a webhook
 * input. The digest moves because the whole Prisma schema is deliberately
 * watched.
 *
 * 2026-09-29: `AmuxCommitDeadline`, the marker a deferred trigger reads to
 * refuse an AMUX COMMIT that arrives after its deadline (orchestration policy
 * version 18). Not a marketing model, not a webhook input, and no descriptor,
 * webhook writer or admission decision changes. The digest moves because the
 * whole Prisma schema is deliberately watched.
 *
 * 2026-09-29: the release-notes send verdict (S9) -- the permission ledger's
 * decision columns and `EmailDelivery`'s display-contract pin -- merged with
 * develop. Not a marketing webhook input and no descriptor or admission
 * decision changes; the value below is computed over the merged schema.
 *
 * 2026-09-29: sign-up consent (S4) adds the `SignupConsentAttempt` model and
 * its relation on `User`. Neither is a marketing model or a webhook input; the
 * digest moves because the whole Prisma schema is deliberately watched.
 *
 * 2026-09-29: the current Prompt Refiner v5 manifest binds 190 files (stage
 * v4/run v6). Only schema comments changed, not models, webhook inputs,
 * descriptor or admission decisions. All dated notes above stand in this
 * tree; the fingerprint is computed over the merged schema.
 *
 * 2026-09-30: the sign-up consent branch (S4) merges develop; both notes above
 * stand, and the value below is computed over the merged schema.
 *
 * 2026-09-30: the sign-in / sign-up split (v25, section 5.2a) adds two
 * nullable sign-up hold columns to `EmailLoginAttempt`. Not a marketing model or
 * a webhook input; the digest moves because the whole schema is watched.
 *
 * 2026-09-30: `ModelRegistryEntry` gains the nullable `webSearchOverride`
 * column (an administrator's per-model web search route). Not a marketing
 * model or a webhook input; the digest moves because the whole Prisma schema
 * is deliberately watched. Descriptor and admission decisions are unchanged.
 *
 * 2026-09-30: the sign-in / sign-up split takes develop with the web search
 * override; both notes above stand, and the value below is computed over the
 * merged schema.
 *
 * 2026-10-02: the product-research agent's observation table is added
 * (docs/policy/product-research-agent.md §4) -- one new model with its own
 * triggers. Not a marketing model and not a webhook input; the digest moves
 * because the whole Prisma schema is deliberately watched. Descriptor and
 * admission decisions are unchanged. The value below is computed with that
 * model's columns aligned the way `prisma format` aligns them, which is the
 * state the file is committed in.
 *
 * 2026-10-03: product-research and CHAT-01 changed the schema after develop
 * was repinned. The value below covers the merged schema including the
 * CHAT-01 one-shot dark tables; older fingerprints are intentionally stale.
 * SupportTriageRun and its two audit actors remain included in the merged schema. billing-finance-ops adds its digest intake actor (docs/policy/billing-finance-ops.md §7 W1a); descriptor and admission decisions unchanged. SupportTriageSuggestion and the account-deletion actor move it again.
 *
 * 2026-10-04: the sre-ops agent's audit actor ("ops-observer") is added to
 * `lib/adminAuditSystemActors.ts`, and `lib/adminAudit.ts` gains
 * `writeSystemAuditLogEntry()`, which returns the entry's hash with its id
 * (docs/policy/sre-ops.md §3-10). Both files are in the receiver's import
 * closure. The receiver's calls and the rows it writes are unchanged; the
 * fingerprint moves because the closure's bytes did. Computed over the merged
 * tree, which includes the support-triage and agent-digest actors above.
 *
 * 2026-10-05: AMUX v4 adds a separately scoped system-audit action for its
 * analysis budget hold. The webhook receiver's imports and decisions do not
 * change; its existing audit-helper closure now has different source bytes.
 * The AMUX expiry, settlement, unknown-outcome and auto-cancel audit scopes
 * move those same helper bytes again. Existing signed staging evidence becomes
 * stale; the receiver's own admission and write path remain unchanged.
 * 2026-10-07: v22 worker claim adds a closed system-audit actor in the same
 * imported helper closure. Re-pin after the AMUX source changes are verified.
 * 2026-10-07: A06 adds analysis claim, result, retention and key-retirement
 * audit scopes. The receiver still uses the same audit entry path; its shared
 * actor helper and watched schema bytes changed, so prior evidence is stale.
 * 2026-10-07: `lib/deploymentEnvironment.ts` lists `dev`, the Railway
 * environment that takes develop once staging holds release candidates. The
 * receiver's staging test still needs both signals to say staging, and dev
 * resolves to dev, so dev never reaches the shadow writer; descriptor and
 * admission decisions are unchanged. Prior evidence is stale.
 * 2026-10-07: A09 adds closed AMUX audit actors in the same imported helper closure.
 * The receiver's admission and write path are unchanged.
 * 2026-10-07: A12 portfolio and promotion work extends the watched schema
 * and shared audit helper. The receiver's own admission stays unchanged.
 * 2026-10-07: the AMUX Decision Maker switch store, per
 * docs/policy/amux-decision-maker.md §10, adds three system actors to
 * `lib/adminAuditSystemActors.ts` and its switch events' back relation to
 * `AdminAuditLog` in the watched schema. The receiver's calls, descriptor and
 * admission decisions are unchanged; the bytes moved, so evidence is stale.
 * 2026-10-08: the AMUX Decision Maker request ledger (S1c, per
 * docs/policy/amux-decision-maker.md §10) adds its request and request event
 * back relations to `AdminAuditLog` in the watched schema. No actor,
 * descriptor, webhook writer or admission decision changes; the bytes moved,
 * so evidence is stale.
 * 2026-10-08: the AMUX Decision Maker body store (S1d, per
 * docs/policy/amux-decision-maker.md §10) adds its body, retention event and
 * digest-key event back relations to `AdminAuditLog` in the watched schema.
 * No actor, descriptor, webhook writer or admission decision changes; the
 * bytes moved, so evidence is stale.
 * 2026-10-08, the S1d review: the body store adds the result detail's back
 * relation to `AdminAuditLog` in the watched schema. Nothing else changes; the
 * bytes moved, so evidence is stale.
 * 2026-10-08: the AMUX Decision Maker judgment and delivery records (S1e, per
 * docs/policy/amux-decision-maker.md §10) add the judgment and delivery event
 * models and their back relations to `AdminAuditLog`, the request and the
 * request event in the watched schema. No actor, descriptor, webhook writer or
 * admission decision changes; the bytes moved, so evidence is stale.
 * 2026-10-09: the separate Prompt Refiner product-Auto budget hold adds a
 * narrowly scoped audit actor to the shared helper and two back relations to
 * `AdminAuditLog`. The marketing receiver's decisions are unchanged, but its
 * watched source and schema bytes moved, so prior evidence is stale.
 * 2026-10-10: the Prompt Refiner product operational guard adds one closed
 * system-audit action and its `AdminAuditLog` back relation. The webhook
 * receiver's calls, descriptor and admission decisions are unchanged; the
 * watched closure bytes moved, so existing signed staging evidence is stale.
 */
export const MARKETING_WEBHOOK_PIPELINE_FINGERPRINT =
  "b9fef04f561d94087802d02e42bcc708374988fa8d3f5fef190fc852acc62087";

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
    [...names]
      .sort(codePointCompare)
      .map((name) => [
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
      acceptedEventTypes: [...snapshot.acceptedEventTypes].sort(
        codePointCompare,
      ),
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
    stagingConfigSnapshotDigest: sha256Hex,
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

/**
 * What a stored apply-scope value is, judged exactly as `readJson` judges it.
 *
 * Exported so a screen can report the document's state without arriving at a
 * different answer from the decision. The Admin console's switch strip got
 * this wrong twice by reading the raw string: an empty string is a *stored*
 * document this module refuses, and a BOM-prefixed document is one it accepts,
 * so "non-empty" and "parses as JSON" are both the wrong test.
 *
 * `absent` is the only state the decision does not distinguish -- it refuses a
 * missing value and a malformed one alike -- and it is the distinction an
 * operator needs, because one of the two is somebody's mistake sitting in a
 * row that nothing else would mention.
 */
export type MarketingWebhookApplyScopeStatus = "absent" | "valid" | "invalid";

export const marketingWebhookApplyScopeStatus = (
  value: string | null | undefined,
): MarketingWebhookApplyScopeStatus => {
  if (typeof value !== "string") return "absent";
  try {
    return marketingWebhookApplyScopeSchema.safeParse(
      JSON.parse(canonicalMarketingWebhookFileText(value)),
    ).success
      ? "valid"
      : "invalid";
  } catch {
    return "invalid";
  }
};

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

  if (
    record &&
    record.pipelineFingerprint !== MARKETING_WEBHOOK_PIPELINE_FINGERPRINT
  ) {
    add(reasons, "webhook_pipeline_fingerprint_stale");
  }
  if (!input.webhookConfigSnapshot.ok) {
    add(reasons, "input_unreadable:webhookConfigSnapshot");
  } else if (
    !isDeclaredMarketingWebhookConfigSnapshot(input.webhookConfigSnapshot.value)
  ) {
    add(reasons, "webhook_config_snapshot_invalid");
  }
  // S1 r7 amendment 1: the record's staging snapshot is staging evidence and is
  // never compared with the live one -- environment identity, shadow state and
  // secrets are meant to differ. Production is bound by its own separately
  // signed configuration generation, which S2f adds; until then nothing is.
  add(reasons, "webhook_production_config_unsigned");

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
          !record.observedScope.some((observed) =>
            sameScopeEntry(entry, observed),
          ),
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
