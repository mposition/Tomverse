import "server-only";

import {
  landingExperimentBundle,
} from "@/components/marketing/landingExperimentBundles";
import {
  MARKETING_AUTOMATION_KILL_SWITCH_ENV,
  MARKETING_EXPERIMENTS_KEY,
  marketingAutomationEnabledFromValue,
  resolveMarketingAutomationAccess,
} from "@/lib/marketingAutomationAccess";
import {
  MarketingExperimentRefusedError,
  MARKETING_EXPERIMENT_CONFIG_KEY,
  MARKETING_EXPERIMENT_COUNTER_PREFIX,
  MARKETING_EXPERIMENT_REFUSAL_STATUS,
  MARKETING_EXPERIMENT_REPORT_SOURCE_VERSION,
  MARKETING_EXPERIMENT_SPIKE,
  MARKETING_EXPERIMENT_USED_PREFIX,
  experimentConfigSchema,
  experimentStartBodySchema,
  experimentStopBodySchema,
  type ExperimentConfig,
  type ExperimentStartBody,
  type ExperimentStopBody,
} from "@/lib/marketingExperimentContract";
import {
  experimentCountsFromRows,
  parseExperimentConfig,
  type ExperimentCounts,
} from "@/lib/marketingExperimentCore";
import { EXPERIMENT_CONTROL_ARM } from "@/lib/marketingRoutes";
import { insertMarketingReport, type MarketingTransaction } from "@/lib/marketingStore";

/**
 * Starting and stopping a landing experiment (policy 6.1 "실험 활성화", 9.1).
 *
 * The activation row holds the pre-registration and the names of the bundle
 * and variant, never words. Both writers run inside the caller's
 * `runMarketingAdminMutation` transaction, after the human audit row and under
 * the audit chain lock, so a refusal rolls the audit row back with it.
 */

export {
  MarketingExperimentRefusedError,
  MARKETING_EXPERIMENT_REFUSAL_STATUS,
  experimentStartBodySchema,
  experimentStopBodySchema,
};
export type { ExperimentStartBody, ExperimentStopBody };

const unreadable = { ok: false } as const;

/**
 * The policy table's "실험 활성화" row, answered by the shared resolver rather
 * than re-spelled: switch on, no kill switch, the spike on record, and a
 * person with `marketing:write` and a recent sign-in -- which the route has
 * already established, so those two are passed as true.
 */
const experimentActivationDecision = (switchValue: string | undefined) =>
  resolveMarketingAutomationAccess({
    killSwitchValue: { ok: true, value: process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV] },
    adminAuthenticated: { ok: true, value: true },
    draftsEnabled: unreadable,
    llmGenerationBudgetAvailable: unreadable,
    generatorAuthenticated: unreadable,
    priceFallbackAlertReady: unreadable,
    adminHasMarketingWrite: { ok: true, value: true },
    adminStepUpRecent: { ok: true, value: true },
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
    experimentsEnabled: {
      ok: true,
      value: marketingAutomationEnabledFromValue(switchValue),
    },
    cacheCspSpikePassed: { ok: true, value: MARKETING_EXPERIMENT_SPIKE.passed },
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
  }).experimentActivate;

/**
 * The experiments switch, read and nothing else. Its own declaration on
 * purpose: `tests/appSettingWriters.test.mjs` counts a key as written when one
 * declaration both names it and writes some row, and this feature has no
 * writer for the switch (policy 9.1: turning experiments on is an operator step).
 */
const readExperimentsSwitchValue = async (tx: MarketingTransaction) =>
  (
    await tx.appSetting.findUnique({
      where: { key: MARKETING_EXPERIMENTS_KEY },
      select: { value: true },
    })
  )?.value;

const readConfigRow = async (tx: MarketingTransaction) => {
  const row = await tx.appSetting.findUnique({
    where: { key: MARKETING_EXPERIMENT_CONFIG_KEY },
    select: { value: true, updatedAt: true },
  });
  return {
    row,
    version: row ? row.updatedAt.toISOString() : null,
    config: parseExperimentConfig(row?.value),
  };
};

export async function startMarketingExperiment(
  tx: MarketingTransaction,
  body: ExperimentStartBody,
  now: Date = new Date(),
): Promise<{ config: ExperimentConfig; version: string | null }> {
  const decision = experimentActivationDecision(await readExperimentsSwitchValue(tx));
  if (!decision.enabled) {
    throw new MarketingExperimentRefusedError(
      "experiment_not_admitted",
      `Experiments cannot be started: ${decision.reasons.join(", ")}`,
    );
  }

  const bundle = landingExperimentBundle(body.bundleId);
  if (!bundle || !Object.hasOwn(bundle.variants, body.variantId)) {
    throw new MarketingExperimentRefusedError(
      "experiment_config_invalid",
      "That bundle or variant is not in this build",
    );
  }

  const candidate = {
    version: 1,
    experimentId: body.experimentId,
    bundleId: body.bundleId,
    variantId: body.variantId,
    locales: body.locales,
    variantRatio: body.variantRatioPercent / 100,
    startsAt: now.toISOString(),
    endsAt: new Date(now.getTime() + body.durationDays * 86_400_000).toISOString(),
    preregistration: body.preregistration,
    status: "running" as const,
    stoppedAt: null,
  };
  const parsed = experimentConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new MarketingExperimentRefusedError(
      "experiment_config_invalid",
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }

  const { row, version, config: existing } = await readConfigRow(tx);
  if (version !== body.expectedVersion) {
    throw new MarketingExperimentRefusedError(
      "experiment_conflict",
      "The experiment changed since the screen read it",
    );
  }
  if (existing && existing.status === "running") {
    throw new MarketingExperimentRefusedError(
      "experiment_running",
      "An experiment is already running; stop it first",
    );
  }
  const usedMarker = `${MARKETING_EXPERIMENT_USED_PREFIX}${body.experimentId}`;
  const counted = await tx.appSetting.count({
    where: {
      key: { startsWith: `${MARKETING_EXPERIMENT_COUNTER_PREFIX}${body.experimentId}.` },
    },
  });
  const marked = await tx.appSetting.findUnique({
    where: { key: usedMarker },
    select: { value: true },
  });
  if (counted > 0 || marked || existing?.experimentId === body.experimentId) {
    throw new MarketingExperimentRefusedError(
      "experiment_id_used",
      "That experiment id was used before; a new run needs a new id",
    );
  }

  // The permanent record that this id was used. A racing start with the same
  // id fails on the unique key and rolls back with its audit row.
  await tx.appSetting.create({
    data: { key: usedMarker, value: parsed.data.startsAt },
  });

  const value = JSON.stringify(parsed.data);
  if (!row) {
    // No row yet: the unique key is the condition, so a racing writer fails
    // on the constraint instead of overwriting.
    await tx.appSetting.create({ data: { key: MARKETING_EXPERIMENT_CONFIG_KEY, value } });
  } else {
    const moved = await tx.appSetting.updateMany({
      where: { key: MARKETING_EXPERIMENT_CONFIG_KEY, updatedAt: row.updatedAt },
      data: { value },
    });
    if (moved.count !== 1) {
      throw new MarketingExperimentRefusedError(
        "experiment_conflict",
        "The experiment changed since the screen read it",
      );
    }
  }
  const after = await readConfigRow(tx);
  return { config: parsed.data, version: after.version };
}

const readCounts = async (tx: MarketingTransaction, config: ExperimentConfig) => {
  const rows = await tx.appSetting.findMany({
    where: {
      key: { startsWith: `${MARKETING_EXPERIMENT_COUNTER_PREFIX}${config.experimentId}.` },
    },
    select: { key: true, value: true },
  });
  return experimentCountsFromRows(config, new Map(rows.map((row) => [row.key, row.value])));
};

/** The two `experiment_result` rows (one per arm) a stopped experiment leaves. */
export const experimentResultPayloads = (
  config: Pick<ExperimentConfig, "experimentId" | "variantId" | "startsAt">,
  counts: ExperimentCounts,
  endedAt: Date,
) => {
  const start = Date.parse(config.startsAt);
  const end = Math.max(endedAt.getTime(), start);
  const common = {
    experimentId: config.experimentId,
    startedAt: config.startsAt,
    endedAt: new Date(end).toISOString(),
  };
  return [
    {
      ...common,
      variantId: EXPERIMENT_CONTROL_ARM,
      exposures: counts.controlExposures,
      conversions: counts.controlConversions,
    },
    {
      ...common,
      variantId: config.variantId,
      exposures: counts.variantExposures,
      conversions: counts.variantConversions,
    },
  ];
};

export async function stopMarketingExperiment(
  tx: MarketingTransaction,
  body: ExperimentStopBody,
  now: Date = new Date(),
): Promise<{ counts: ExperimentCounts; reportIds: string[] }> {
  const { row, version, config } = await readConfigRow(tx);
  if (!row || version !== body.expectedVersion) {
    throw new MarketingExperimentRefusedError(
      "experiment_conflict",
      "The experiment changed since the screen read it",
    );
  }
  if (!config || config.status !== "running") {
    throw new MarketingExperimentRefusedError(
      "experiment_not_running",
      "There is no running experiment to stop",
    );
  }

  const stopped: ExperimentConfig = { ...config, status: "stopped", stoppedAt: now.toISOString() };
  const moved = await tx.appSetting.updateMany({
    where: { key: MARKETING_EXPERIMENT_CONFIG_KEY, updatedAt: row.updatedAt },
    data: { value: JSON.stringify(stopped) },
  });
  if (moved.count !== 1) {
    throw new MarketingExperimentRefusedError(
      "experiment_conflict",
      "The experiment changed since the screen read it",
    );
  }

  // The counters stop moving with the configuration: an assignment route that
  // read "running" a moment ago may still add a count, and that one count is
  // what the report documents as the figure at the time of the stop.
  const counts = await readCounts(tx, config);
  const reportIds: string[] = [];
  for (const payload of experimentResultPayloads(config, counts, now)) {
    const report = await insertMarketingReport(tx, {
      kind: "experiment_result",
      periodStart: new Date(payload.startedAt),
      periodEnd: new Date(payload.endedAt),
      payload,
      sourceVersion: MARKETING_EXPERIMENT_REPORT_SOURCE_VERSION,
    });
    reportIds.push(report.id);
  }
  return { counts, reportIds };
}
