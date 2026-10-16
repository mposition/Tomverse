/**
 * The generator's drafts, judged and stored in one transaction (S3 plan, S3a).
 *
 * One named writer: the audit chain lock first (every switch writer takes it,
 * so the switch cannot change between the decision and the write it allows),
 * then the `draftIntake` decision from inputs read in this transaction, the
 * facts, the Guard, the post, its `guard_result` history and the audit row.
 * The generator's words are judged here, never trusted: nothing in a submission
 * can state a verdict.
 *
 * In this build the decision refuses every submission -- the LLM budget is S3c
 * and the price-fallback alert is S3d -- so nothing is written. The path exists
 * so that turning those on changes inputs, not code.
 *
 * Not in `lib/marketingStore.ts` on purpose: it writes through the store's own
 * writers (`createMarketingPost`, `appendMarketingPostHistory`) and adds no
 * import there, so the webhook pipeline's slice of the store is unchanged.
 */

import "server-only";

import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import {
  MARKETING_DRAFTS_KEY,
  MARKETING_PRICE_FALLBACK_ALERT_READY,
  resolveMarketingAutomationAccess,
  type ReadResult,
} from "@/lib/marketingAutomationAccess";
import type {
  MarketingChannel as MarketingChannelName,
  MarketingFactSnapshot,
} from "@/lib/marketingAutomationSchema";
import {
  marketingDraftProvenanceDigest,
  marketingGeneratorDraftIntakeDigest,
  marketingGeneratorDraftLogicalKey,
  type MarketingGeneratorDraft,
} from "@/lib/marketingDraftIntakeCore";
import { resolveMarketingFacts } from "@/lib/marketingFactResolution";
import { guardDraft } from "@/lib/marketingGuardCore";
import { resolveMarketingGuardContext } from "@/lib/marketingGuardContext";
import {
  appendMarketingPostHistory,
  createMarketingPost,
  marketingEnvelopeDigest,
  type MarketingTransaction,
} from "@/lib/marketingStore";

/** S3's audit actions; the S2 lists stay as they were reviewed. */
export const MARKETING_S3_ACTIONS = {
  intakeRejected: "marketing_post.intake_rejected",
  intakeQueued: "marketing_post.intake_queued",
} as const;

/** The renderer that turned a generator draft into an envelope. */
export const MARKETING_GENERATOR_RENDERER_VERSION = "generator-intake-v1";

/**
 * The snapshot of stored rows a draft rested on. Empty, because S3a admits
 * only drafts that rest on none: no claim, no asset. A draft with either needs
 * the rows its facts were read from, and recording them is S3a2's -- until
 * then such a draft is refused rather than stored with a snapshot that says
 * nothing was read.
 */
const EMPTY_FACT_SNAPSHOT: MarketingFactSnapshot = {
  priceRows: [],
  catalogue: null,
  modelRegistryRows: [],
  evidenceDigests: [],
};

/**
 * The most one intake transaction may take, measured by statement count in
 * the tests; a draft with less time than this before the service's deadline
 * is not started.
 */
export const MARKETING_DRAFT_INTAKE_TRANSACTION_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 5_000;
const MIN_SERVER_VERSION_NUM = 170_000;

export type MarketingDraftIntakeOutcome =
  | { readonly status: "refused"; readonly reasons: readonly string[] }
  | { readonly status: "conflict"; readonly postId: string }
  | {
      readonly status: "queued" | "rejected";
      readonly postId: string;
      readonly existing: boolean;
    };

const unreadable: ReadResult<never> = { ok: false };

/**
 * Bound this transaction by the service's deadline, in the database.
 *
 * PostgreSQL 17 arms `transaction_timeout` from the moment it is set inside the
 * transaction when no timer is already running. It is set to the longest an
 * intake transaction takes, and only when at least that much time is left
 * before the deadline at that same instant, so a transaction cannot commit
 * after the deadline: the late success is rolled back by the server, not
 * noticed by this process. Left unbounded: the stretch
 * from BEGIN to this statement and COMMIT's durable phase, which is the
 * agent foundation's timeout rule. Statement and idle bounds are shorter, so
 * both stay armed.
 */
async function boundByDeadline(
  tx: MarketingTransaction,
  deadlineAt: Date,
): Promise<{ readonly now: Date } | { readonly refused: string }> {
  // `missing_ok`, so a server without the setting answers NULL rather than
  // failing the statement before the version can be checked.
  const rows = await tx.$queryRaw<Array<{ num: number; armed: string | null }>>(Prisma.sql`
    SELECT current_setting('server_version_num')::int AS "num",
           current_setting('transaction_timeout', true) AS "armed"
  `);
  const row = rows[0];
  if (!row || !(Number(row.num) >= MIN_SERVER_VERSION_NUM)) {
    return { refused: "intake_server_too_old" };
  }
  const armed = String(row.armed ?? "").trim();
  if (armed !== "0" && armed !== "0ms") return { refused: "intake_timeout_already_armed" };

  // **The time left and the timer are one statement.** Read in one round trip
  // and set in another, a pause between them -- the network, this process --
  // left the timer starting later than the reading it was sized from, and the
  // transaction able to outlive the deadline. Here the server measures the
  // time left at the instant it arms the timer, and arms it only when the
  // whole transaction fits.
  const armedRows = await tx.$queryRaw<Array<{ now: Date; set: string | null }>>(Prisma.sql`
    WITH clock AS (
      SELECT clock_timestamp() AS at,
             EXTRACT(EPOCH FROM (${deadlineAt}::timestamptz - clock_timestamp())) * 1000 AS left_ms
    )
    SELECT (clock.at AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now",
           CASE WHEN clock.left_ms >= ${MARKETING_DRAFT_INTAKE_TRANSACTION_MS}
                THEN set_config('transaction_timeout', ${String(MARKETING_DRAFT_INTAKE_TRANSACTION_MS)}, true)
                ELSE NULL END AS "set"
    FROM clock
  `);
  const armedRow = armedRows[0];
  if (!armedRow || armedRow.set === null) return { refused: "intake_deadline_too_close" };

  await tx.$queryRaw(
    Prisma.sql`SELECT set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`,
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT set_config('idle_in_transaction_session_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`,
  );
  return { now: armedRow.now };
}

/**
 * The two inputs S3a cannot read yet. Their defaults are the build's answer --
 * unknown budget, alert not ready -- and the route passes nothing, so only a
 * test can supply another. S3c and S3d replace the defaults with readers of the
 * transaction.
 */
export type MarketingDraftIntakeReaders = {
  readonly llmGenerationBudgetAvailable: (tx: MarketingTransaction) => Promise<ReadResult<boolean>>;
  readonly priceFallbackAlertReady: (tx: MarketingTransaction) => Promise<ReadResult<boolean>>;
};

const BUILD_READERS: MarketingDraftIntakeReaders = {
  llmGenerationBudgetAvailable: async () => unreadable,
  priceFallbackAlertReady: async () => ({ ok: true, value: MARKETING_PRICE_FALLBACK_ALERT_READY }),
};

/** `draftIntake`, from inputs read inside the caller's transaction. */
async function draftIntakeDecision(
  tx: MarketingTransaction,
  killSwitchValue: string | undefined,
  readers: MarketingDraftIntakeReaders,
) {
  const drafts = await tx.appSetting.findUnique({
    where: { key: MARKETING_DRAFTS_KEY },
    select: { value: true },
  });
  return resolveMarketingAutomationAccess({
    killSwitchValue: { ok: true, value: killSwitchValue },
    adminAuthenticated: unreadable,
    draftsEnabled: { ok: true, value: drafts?.value === "true" },
    // S3c owns the generation budget; until it exists the budget is unknown,
    // and unknown refuses.
    llmGenerationBudgetAvailable: await readers.llmGenerationBudgetAvailable(tx),
    // The route authenticated the generator before this was called.
    generatorAuthenticated: { ok: true, value: true },
    priceFallbackAlertReady: await readers.priceFallbackAlertReady(tx),
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
    webhookSignatureVerified: unreadable,
    webhookApplyScopeValue: unreadable,
    webhookVerificationRecordText: unreadable,
    webhookVerificationSignatureText: unreadable,
    webhookSignatureAuditEvidence: unreadable,
    webhookConfigSnapshot: unreadable,
    webhookEvent: unreadable,
    webhookProductionConfig: unreadable,
  }).draftIntake;
}

export async function intakeMarketingGeneratorDraft(
  tx: MarketingTransaction,
  input: {
    readonly generatorRunId: string;
    readonly submissionId: string;
    readonly provenance: string;
    readonly deadlineAt: Date;
    readonly draft: MarketingGeneratorDraft;
    readonly killSwitchValue: string | undefined;
  },
  readers: MarketingDraftIntakeReaders = BUILD_READERS,
): Promise<MarketingDraftIntakeOutcome> {
  const bounded = await boundByDeadline(tx, input.deadlineAt);
  if ("refused" in bounded) return { status: "refused", reasons: [bounded.refused] };
  const now = bounded.now;
  // First, before any read the decision rests on.
  await takeAuditChainLock(tx);

  const decision = await draftIntakeDecision(tx, input.killSwitchValue, readers);
  if (!decision.enabled) return { status: "refused", reasons: decision.reasons };

  const draft = input.draft;
  if (draft.claimIds.length > 0 || draft.assets.length > 0) {
    return { status: "refused", reasons: ["intake_facts_snapshot_not_available"] };
  }

  // Derived, so the generator cannot name another draft's key. Under the chain
  // lock a second intake of the same key waits for this one, so this read sees
  // the row the first one made; the unique index is the second lock.
  const logicalKey = marketingGeneratorDraftLogicalKey({
    generatorRunId: input.generatorRunId,
    submissionId: input.submissionId,
    logicalDraftId: draft.logicalDraftId,
  });
  const intakeDigest = marketingGeneratorDraftIntakeDigest({
    generatorRunId: input.generatorRunId,
    submissionId: input.submissionId,
    draft,
  });
  const existing = await tx.marketingPost.findUnique({
    where: { logicalKey },
    select: { id: true, status: true },
  });
  if (existing) {
    // The same draft only if its intake recorded the same words.
    const intake = await tx.adminAuditLog.findFirst({
      where: {
        targetType: "MarketingPost",
        targetId: existing.id,
        action: { in: [MARKETING_S3_ACTIONS.intakeQueued, MARKETING_S3_ACTIONS.intakeRejected] },
      },
      select: { metadata: true },
    });
    const recorded = (intake?.metadata as { intakeDigest?: unknown } | null)?.intakeDigest;
    if (recorded !== intakeDigest) return { status: "conflict", postId: existing.id };
    return {
      status: existing.status === "guard_rejected" ? "rejected" : "queued",
      postId: existing.id,
      existing: true,
    };
  }

  const channel = await tx.marketingChannel.findUnique({
    where: { id: draft.channelId },
    select: { accountSlug: true, channel: true },
  });
  if (!channel) return { status: "refused", reasons: ["intake_channel_unknown"] };

  const channelName = channel.channel as MarketingChannelName;
  const envelope = {
    channel: channelName,
    accountSlug: channel.accountSlug,
    locale: draft.locale,
    renderedText: draft.renderedText,
    claimIds: [] as string[],
    assets: [] as { assetId: string; altKey: string }[],
    finalUrl: null,
    scheduledAt: null,
    disclosureFlags: [...draft.disclosureFlags],
  };
  const snapshotDigest = marketingEnvelopeFactSnapshotDigest(EMPTY_FACT_SNAPSHOT);
  const facts = await resolveMarketingFacts(tx, {
    claimIds: [],
    assetIds: [],
    channelId: draft.channelId,
    channel: channelName,
    locale: draft.locale,
    factSnapshotDigest: snapshotDigest,
  });
  const verdict = guardDraft({
    draft: {
      renderedText: draft.renderedText,
      locale: draft.locale,
      channel: channelName,
      channelId: draft.channelId,
      claimIds: [],
      assetIds: [],
    },
    facts,
    // New copy: S3 binds no template, so the Guard has none to offer.
    templates: [],
    context: resolveMarketingGuardContext(),
  });
  if (verdict.verdict === "autonomous_eligible") {
    // Not reachable without a template; refused rather than written if it is.
    return { status: "refused", reasons: ["intake_unexpected_autonomous"] };
  }

  const created = await createMarketingPost(tx, {
    channelId: draft.channelId,
    locale: draft.locale,
    kind: draft.kind,
    logicalKey,
    envelope,
    envelopeDigest: marketingEnvelopeDigest(envelope),
    rendererVersion: MARKETING_GENERATOR_RENDERER_VERSION,
    templateId: null,
    templateDigest: null,
    claimIds: [],
    assetIds: [],
    claimRegistryVersion: facts.claimRegistryVersion,
    assetRegistryVersion: facts.assetRegistryVersion,
    factSnapshot: EMPTY_FACT_SNAPSHOT,
    decision: verdict,
    draftedAt: now,
  });

  const rejected = verdict.verdict === "reject";
  const appended = await appendMarketingPostHistory(tx, {
    id: created.id,
    expectedVersion: created.historyVersion,
    entry: {
      at: now.toISOString(),
      type: "guard_result",
      decision: verdict.verdict,
      codes: "codes" in verdict ? [...verdict.codes] : [],
      ruleIds: [...verdict.ruleIds],
    },
    // Approval opens the window; the queue only receives the draft.
    patch: rejected ? undefined : { status: "pending_approval" },
  });
  if (!appended.appended) {
    throw new Error("The intake's own post changed inside its transaction");
  }

  // The last statement before the audit row: past the deadline by the
  // database's clock, the whole intake rolls back. The timer already makes the
  // transaction unable to run past it; this makes the *success record* refuse
  // too. What stays unbounded is COMMIT's durable phase -- if its answer is
  // lost, the generator learns the outcome by resubmitting the same key.
  const late = await tx.$queryRaw<Array<{ late: boolean }>>(Prisma.sql`
    SELECT clock_timestamp() > ${input.deadlineAt}::timestamptz AS "late"
  `);
  if (late[0]?.late !== false) {
    throw new Error("The intake reached its success record after the service's deadline");
  }

  await writeSystemAuditLog({
    tx,
    systemActor: "marketing-guard",
    action: rejected ? MARKETING_S3_ACTIONS.intakeRejected : MARKETING_S3_ACTIONS.intakeQueued,
    targetType: "MarketingPost",
    targetId: created.id,
    summary: rejected
      ? "The Guard rejected a generated marketing draft."
      : "Queued a generated marketing draft for a person's approval.",
    metadata: {
      generatorRunId: input.generatorRunId,
      submissionId: input.submissionId,
      logicalDraftId: draft.logicalDraftId,
      intakeDigest,
      provenanceDigest: marketingDraftProvenanceDigest(input.provenance),
      verdict: verdict.verdict,
      codes: "codes" in verdict ? [...verdict.codes] : [],
      ruleIds: [...verdict.ruleIds],
    },
  });

  return { status: rejected ? "rejected" : "queued", postId: created.id, existing: false };
}

/** The store's own digest of a fact snapshot: sorted keys, SHA-256. */
function marketingEnvelopeFactSnapshotDigest(snapshot: MarketingFactSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(snapshot)), "utf8")
    .digest("hex");
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, inner]) => [key, canonical(inner)]),
    );
  }
  return value;
};
