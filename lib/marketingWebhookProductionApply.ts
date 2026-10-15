/**
 * Production webhook apply (S2 plan, S2f): decide and apply one signed Zernio
 * event, in one transaction.
 *
 * The receiver has verified the signature over the raw bytes and parsed the
 * envelope. This reads everything the decision needs and asks the access
 * resolver's `webhookApply` -- the same decision the console reports -- under
 * the audit chain lock, which every setting and signature writer also takes,
 * so the scope or the signed generation cannot change between the decision and
 * the write it allows. Then either the apply writer runs, or the refusal is
 * audited with the decision's closed reasons. Nothing is retried.
 *
 * The verification record's signature is the audit row the signed production
 * generation names: the signing transaction verified it and bound its id and
 * the record's digest, and it is verified again here against the record bytes
 * the tree carries now. No sibling signature file is needed.
 */

import "server-only";

import { takeAuditChainLock } from "@/lib/adminAudit";
import {
  MARKETING_AUTOMATION_KILL_SWITCH_ENV,
  MARKETING_WEBHOOK_ACCEPTED_EVENT_TYPES,
  MARKETING_WEBHOOK_APPLY_SCOPE_KEY,
  MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR,
  MARKETING_WEBHOOK_SCHEMA_VERSION,
  MARKETING_WEBHOOK_SHADOW_KEY,
  canonicalMarketingWebhookJson,
  digestMarketingWebhookVerificationRecord,
  marketingWebhookApplyScopeSchema,
  marketingWebhookEnvDigests,
  resolveMarketingAutomationAccess,
  canonicalMarketingWebhookFileText,
  type ReadResult,
} from "@/lib/marketingAutomationAccess";
import {
  verifyMarketingAuditEvidence,
  verifyMarketingWebhookSignatureAuditEvidence,
} from "@/lib/marketingAuditEvidence";
import {
  applyMarketingWebhookEvent,
  recordMarketingWebhookApplyNotPermitted,
  type MarketingTransaction,
} from "@/lib/marketingStore";
import type { MarketingPostStatus } from "@/lib/marketingAutomationSchema";
import {
  MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY,
  marketingWebhookProductionConfigRefusals,
  marketingWebhookProductionConfigSnapshotDigest,
  readMarketingWebhookProductionConfig,
} from "@/lib/marketingWebhookProductionConfig";
import {
  marketingWebhookExplicitEnvironment,
  marketingWebhookProductionConfigAuditRequirement,
} from "@/lib/marketingWebhookProductionConfigStore";
import { readMarketingWebhookVerificationRecordFile } from "@/lib/marketingWebhookVerification";

export type MarketingWebhookProductionAnswer =
  | { readonly status: "applied" | "duplicate"; readonly to?: MarketingPostStatus }
  | { readonly status: "refused"; readonly code: string }
  | { readonly status: "not_applied" }
  | { readonly status: "channel_unknown" };

const unreadable: ReadResult<never> = { ok: false };

/** Whether a production generation has been signed at all: before that, production answers 404. */
export async function marketingWebhookProductionConfigured(
  db: Pick<MarketingTransaction, "appSetting">,
): Promise<boolean> {
  const row = await db.appSetting.findUnique({
    where: { key: MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY },
    select: { value: true },
  });
  return readMarketingWebhookProductionConfig(row?.value).status === "valid";
}

export async function handleMarketingWebhookProductionEvent(
  tx: MarketingTransaction,
  event: {
    readonly eventIdDigest: string;
    readonly eventType: string;
    readonly derivedStatus: MarketingPostStatus;
    readonly zernioPostId: string;
    readonly accountId: string;
  },
  deps: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly readRecordFile?: (recordId: string) => Promise<string | null>;
  } = {},
): Promise<MarketingWebhookProductionAnswer> {
  const env = deps.env ?? process.env;
  const readRecordFile = deps.readRecordFile ?? readMarketingWebhookVerificationRecordFile;

  // Every setting and signature writer takes this first; holding it from here
  // makes the decision and the write one instant for them.
  await takeAuditChainLock(tx);

  const [rows, channels] = await Promise.all([
    tx.appSetting.findMany({
      where: {
        key: {
          in: [
            MARKETING_WEBHOOK_SHADOW_KEY,
            MARKETING_WEBHOOK_APPLY_SCOPE_KEY,
            MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY,
          ],
        },
      },
      select: { key: true, value: true },
    }),
    tx.marketingChannel.findMany({
      where: { provider: "zernio", externalAccountRef: { not: null } },
      select: { id: true, externalAccountRef: true },
    }),
  ]);
  const settings = new Map(rows.map((row) => [row.key, row.value]));
  const bindings = channels.flatMap((channel) =>
    channel.externalAccountRef ? [{ id: channel.id, externalAccountRef: channel.externalAccountRef }] : [],
  );

  // One account, one channel; anything else is not an event about ours.
  const holders = bindings.filter((binding) => binding.externalAccountRef === event.accountId);
  if (holders.length !== 1) return { status: "channel_unknown" };
  const channelId = holders[0].id;

  const shadowValue = settings.get(MARKETING_WEBHOOK_SHADOW_KEY) ?? null;
  const scopeValue = settings.get(MARKETING_WEBHOOK_APPLY_SCOPE_KEY) ?? null;
  const stored = readMarketingWebhookProductionConfig(settings.get(MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY));
  const signed = stored.status === "valid" ? stored.value : null;

  // The record the scope names, as the tree carries it now.
  let scopeRecordId: string | null = null;
  try {
    const parsed = marketingWebhookApplyScopeSchema.safeParse(
      scopeValue === null ? null : JSON.parse(canonicalMarketingWebhookFileText(scopeValue)),
    );
    scopeRecordId = parsed.success ? parsed.data.recordId : null;
  } catch {
    scopeRecordId = null;
  }
  const recordText = scopeRecordId === null ? null : await readRecordFile(scopeRecordId);
  const recordDigest = recordText === null ? null : digestMarketingWebhookVerificationRecord(recordText);

  // The signed generation's own row, verified against those bytes, and the
  // record signature it names.
  let productionAuditVerified = false;
  let signatureText: string | null = null;
  let signatureEvidence: ReadResult<Awaited<ReturnType<typeof verifyMarketingWebhookSignatureAuditEvidence>>> =
    unreadable;
  if (signed && recordDigest !== null) {
    const verdict = await verifyMarketingAuditEvidence(
      tx,
      marketingWebhookProductionConfigAuditRequirement(signed, { recordDigest }),
    );
    productionAuditVerified = verdict.ok;
    const row = await tx.adminAuditLog.findUnique({
      where: { id: signed.signatureAuditLogId },
      select: { metadata: true },
    });
    const metadata = row?.metadata as Record<string, unknown> | null | undefined;
    const verificationSignatureAuditLogId =
      metadata && Object.hasOwn(metadata, "verificationSignatureAuditLogId")
        ? metadata.verificationSignatureAuditLogId
        : null;
    if (typeof verificationSignatureAuditLogId === "string") {
      const binding = {
        recordId: signed.recordId,
        recordDigest,
        signatureAuditLogId: verificationSignatureAuditLogId,
      };
      signatureText = canonicalMarketingWebhookJson(binding);
      signatureEvidence = { ok: true, value: await verifyMarketingWebhookSignatureAuditEvidence(tx, binding) };
    }
  }

  const liveSnapshotDigest = marketingWebhookProductionConfigSnapshotDigest(env, shadowValue, bindings);
  const refusals = marketingWebhookProductionConfigRefusals({
    stored: { ok: true, value: stored },
    audit: signed
      ? {
          ok: true,
          value: {
            auditLogId: signed.signatureAuditLogId,
            verified: productionAuditVerified,
            generation: signed.generation,
            recordId: signed.recordId,
            deployCommitSha: signed.deployCommitSha,
            pipelineFingerprint: signed.pipelineFingerprint,
            productionConfigSnapshotDigest: signed.productionConfigSnapshotDigest,
          },
        }
      : unreadable,
    liveEnvironment: { ok: true, value: marketingWebhookExplicitEnvironment(env) },
    liveSnapshotDigest: { ok: true, value: liveSnapshotDigest },
    recordId: scopeRecordId,
  });

  const decision = resolveMarketingAutomationAccess({
    // The resolver stops every feature on the kill switch, this one included;
    // the receiver also checks it before reading the body.
    killSwitchValue: { ok: true, value: env[MARKETING_AUTOMATION_KILL_SWITCH_ENV] },
    adminAuthenticated: unreadable,
    draftsEnabled: unreadable,
    llmGenerationBudgetAvailable: unreadable,
    generatorAuthenticated: unreadable,
    priceFallbackAlertReady: unreadable,
    adminHasMarketingWrite: unreadable,
    adminStepUpRecent: unreadable,
    publishEnabled: unreadable,
    channelMode: unreadable,
    adapterHealthy: unreadable,
    recoveryContractAvailable: unreadable,
    platformBudgetAvailable: unreadable,
    autoPublishEnabled: unreadable,
    commentsMonitorHealthy: unreadable,
    publicationCancellable: unreadable,
    o4Eligible: unreadable,
    o15Channel: unreadable,
    o3Satisfied: unreadable,
    experimentsEnabled: unreadable,
    cacheCspSpikePassed: unreadable,
    autonomousSurfaceGraduated: unreadable,
    seoAutoMergeRepositoryEnabled: unreadable,
    surfaceGraduation: unreadable,
    webhookShadowEnabled: unreadable,
    deploymentEnvironment: unreadable,
    resolvedDeploymentEnvironment: unreadable,
    // The receiver verified the signature before this was called.
    webhookSignatureVerified: { ok: true, value: true },
    webhookApplyScopeValue: { ok: true, value: scopeValue },
    webhookVerificationRecordText: { ok: true, value: recordText },
    webhookVerificationSignatureText: { ok: true, value: signatureText },
    webhookSignatureAuditEvidence: signatureEvidence,
    webhookConfigSnapshot: {
      ok: true,
      value: {
        appSettings: { [MARKETING_WEBHOOK_SHADOW_KEY]: shadowValue },
        acceptedEventTypes: [...MARKETING_WEBHOOK_ACCEPTED_EVENT_TYPES],
        envDigests: marketingWebhookEnvDigests(env, MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR.envNames),
        schemaVersion: MARKETING_WEBHOOK_SCHEMA_VERSION,
      },
    },
    webhookEvent: { ok: true, value: { eventType: event.eventType, channelId } },
    webhookProductionConfig: signed
      ? { ok: true, value: { generation: signed.generation, refusals } }
      : { ok: true, value: { generation: 0, refusals: refusals.length > 0 ? refusals : ["production_config_absent"] } },
  }).webhookApply;

  if (!decision.enabled) {
    await recordMarketingWebhookApplyNotPermitted(tx, {
      eventIdDigest: event.eventIdDigest,
      eventType: event.eventType,
      channelId,
      reasons: decision.reasons,
    });
    return { status: "not_applied" };
  }

  const outcome = await applyMarketingWebhookEvent(tx, {
    eventIdDigest: event.eventIdDigest,
    eventType: event.eventType,
    derivedStatus: event.derivedStatus,
    zernioPostId: event.zernioPostId,
    channelId,
  });
  if (outcome.outcome === "refused") return { status: "refused", code: outcome.code };
  if (outcome.outcome === "duplicate") return { status: "duplicate" };
  return { status: "applied", to: outcome.to };
}
