/**
 * The two staging webhook settings, and the latch the receiver trips (S2 plan,
 * S2e).
 *
 * - `marketingAutomation.webhookShadowEnabled` -- whether the staging receiver
 *   records shadow reports. A person turns it on or off (`shadow_changed`).
 * - `marketingAutomation.webhookFaultArm` -- one deliberate failure, armed by a
 *   person for exactly one event (`fault_arm_set`) and consumed by the receiver
 *   (`fault_arm_consumed`), which then answers 5xx once so the provider's retry
 *   can be watched.
 *
 * **Staging, exactly, or nothing.** Every function here refuses unless
 * `marketingWebhookIsStaging()` says so, before reading anything. Production and
 * an unlabelled build cannot arm a fault, cannot consume one and cannot turn the
 * shadow on; the deliberate failure is a branch they never reach.
 *
 * `AppSetting` has no version column, so compare-and-set is on the stored value
 * itself. For the arm that is enough: its value carries a generation that every
 * write moves, so "the value I read" names one write and no other.
 */

import "server-only";

import {
  MARKETING_WEBHOOK_SHADOW_KEY,
  marketingAutomationEnabledFromValue,
} from "@/lib/marketingAutomationAccess";
import {
  MARKETING_WEBHOOK_FAULT_ARM_KEY,
  MARKETING_WEBHOOK_FAULT_ARM_MAX_MS,
  MarketingWebhookSettingRefusedError,
  marketingWebhookFaultArmMatches,
  marketingWebhookIsStaging,
  parseMarketingWebhookFaultArm,
  serializeMarketingWebhookFaultArm,
  type MarketingWebhookFaultArm,
} from "@/lib/marketingWebhookCore";
import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { MARKETING_S2E_ACTIONS, type MarketingTransaction } from "@/lib/marketingStore";
import { Prisma } from "@prisma/client";

export { MarketingWebhookSettingRefusedError };

const requireStaging = () => {
  if (!marketingWebhookIsStaging()) {
    throw new MarketingWebhookSettingRefusedError(
      "environment_not_staging",
      "Webhook shadow and fault settings exist in staging only",
    );
  }
};

/**
 * Create a row that did not exist, turning a racing creator's unique violation
 * into the conflict it is. Two writers that both read "absent" both try to
 * create; the key refuses the second, and that is the same fact as a changed
 * value -- somebody else wrote first.
 */
const createOrConflict = async (
  tx: MarketingTransaction,
  key: string,
  value: string,
  conflictCode: string,
) => {
  try {
    await tx.appSetting.create({ data: { key, value } });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "P2002") {
      throw new MarketingWebhookSettingRefusedError(
        conflictCode,
        "The setting changed since the screen read it",
      );
    }
    throw error;
  }
};

const databaseNow = async (tx: MarketingTransaction): Promise<Date> => {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `);
  const now = rows[0]?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new MarketingWebhookSettingRefusedError(
      "database_clock_unavailable",
      "The database clock did not return a timestamp",
    );
  }
  return now;
};

// ---------------------------------------------------------------------------
// The shadow switch
// ---------------------------------------------------------------------------

/**
 * Turn the staging shadow on or off, against the value the screen read.
 *
 * Strict boolean compare-and-set: the stored value must be what the caller says
 * it read (absent reads as off), and a change to the same value is refused as a
 * no-op rather than written as a second identical row in the audit.
 */
export async function writeMarketingWebhookShadowSwitch(
  tx: MarketingTransaction,
  input: { readonly enabled: boolean; readonly expectedEnabled: boolean },
): Promise<{ readonly enabled: boolean }> {
  requireStaging();
  const enabled = input.enabled === true;
  const expectedEnabled = input.expectedEnabled === true;
  const row = await tx.appSetting.findUnique({
    where: { key: MARKETING_WEBHOOK_SHADOW_KEY },
    select: { value: true },
  });
  const stored = row?.value;
  if (stored !== undefined && stored !== "true" && stored !== "false") {
    throw new MarketingWebhookSettingRefusedError(
      "shadow_switch_unreadable",
      "The stored shadow switch is not a boolean",
    );
  }
  const current = marketingAutomationEnabledFromValue(stored);
  if (current !== expectedEnabled) {
    throw new MarketingWebhookSettingRefusedError(
      "shadow_switch_conflict",
      "The shadow switch changed since the screen read it",
    );
  }
  if (current === enabled) {
    throw new MarketingWebhookSettingRefusedError(
      "shadow_switch_noop",
      "The shadow switch is already in that state",
    );
  }
  const value = enabled ? "true" : "false";
  if (stored === undefined) {
    // No row: the unique key is the condition, so a racing writer fails on it.
    await createOrConflict(tx, MARKETING_WEBHOOK_SHADOW_KEY, value, "shadow_switch_conflict");
  } else {
    const moved = await tx.appSetting.updateMany({
      where: { key: MARKETING_WEBHOOK_SHADOW_KEY, value: stored },
      data: { value },
    });
    if (moved.count !== 1) {
      throw new MarketingWebhookSettingRefusedError(
        "shadow_switch_conflict",
        "The shadow switch changed since the screen read it",
      );
    }
  }
  return { enabled };
}

// ---------------------------------------------------------------------------
// The fault arm
// ---------------------------------------------------------------------------

const readArm = async (tx: MarketingTransaction) => {
  const row = await tx.appSetting.findUnique({
    where: { key: MARKETING_WEBHOOK_FAULT_ARM_KEY },
    select: { value: true },
  });
  return { stored: row?.value, arm: parseMarketingWebhookFaultArm(row?.value) };
};

/**
 * Arm one deliberate failure for exactly one event, against the generation the
 * screen read (0 when nothing has ever been armed).
 *
 * The new arm's generation is the old one plus one, its times come from the
 * database clock, and it expires within a day at most: a test that is not run
 * should not leave a latch behind. A stored value that is not exactly an arm is
 * refused rather than overwritten -- it is a row something else wrote.
 */
export async function setMarketingWebhookFaultArm(
  tx: MarketingTransaction,
  input: {
    readonly eventIdDigest: string;
    readonly expectedGeneration: number;
    readonly ttlMs: number;
  },
): Promise<MarketingWebhookFaultArm> {
  requireStaging();
  const eventIdDigest = String(input.eventIdDigest);
  const expectedGeneration = Number(input.expectedGeneration);
  const ttlMs = Number(input.ttlMs);
  if (!/^[0-9a-f]{64}$/.test(eventIdDigest)) {
    throw new MarketingWebhookSettingRefusedError(
      "fault_arm_digest_invalid",
      "An arm names one event by its lowercase SHA-256 digest",
    );
  }
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MARKETING_WEBHOOK_FAULT_ARM_MAX_MS) {
    throw new MarketingWebhookSettingRefusedError(
      "fault_arm_ttl_invalid",
      "An arm expires after a positive time of at most a day",
    );
  }
  const { stored, arm } = await readArm(tx);
  if (stored !== undefined && arm === null) {
    throw new MarketingWebhookSettingRefusedError(
      "fault_arm_unreadable",
      "The stored fault arm is not one this module wrote",
    );
  }
  const currentGeneration = arm?.generation ?? 0;
  if (currentGeneration !== expectedGeneration) {
    throw new MarketingWebhookSettingRefusedError(
      "fault_arm_conflict",
      "The fault arm changed since the screen read it",
    );
  }
  const now = await databaseNow(tx);
  const next: MarketingWebhookFaultArm = {
    eventIdDigest,
    state: "armed",
    generation: currentGeneration + 1,
    armedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
  const value = serializeMarketingWebhookFaultArm(next);
  if (stored === undefined) {
    await createOrConflict(tx, MARKETING_WEBHOOK_FAULT_ARM_KEY, value, "fault_arm_conflict");
  } else {
    const moved = await tx.appSetting.updateMany({
      where: { key: MARKETING_WEBHOOK_FAULT_ARM_KEY, value: stored },
      data: { value },
    });
    if (moved.count !== 1) {
      throw new MarketingWebhookSettingRefusedError(
        "fault_arm_conflict",
        "The fault arm changed since the screen read it",
      );
    }
  }
  return next;
}

/**
 * The receiver's half: consume the arm for this event, if it is armed for it.
 *
 * Its own transaction, committed before the receiver answers 5xx -- so the
 * latch is spent whether or not the failure response arrives, and the retry
 * finds it consumed and proceeds. The write is conditional on the exact armed
 * value read, so of two deliveries racing for one arm exactly one moves it and
 * the other sees zero rows and goes on normally.
 *
 * Returns whether this call consumed it. Not armed for this event, expired, or
 * lost the race: false, and nothing is written.
 */
export async function consumeMarketingWebhookFaultArm(
  tx: MarketingTransaction,
  input: { readonly eventIdDigest: string },
): Promise<{ readonly consumed: boolean }> {
  requireStaging();
  const eventIdDigest = String(input.eventIdDigest);
  // **The audit chain's lock before the row's.** The arm route runs inside the
  // admin mutation runner, which takes the chain lock first and then writes this
  // row; taking the row first here and the chain lock second -- as the audit
  // append below does -- is the opposite order, and an arm and a delivery
  // crossing would each wait on the other's lock. Same order, no cycle.
  await takeAuditChainLock(tx);
  const { stored, arm } = await readArm(tx);
  const now = await databaseNow(tx);
  if (stored === undefined || !marketingWebhookFaultArmMatches(arm, eventIdDigest, now)) {
    return { consumed: false };
  }
  const consumed: MarketingWebhookFaultArm = { ...arm, state: "consumed" };
  const moved = await tx.appSetting.updateMany({
    where: { key: MARKETING_WEBHOOK_FAULT_ARM_KEY, value: stored },
    data: { value: serializeMarketingWebhookFaultArm(consumed) },
  });
  if (moved.count !== 1) return { consumed: false };
  await writeSystemAuditLog({
    tx,
    systemActor: "marketing-webhook",
    action: MARKETING_S2E_ACTIONS.faultArmConsumed,
    targetType: "AppSetting",
    targetId: MARKETING_WEBHOOK_FAULT_ARM_KEY,
    summary: "Consumed the armed webhook fault; this delivery is answered 5xx once.",
    metadata: { eventIdDigest, generation: arm.generation },
  });
  return { consumed: true };
}

/** What a console shows: the current arm, or none. Read-only. */
export async function readMarketingWebhookFaultArm(
  tx: Pick<MarketingTransaction, "appSetting">,
): Promise<MarketingWebhookFaultArm | null> {
  const row = await tx.appSetting.findUnique({
    where: { key: MARKETING_WEBHOOK_FAULT_ARM_KEY },
    select: { value: true },
  });
  return parseMarketingWebhookFaultArm(row?.value);
}
