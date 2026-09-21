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

import {
  marketingFactsDigest,
  type MarketingGuardFacts,
} from "@/lib/marketingFacts";
import { sealMarketingFacts } from "@/lib/marketingGuardCore";
import {
  MARKETING_CLAIM_REGISTRY_VERSION,
  resolveMarketingClaim,
} from "@/lib/marketingClaims";

export type MarketingFactRequest = {
  readonly claimIds: readonly string[];
  readonly assetIds: readonly string[];
  readonly locale: string;
  readonly on: Date;
  /** Claim ids this account has published before. */
  readonly claimsUsedBefore: ReadonlySet<string>;
  /** Asset ids this account has published before. */
  readonly assetsUsedBefore: ReadonlySet<string>;
  /** Feature gates, three-valued: `null` is "could not read". */
  readonly gates: ReadonlyMap<string, boolean | null>;
  /** The registry version the asset registry reports. */
  readonly assetRegistryVersion: number;
  /** The digest of the fact snapshot the post will store, or `null`. */
  readonly factSnapshotDigest: string | null;
};

/**
 * Ask the registries, and seal the answer.
 *
 * A claim the registry does not have resolves to `known: false`, which the
 * Guard refuses -- rather than being absent, which it would not notice.
 */
export function resolveMarketingFacts(
  request: MarketingFactRequest,
): MarketingGuardFacts {
  const claims = request.claimIds.map((claimId) => {
    const resolution = resolveMarketingClaim({
      id: claimId,
      locale: request.locale,
      on: request.on,
      gateEnabled: request.gates.get(claimId) ?? null,
    });

    if (!resolution.ok) {
      return {
        claimId,
        type: "unknown",
        known: false,
        usedBefore: request.claimsUsedBefore.has(claimId),
      };
    }

    const claim = resolution.claim;
    return {
      claimId,
      type: claim.type,
      known: true,
      statesCreditAllowance: claim.planMeaning === "credit_allowance",
      usedBefore: request.claimsUsedBefore.has(claimId),
    };
  });

  // Assets are resolved by their own registry, which is loaded rather than
  // imported -- so until that loader is wired to a caller, an asset id
  // resolves to `known: false` and the Guard refuses it. That is the right
  // answer for S1: nothing publishes yet.
  const assets = request.assetIds.map((assetId) => ({
    assetId,
    known: false,
    usedBefore: request.assetsUsedBefore.has(assetId),
  }));

  return sealMarketingFacts({
    claims,
    assets,
    claimRegistryVersion: MARKETING_CLAIM_REGISTRY_VERSION,
    assetRegistryVersion: request.assetRegistryVersion,
    factSnapshotDigest: request.factSnapshotDigest,
  });
}

/** Re-exported so a writer can recompute what a decision was made against. */
export { marketingFactsDigest };
