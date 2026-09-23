/**
 * What the autonomous insert asks, inside the transaction that writes.
 *
 * `resolveMarketingAutomationAccess()` is pure: it takes thirty-five already
 * read inputs and returns decisions. This module is the other half -- the part
 * that reads them, and reads them where they will still be true when the row
 * is written. Nothing here decides anything the resolver does not; what it
 * decides is *when* each value is read and what holds it still.
 *
 * Why this module is not one of the admission manifest's roots. It carries
 * `admissionCodeDigest`, which is the digest of the manifest, and a file cannot
 * be described by a digest it contains -- adding its own bytes to the input
 * would change the value it holds, which would change its bytes. That is
 * arithmetic rather than a loophole, and it costs nothing here: the decision
 * this digest exists to describe lives in `lib/marketingAutomationAccess.ts`,
 * which is a root, and the refusal on mismatch lives in `lib/marketingStore.ts`,
 * which is a root. This module reports; the sealed code decides and refuses.
 *
 * What is not readable yet, and why it is written out rather than defaulted.
 * Five inputs belong to slices that do not exist: adapter and comment health
 * (S2d2's durable observation row), the recovery contract, the platform budget
 * and O4 eligibility. Each is an explicit unreadable below with the slice that
 * owns it named, so `autonomousPublish` is false today and the reason says
 * which input. A `true` default would have been a decision function that
 * answers about capabilities nothing has, which is exactly what
 * `lib/marketingAdminMutations.ts` declined to build; a silent `false` would
 * have been the same answer with nothing to change when the slice lands.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";

import manifest from "@/config/marketing-admission-code-manifest.json";
import { MARKETING_CONFIG_GENERATION_KEY } from "@/lib/appSettings";
import {
  MARKETING_AUTOMATION_KILL_SWITCH_ENV,
  MARKETING_AUTO_PUBLISH_KEY,
  MARKETING_DRAFTS_KEY,
  MARKETING_EXPERIMENTS_KEY,
  MARKETING_PRICE_FALLBACK_ALERT_READY,
  MARKETING_PUBLISH_KEY,
  marketingAutomationEnabledFromValue,
  resolveMarketingAutomationAccess,
  type MarketingAutomationAccessReason,
  type ReadResult,
} from "@/lib/marketingAutomationAccess";
import {
  MARKETING_NO_AUTONOMY_CHANNELS,
  type MarketingChannel,
  type MarketingChannelStatus,
} from "@/lib/marketingAutomationSchema";
import {
  insertAutonomousScheduledMarketingPost,
  runMarketingTransaction,
  marketingSerializationFailure,
  MARKETING_SERIALIZATION_RETRIES,
  type MarketingAutonomousAdmission,
  type MarketingTransaction,
} from "@/lib/marketingStore";

/** The digest of the code that decides an admission, as this build was built. */
export const MARKETING_ADMISSION_CODE_DIGEST: string = manifest.digest;

/**
 * How recently a health observation must have been made to count.
 *
 * Sixty seconds, and positive by construction. Health is the one input that is
 * about the outside world rather than about a row, so an old observation is not
 * a weaker answer -- it is an answer about a different moment. The rule is
 * written here as a pure function because the observation row itself is S2d2's;
 * the threshold and the comparison can be settled and tested now, and the
 * reader below can start returning something other than "unreadable" without
 * any of this changing.
 */
export const MARKETING_HEALTH_FRESHNESS_SECONDS = 60;

export type MarketingHealthObservation = {
  readonly channelId: string;
  readonly connectionGeneration: number;
  readonly healthy: boolean;
  readonly observedAt: Date;
};

/**
 * Whether an observation may be used as this channel's health, at this clock.
 *
 * Missing, stale, future-dated or about another channel or connection
 * generation is false -- each for the same reason, that it is not an
 * observation of the thing being asked about now. A future-dated row is not
 * "very fresh": it is a clock disagreement, and treating it as the freshest
 * answer would make a broken clock look like a healthy adapter.
 */
export const marketingHealthIsFresh = (
  observation: MarketingHealthObservation | null,
  now: Date,
  expect: { readonly channelId: string; readonly connectionGeneration: number },
  thresholdSeconds: number = MARKETING_HEALTH_FRESHNESS_SECONDS,
): boolean => {
  if (observation === null) return false;
  if (!(thresholdSeconds > 0)) return false;
  if (observation.channelId !== expect.channelId) return false;
  if (observation.connectionGeneration !== expect.connectionGeneration) {
    return false;
  }
  const age = now.getTime() - observation.observedAt.getTime();
  if (!Number.isFinite(age)) return false;
  if (age < 0) return false;
  if (age > thresholdSeconds * 1000) return false;
  return observation.healthy;
};

/** The strict shape of `marketingAutomation.configGeneration`. */
export const marketingConfigGeneration = (
  value: string | null | undefined,
): number | null => {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const generation = (parsed as { generation?: unknown }).generation;
  if (typeof generation !== "number") return null;
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  return generation;
};

const ADMISSION_SETTING_KEYS = [
  MARKETING_DRAFTS_KEY,
  MARKETING_PUBLISH_KEY,
  MARKETING_AUTO_PUBLISH_KEY,
  MARKETING_EXPERIMENTS_KEY,
  MARKETING_CONFIG_GENERATION_KEY,
] as const;

/**
 * The switches, held for the rest of the transaction.
 *
 * `FOR SHARE` rather than a plain read: an operator turning autonomous
 * publishing off in the middle of this transaction would otherwise commit
 * between the read and the insert, and the post would be written under a switch
 * that was on when it was looked at and off when it mattered. The share lock
 * lets other readers through and makes that operator's write wait for this
 * transaction to finish, at which point its own generation increment makes
 * every decision sealed under the old generation refuse at its own insert.
 *
 * Raw SQL because Prisma's query API has no row-lock clause. The keys are bound
 * parameters, not interpolated.
 */
export const readMarketingAdmissionSettings = async (
  database: MarketingTransaction,
): Promise<ReadonlyMap<string, string>> => {
  const rows = await database.$queryRaw<Array<{ key: string; value: string }>>(
    Prisma.sql`
      SELECT "key", "value" FROM "AppSetting"
      WHERE "key" IN (${Prisma.join([...ADMISSION_SETTING_KEYS])})
      FOR SHARE
    `,
  );
  return new Map(rows.map((row) => [row.key, row.value]));
};

const unreadable: ReadResult<never> = { ok: false };

export type AutonomousAdmissionSubject = {
  readonly channelId: string;
  readonly channel: MarketingChannel;
  readonly connectionGeneration: number;
  /** The status of the row this transaction has already locked. */
  readonly status: MarketingChannelStatus;
};

export type AutonomousAdmissionResolution = MarketingAutonomousAdmission & {
  readonly reasons: readonly MarketingAutomationAccessReason[];
};

/**
 * Resolve `autonomousPublish` against rows this transaction holds.
 *
 * The channel comes from the caller because the insert has already locked it
 * `FOR UPDATE`; reading it again here would be a second read of a row this
 * transaction owns, and the two answers could only ever differ by a bug.
 */
export const resolveAutonomousAdmission = async (
  database: MarketingTransaction,
  subject: AutonomousAdmissionSubject,
  health: MarketingHealthObservation | null = null,
  now: Date = new Date(),
): Promise<AutonomousAdmissionResolution> => {
  const settings = await readMarketingAdmissionSettings(database);
  const generation = marketingConfigGeneration(
    settings.get(MARKETING_CONFIG_GENERATION_KEY),
  );

  const healthy = marketingHealthIsFresh(health, now, {
    channelId: subject.channelId,
    connectionGeneration: subject.connectionGeneration,
  });

  const decisions = resolveMarketingAutomationAccess({
    killSwitchValue: {
      ok: true,
      value: process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV],
    },
    adminAuthenticated: { ok: true, value: false },
    draftsEnabled: {
      ok: true,
      value: marketingAutomationEnabledFromValue(settings.get(MARKETING_DRAFTS_KEY)),
    },
    // S3 owns generation and its budget; nothing here drafts.
    llmGenerationBudgetAvailable: unreadable,
    generatorAuthenticated: unreadable,
    priceFallbackAlertReady: {
      ok: true,
      value: MARKETING_PRICE_FALLBACK_ALERT_READY,
    },
    // No person is present. The two admin inputs are false rather than
    // unreadable: it is not that we could not find out, it is that there is
    // nobody, and that is the whole point of this path.
    adminHasMarketingWrite: { ok: true, value: false },
    adminStepUpRecent: { ok: true, value: false },
    publishEnabled: {
      ok: true,
      value: marketingAutomationEnabledFromValue(settings.get(MARKETING_PUBLISH_KEY)),
    },
    channelMode: { ok: true, value: subject.status },
    adapterHealthy: health === null ? unreadable : { ok: true, value: healthy },
    // S2d2 writes the recovery mapping and the platform budget.
    recoveryContractAvailable: unreadable,
    platformBudgetAvailable: unreadable,
    autoPublishEnabled: {
      ok: true,
      value: marketingAutomationEnabledFromValue(
        settings.get(MARKETING_AUTO_PUBLISH_KEY),
      ),
    },
    // S4 owns the comment monitor and O4.
    commentsMonitorHealthy: unreadable,
    publicationCancellable: unreadable,
    o4Eligible: unreadable,
    o15Channel: {
      ok: true,
      value: (MARKETING_NO_AUTONOMY_CHANNELS as readonly string[]).includes(
        subject.channel,
      ),
    },
    o3Satisfied: unreadable,
    experimentsEnabled: {
      ok: true,
      value: marketingAutomationEnabledFromValue(
        settings.get(MARKETING_EXPERIMENTS_KEY),
      ),
    },
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
    configGeneration:
      generation === null ? unreadable : { ok: true, value: generation },
  });

  const autonomous = decisions.autonomousPublish;

  // Zero when it could not be read, and zero is a number no writer can have
  // stored: the setting starts at one and only ever increments. So a caller
  // holding any real generation disagrees with it, and the store refuses --
  // but the resolver has already said no by then, naming the input, which is
  // the answer that tells an operator what to look at.
  return {
    autonomousPublish: autonomous.enabled,
    admissionCodeDigest: MARKETING_ADMISSION_CODE_DIGEST,
    configGeneration: generation ?? 0,
    deploymentId: String(process.env.RAILWAY_DEPLOYMENT_ID ?? ""),
    reasons: autonomous.reasons,
  };
};

type AutonomousInsertInput = Parameters<
  typeof insertAutonomousScheduledMarketingPost
>[1];

/**
 * The whole admission and the insert, in one `SERIALIZABLE` transaction.
 *
 * `SERIALIZABLE` because of one question: whether a claim this account has
 * never published is still one it has never published. Nothing this transaction
 * locks can answer that -- a concurrent publish of a different post makes it
 * false without touching the channel or the template -- so the protection has
 * to come from the isolation level, and the prior-use read inside the store is
 * what gives PostgreSQL something to detect the conflict against.
 *
 * Retries are bounded and happen here, which is the only place they may: this
 * function has made no external call, so running it again repeats nothing but
 * database work. Once a vendor call exists (S2d2) it is outside this
 * transaction and a retry after it would publish twice.
 */
export const scheduleAutonomousMarketingPost = async (
  client: PrismaClient,
  input: Omit<AutonomousInsertInput, "resolveAdmission"> & {
    readonly subject: AutonomousAdmissionSubject;
    readonly health?: MarketingHealthObservation | null;
  },
): Promise<{ id: string }> => {
  const subject = input.subject;
  const health = input.health ?? null;

  let lastSerializationFailure: unknown = null;
  for (let attempt = 0; attempt <= MARKETING_SERIALIZATION_RETRIES; attempt += 1) {
    try {
      return await runMarketingTransaction(
        client,
        (tx) =>
          insertAutonomousScheduledMarketingPost(tx, {
            ...input,
            resolveAdmission: (database) =>
              resolveAutonomousAdmission(database, subject, health),
          }),
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (!marketingSerializationFailure(error)) throw error;
      lastSerializationFailure = error;
    }
  }
  throw lastSerializationFailure;
};
