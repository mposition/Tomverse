/**
 * Resolving the facts a draft is judged against.
 *
 * Contract: docs/policy/marketing-automation.md §7.2. The one file allowed to
 * call `sealMarketingFacts()`, which is checked by
 * `scripts/check-protected-table-writers.mjs` the way the template seal is --
 * a `WeakSet` says an object came from that function and says nothing about
 * who called it.
 *
 * What it does is read the registries this file does not own
 * (`lib/marketingClaims.ts`, `lib/marketingAssets.ts`) and ask them, rather
 * than letting a caller assert the answers. The Guard used to take `known`,
 * `featurePublic` and `priceSourcesAllStored` from whoever called it, so a
 * claim id that is in no registry at all could be declared true and carried to
 * `autonomous_eligible`.
 *
 * **Usage is a database fact.** Whether an account has published a claim
 * before is not in any registry, so it is passed in -- and it is the one input
 * here that a caller states. It decides only `first_use_of_claim`, which sends
 * a post to a person rather than releasing one; getting it wrong the
 * dishonest way means asking for an approval nobody needed.
 */

import "server-only";

import type { MarketingGuardFacts } from "@/lib/marketingFacts";
import { sealMarketingFacts } from "@/lib/marketingGuardCore";
import {
  MARKETING_CLAIM_REGISTRY_VERSION,
  marketingClaimById,
  resolveMarketingClaim,
} from "@/lib/marketingClaims";
import type { PrismaClient } from "@prisma/client";

/** Only the two tables this file reads. It writes nothing. */
export type MarketingFactDatabase = Pick<
  PrismaClient,
  "appSetting" | "marketingPost"
>;

/**
 * What a caller may say: which ids, and which post they are for.
 *
 * Not the answers. The first version took `on`, `gates`, `claimsUsedBefore`
 * and the rest from whoever called it, which meant an expired claim could be
 * resolved on a date it was still valid, a gated one on a gate somebody said
 * was open, and a first use on a history somebody said had happened. A caller
 * naming the scope is naming the question; a caller naming the gate is
 * answering it.
 */
export type MarketingFactRequest = {
  readonly claimIds: readonly string[];
  readonly assetIds: readonly string[];
  /** The account the post is for, which is whose history "used before" is. */
  readonly channelId: string;
  readonly locale: string;
  /** The digest of the fact snapshot the post will store, or `null`. */
  readonly factSnapshotDigest: string | null;
};

/** What a claim's gate is, from the settings table rather than from a caller. */
async function readGates(
  database: MarketingFactDatabase,
  gateKeys: readonly string[],
): Promise<Map<string, boolean | null>> {
  const gates = new Map<string, boolean | null>();
  if (gateKeys.length === 0) return gates;

  // Unreadable is `null` rather than `false`, which is the distinction
  // `marketingClaimUsable()` exists to keep: a flag nobody could read is not a
  // flag that is off, and both refuse.
  for (const key of gateKeys) gates.set(key, null);

  try {
    const rows = await database.appSetting.findMany({
      where: { key: { in: [...gateKeys] } },
      select: { key: true, value: true },
    });
    for (const row of rows) {
      const value: unknown = row.value;
      gates.set(row.key, value === true || value === "true");
    }
  } catch {
    // Left as `null`, which refuses.
  }

  return gates;
}

/**
 * Which of these claims and assets this account has published before.
 *
 * Read from the posts table, because that is where it is. A caller that could
 * say "used before" could turn every first use into a repeat and skip the
 * approval §7.4 asks for.
 */
async function readUsage(
  database: MarketingFactDatabase,
  channelId: string,
): Promise<{ claims: Set<string>; assets: Set<string> }> {
  const rows = await database.marketingPost.findMany({
    where: { channelId, status: { in: ["published", "verified"] } },
    select: { claimIds: true, assetIds: true },
  });
  const claims = new Set<string>();
  const assets = new Set<string>();
  for (const row of rows) {
    for (const id of row.claimIds) claims.add(id);
    for (const id of row.assetIds) assets.add(id);
  }
  return { claims, assets };
}

/**
 * Ask the registries and the database, and seal the answer.
 *
 * A claim the registry does not have resolves to `known: false`, which the
 * Guard refuses -- rather than being absent, which it would not notice.
 *
 * The clock is this process's, not the caller's. It is not the database's
 * either, which would be better and needs raw SQL in a file that currently
 * has none; what matters here is that the date a claim's expiry is measured
 * against is not a number the caller chose.
 */
export async function resolveMarketingFacts(
  database: MarketingFactDatabase,
  request: MarketingFactRequest,
): Promise<MarketingGuardFacts> {
  const on = new Date();
  const registryClaims = request.claimIds.map((id) => marketingClaimById(id));
  const gateKeys = registryClaims
    .map((claim) => claim?.gate)
    .filter((gate): gate is string => typeof gate === "string");

  const [gates, usage] = await Promise.all([
    readGates(database, gateKeys),
    readUsage(database, request.channelId),
  ]);

  const claims = request.claimIds.map((claimId) => {
    const registryClaim = marketingClaimById(claimId);
    const resolution = resolveMarketingClaim({
      id: claimId,
      locale: request.locale,
      on,
      gateEnabled: registryClaim?.gate
        ? (gates.get(registryClaim.gate) ?? null)
        : undefined,
    });

    if (!resolution.ok) {
      return {
        claimId,
        type: "unknown",
        known: false,
        usedBefore: usage.claims.has(claimId),
      };
    }

    const claim = resolution.claim;
    return {
      claimId,
      type: claim.type,
      known: true,
      statesCreditAllowance: claim.planMeaning === "credit_allowance",
      usedBefore: usage.claims.has(claimId),
    };
  });

  // Assets are resolved by their own registry, which is loaded rather than
  // imported -- so until that loader is wired to a caller, an asset id
  // resolves to `known: false` and the Guard refuses it. That is the right
  // answer for S1: nothing publishes yet.
  const assets = request.assetIds.map((assetId) => ({
    assetId,
    known: false,
    usedBefore: usage.assets.has(assetId),
  }));

  return sealMarketingFacts({
    claims,
    assets,
    claimRegistryVersion: MARKETING_CLAIM_REGISTRY_VERSION,
    // The asset registry is a file the loader reads rather than a module
    // constant, and nothing loads it yet; until it does, every asset resolves
    // to `known: false` and the version it would report is not knowable here.
    // Nought rather than a guess, and the Guard refuses the assets anyway.
    assetRegistryVersion: 0,
    factSnapshotDigest: request.factSnapshotDigest,
  });
}
