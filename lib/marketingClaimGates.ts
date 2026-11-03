/**
 * Resolving the feature flag a claim depends on.
 *
 * Contract: the S1 plan's S1e fact-source list -- "feature public: claim `gate`
 * resolves via existing production flag reader; unreadable → not public".
 *
 * A registry of gates rather than a generic reader of `feature.*` rows, because
 * a flag's stored value is not its answer. `feature.chatStarterEnabled` is off
 * whenever its kill switch is engaged regardless of the row, and each flag's
 * owning module holds that interpretation. A generic reader would consult the
 * row directly and disagree with the product about whether a feature is on --
 * and it would disagree in the dangerous direction, since a kill switch is
 * engaged precisely when something is wrong.
 *
 * So a gate is a claim-facing id bound to the real reader, and a gate nobody
 * bound resolves to unreadable.
 *
 * A gate is bound here in the same change as the claim that needs it, and
 * only the gates a registered claim names are bound
 * (tests/marketingClaimGates.test.mjs).
 */

import "server-only";

import type { Prisma } from "@prisma/client";

import { assistantProfilesEnabledFromValue, ASSISTANT_PROFILES_FLAG_KEY } from "@/lib/assistantProfileAccess";
import { EXTERNAL_CONTINUATION_FLAG_KEY, externalContinuationEnabledFromValue } from "@/lib/externalContinuationAccess";
import { EXTERNAL_IMPORT_FLAG_KEY, externalImportEnabledFromValue } from "@/lib/externalImportAccess";
import { IMAGE_GENERATION_FLAG_KEY, imageGenerationEnabledFromValue } from "@/lib/imageGenerationAccess";
import { PROMPT_REFINER_FLAG_KEY, promptRefinerAvailable } from "@/lib/promptRefinerAccess";

/**
 * The client a gate reads through: the caller's transaction, so a flag is read
 * in the same snapshot as the facts it gates (S3 plan, S3a2). Settings only,
 * and the raw query that locks them.
 */
export type MarketingClaimGateDatabase = Pick<Prisma.TransactionClient, "appSetting" | "$queryRaw">;

/** `OPERATIONAL_FLAG_KEYS.attachmentsEnabled` in lib/appSettings.ts. */
const ATTACHMENTS_FLAG_KEY = "feature.attachmentsEnabled";

/**
 * The stored values of these settings, locked FOR SHARE first. Only a row the
 * lock took counts: one inserted after it was not held, so it reads as absent,
 * the way the fact resolver treats a plan row it did not lock.
 */
async function heldSettingValues(
  database: MarketingClaimGateDatabase,
  keys: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const held = new Set(
    (
      await database.$queryRaw<Array<{ key: string }>>`SELECT "key" FROM "AppSetting" WHERE "key" = ANY(${[...keys]}::text[]) ORDER BY "key" FOR SHARE`
    ).map((row) => row.key),
  );
  if (held.size === 0) return new Map();
  const rows = await database.appSetting.findMany({
    where: { key: { in: [...held] } },
    select: { key: true, value: true },
  });
  return new Map(rows.map((row) => [row.key, row.value]));
}

/**
 * Gate id -> the reader that owns it.
 *
 * The reader returns the product's answer, not the row, read through the client
 * it is given -- and the row it reads it locks FOR SHARE first, as the fact
 * resolver does for plans and models, so the gate cannot change before the
 * caller commits. A reader that throws is handled by the resolver rather than
 * here, so a gate never has to decide what a database failure means.
 */
export const MARKETING_CLAIM_GATES: Readonly<
  Record<string, (database: MarketingClaimGateDatabase) => Promise<boolean>>
> = Object.freeze({
  "feature.assistantProfiles": async (database) =>
    assistantProfilesEnabledFromValue(
      (await heldSettingValues(database, [ASSISTANT_PROFILES_FLAG_KEY])).get(ASSISTANT_PROFILES_FLAG_KEY),
    ),
  // The claim says both: import, then continue in Tomverse.
  "feature.externalImportAndContinuation": async (database) => {
    const values = await heldSettingValues(database, [EXTERNAL_IMPORT_FLAG_KEY, EXTERNAL_CONTINUATION_FLAG_KEY]);
    return (
      externalImportEnabledFromValue(values.get(EXTERNAL_IMPORT_FLAG_KEY)) &&
      externalContinuationEnabledFromValue(values.get(EXTERNAL_CONTINUATION_FLAG_KEY))
    );
  },
  "feature.imageGeneration": async (database) =>
    imageGenerationEnabledFromValue(
      (await heldSettingValues(database, [IMAGE_GENERATION_FLAG_KEY])).get(IMAGE_GENERATION_FLAG_KEY),
    ),
  // A kill switch, on unless the row says "false" (`enabledFromValue` in
  // lib/appSettings.ts): a missing row is the product's "on".
  "feature.attachments": async (database) =>
    (await heldSettingValues(database, [ATTACHMENTS_FLAG_KEY])).get(ATTACHMENTS_FLAG_KEY) !== "false",
  // The rollout flag and the environment kill switch, as the product reads them.
  "feature.promptRefiner": async (database) =>
    promptRefinerAvailable({
      storedFlagValue: (await heldSettingValues(database, [PROMPT_REFINER_FLAG_KEY])).get(PROMPT_REFINER_FLAG_KEY),
      env: process.env,
    }),
});

/**
 * Whether the gate is on, off, or could not be read.
 *
 * Three-valued on purpose, and `resolveMarketingClaim()` refuses on two of
 * them with different codes. Collapsing unreadable into `false` would be safe
 * for publication and wrong for diagnosis: every claim behind a gate would
 * quietly stop resolving during a database incident and the refusal would say
 * the feature was switched off.
 *
 * An unknown gate id is unreadable rather than off. It means a claim names a
 * flag this build does not bind -- a registry that has drifted from the claims,
 * which somebody has to look at, not a feature somebody turned off.
 */
export async function resolveMarketingClaimGate(
  gate: string,
  database: MarketingClaimGateDatabase,
): Promise<boolean | null> {
  const reader = Object.prototype.hasOwnProperty.call(
    MARKETING_CLAIM_GATES,
    gate,
  )
    ? MARKETING_CLAIM_GATES[gate]
    : undefined;
  if (!reader) return null;
  return readGateSafely(() => reader(database));
}

/**
 * Run one gate reader, turning a failure into "could not read".
 *
 * Separate from the lookup so that behaviour can be exercised without handing
 * the resolver a registry of its own -- the rule round 3 established for the
 * link builders. A caller passing its own reader here learns what that reader
 * says, which is nothing about which gates exist; the function that answers
 * that reads only this module's registry.
 */
export async function readGateSafely(
  reader: () => Promise<boolean>,
): Promise<boolean | null> {
  try {
    return await reader();
  } catch {
    // Deliberately no detail: the caller's refusal code says `gate_unreadable`
    // and a provider or database message on a marketing path is how internal
    // text reaches a public surface.
    return null;
  }
}
