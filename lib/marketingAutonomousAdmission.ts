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
import { MARKETING_NO_AUTONOMY_CHANNELS } from "@/lib/marketingAutomationSchema";
import {
  insertAutonomousScheduledMarketingPost,
  marketingHealthIsFresh,
  marketingSerializationFailure,
  runMarketingTransaction,
  MARKETING_SERIALIZATION_RETRIES,
  type MarketingAdmissionChannel,
  type MarketingAutonomousAdmission,
  type MarketingHealthObservation,
  type MarketingTransaction,
} from "@/lib/marketingStore";

/** The digest of the code that decides an admission, as this build was built. */
export const MARKETING_ADMISSION_CODE_DIGEST: string = manifest.digest;

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

/**
 * The two answers this module decides that the shared resolver does not.
 *
 * They are named here rather than added to `MarketingAutomationAccessReason`
 * because `lib/marketingAutomationAccess.ts` is inside the Prompt Refiner's
 * sealed runtime source closure: adding lines to it moves the reviewed
 * position snapshot, which a person repins. Neither of these is a question the
 * shared resolver asks anyway -- both are about the interval between a Guard
 * sealing a decision and this transaction writing it, and a person in the
 * console has no such interval.
 */
export type MarketingAutonomousAdmissionReason =
  | "config_generation_unreadable"
  | "deployment_unknown";

export type AutonomousAdmissionResolution = MarketingAutonomousAdmission & {
  readonly reasons: readonly (
    | MarketingAutomationAccessReason
    | MarketingAutonomousAdmissionReason
  )[];
};

/**
 * Resolve `autonomousPublish` against rows this transaction holds.
 *
 * The channel is the row the insert locked `FOR UPDATE` and passed in, not a
 * copy the caller assembled and not a second read: a second read of a row this
 * transaction owns could only differ by a bug, and a caller's copy could differ
 * by being older than the lock.
 */
export const resolveAutonomousAdmission = async (
  database: MarketingTransaction,
  subject: MarketingAdmissionChannel,
  health: MarketingHealthObservation | null = null,
  now: Date = new Date(),
): Promise<AutonomousAdmissionResolution> => {
  const settings = await readMarketingAdmissionSettings(database);
  const generation = marketingConfigGeneration(
    settings.get(MARKETING_CONFIG_GENERATION_KEY),
  );

  const healthy = marketingHealthIsFresh(health, now, {
    channelId: subject.id,
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
  });

  const autonomous = decisions.autonomousPublish;
  const reasons: (
    | MarketingAutomationAccessReason
    | MarketingAutonomousAdmissionReason
  )[] = [...autonomous.reasons];

  // Both of these are the same question asked twice, and both have to be
  // asked. The store refuses a generation or a deployment that disagrees with
  // what the decision was sealed under; these refuse the case where there is
  // nothing to disagree with. Zero and the empty string are not values any
  // writer stores -- the setting starts at one and Railway always names its
  // deployment -- so the store's comparison would refuse them too, but it
  // would refuse them as a mismatch, and "mismatch" sends an operator looking
  // for a change that never happened.
  if (generation === null) reasons.push("config_generation_unreadable");
  const deploymentId = String(process.env.RAILWAY_DEPLOYMENT_ID ?? "").trim();
  if (deploymentId === "") reasons.push("deployment_unknown");

  return {
    autonomousPublish: reasons.length === 0,
    admissionCodeDigest: MARKETING_ADMISSION_CODE_DIGEST,
    configGeneration: generation ?? 0,
    deploymentId,
    reasons,
  };
};

type AutonomousInsertInput = Parameters<
  typeof insertAutonomousScheduledMarketingPost
>[1];

/**
 * The whole admission and the insert, in one `SERIALIZABLE` transaction.
 *
 * `SERIALIZABLE` because of one question: whether a claim this account has
 * published is still one it has published. An autonomous decision names only
 * claims and assets used before -- `guardDraft()` refuses autonomy otherwise
 * -- so the answer that can change is that one going away: a concurrent
 * unpublish, delete or retention purge of the last row carrying the claim,
 * none of which touches the channel or the template this transaction holds.
 * The prior-use read inside the store is what gives PostgreSQL something to
 * detect that conflict against.
 *
 * Retries are bounded and happen here, which is the only place they may: this
 * function has made no external call, so running it again repeats nothing but
 * database work. Once a vendor call exists (S2d2) it is outside this
 * transaction and a retry after it would publish twice.
 */
export const scheduleAutonomousMarketingPost = async (
  client: PrismaClient,
  input: Omit<AutonomousInsertInput, "resolveAdmission"> & {
    readonly health?: MarketingHealthObservation | null;
  },
): Promise<{ id: string }> => {
  const health = input.health ?? null;

  let lastSerializationFailure: unknown = null;
  for (let attempt = 0; attempt <= MARKETING_SERIALIZATION_RETRIES; attempt += 1) {
    try {
      return await runMarketingTransaction(
        client,
        (tx) =>
          insertAutonomousScheduledMarketingPost(tx, {
            ...input,
            resolveAdmission: (database, channel) =>
              resolveAutonomousAdmission(database, channel, health),
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
