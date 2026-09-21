/**
 * The facts a draft is judged against, and the seal that says who resolved
 * them.
 *
 * Contract: docs/policy/marketing-automation.md §7.2, and the S1 plan's S1f
 * section.
 *
 * **A fact is not a boolean a caller passes.** The Guard used to take
 * `known: true`, `featurePublic: true` and the rest straight from whoever
 * called it, which meant a claim id that is in no registry at all could be
 * declared true and carried to `autonomous_eligible`. The comment said the
 * caller resolves and passes the answer; nothing checked that a resolver had
 * been anywhere near it.
 *
 * So a bundle is sealed, the way a template proof is: membership of a
 * module-private `WeakSet`, frozen before it is registered, and the call sites
 * counted by `scripts/check-protected-table-writers.mjs`. The one file allowed
 * to call the sealer is the resolver, which reads the registries.
 *
 * **The sealer itself lives in `lib/marketingGuardCore.ts`**, beside the Guard
 * that reads the bundle, for the same reason the template sealer does: a
 * `WeakSet` is one module's, and a module loaded twice under two specifiers
 * has two of them. This file holds the shapes and the digest, which do not
 * care how many copies of themselves exist.
 *
 * Pure: no server-only import, no network, no Prisma.
 */

import { createHash } from "node:crypto";

/**
 * A claim the draft declares, already resolved against the registries.
 *
 * The Guard does not look claims up -- `lib/marketingClaims.ts` owns the
 * registry and refuses to be handed another one -- so the resolver asks it and
 * puts the answer here.
 */
export type MarketingGuardClaimFact = {
  readonly claimId: string;
  /** Checked against the closed list; an unrecognised kind is refused. */
  readonly type: string;
  /** `false` when the claim id is not in the registry at all. */
  readonly known: boolean;
  /** For `pricing` and `plan`: whether every field it uses is `stored`. */
  readonly priceSourcesAllStored?: boolean;
  /** For `plan`: whether this claim is the credit allowance itself. */
  readonly statesCreditAllowance?: boolean;
  /** The allowance sentence, as the post renders it in this locale. */
  readonly allowanceStatement?: string;
  /** For a price claim: the stored currency. */
  readonly currency?: string;
  readonly targetsAustralia?: boolean;
  /** For `model`: the runtime row agreed with the claim. */
  readonly modelMatches?: boolean;
  /** For `feature` and `availability`: the gate is on and the evidence resolves. */
  readonly featurePublic?: boolean;
  /** The public-page sentence the feature or availability claim rests on. */
  readonly evidenceStatement?: string;
  /** For `comparison`: a URL and a scope were recorded. */
  readonly comparisonEvidence?: boolean;
  /** Whether this account has published this claim before. */
  readonly usedBefore: boolean;
};

export type MarketingGuardAssetFact = {
  readonly assetId: string;
  readonly known: boolean;
  readonly usedBefore: boolean;
};

/**
 * Everything the Guard is told about the world, in one sealed object.
 *
 * The registry versions and the fact-snapshot digest are here so the decision
 * can carry them: a post records which registries it saw, and a decision that
 * did not say which ones it read could be attached to a post claiming others.
 */
export type MarketingGuardFacts = {
  /** The account whose publication history was read. */
  readonly channelId: string;
  /** The platform whose asset rules were applied. */
  readonly channel: string;
  /** The locale claims and asset alt text were resolved for. */
  readonly locale: string;
  readonly claims: readonly MarketingGuardClaimFact[];
  readonly assets: readonly MarketingGuardAssetFact[];
  readonly claimRegistryVersion: number;
  readonly assetRegistryVersion: number;
  /** The digest of the fact snapshot the post will store, or `null`. */
  readonly factSnapshotDigest: string | null;
};

/**
 * What a writer can recompute, and what it therefore proves.
 *
 * The ids, the registry versions and the snapshot digest -- every one of which
 * a post stores in a column. So a store can ask "was this decision resolved
 * against the facts I am about to record", and the answer means the *scope*
 * matched. It does not mean the facts were true, and it cannot: the store has
 * no way to re-resolve a claim.
 */
export function marketingFactsScopeDigest(facts: {
  readonly channelId: string;
  readonly channel: string;
  readonly locale: string;
  readonly claimIds: readonly string[];
  readonly assetIds: readonly string[];
  readonly claimRegistryVersion: number;
  readonly assetRegistryVersion: number;
  readonly factSnapshotDigest: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "marketing-guard-facts-scope-v1",
        facts.channelId,
        facts.channel,
        facts.locale,
        [...facts.claimIds].sort(),
        [...facts.assetIds].sort(),
        facts.claimRegistryVersion,
        facts.assetRegistryVersion,
        facts.factSnapshotDigest,
      ]),
      "utf8",
    )
    .digest("hex");
}

/**
 * Everything the decision was made on, including every answer.
 *
 * The scope digest above covers the ids and nothing else, so two bundles that
 * disagree about every fact -- `featurePublic: true` and `featurePublic:
 * false` for the same claim id, one autonomous and one refused -- hashed the
 * same. This one distinguishes them, which is what makes the value on a
 * decision worth recording: nobody can recompute it, and that is the point.
 * It says *which* answers were given, so two decisions that differ are two
 * different values in the record.
 */
export function marketingFactsDigest(facts: MarketingGuardFacts): string {
  const claim = (entry: MarketingGuardClaimFact) => [
    entry.claimId,
    entry.type,
    entry.known,
    entry.priceSourcesAllStored ?? null,
    entry.statesCreditAllowance ?? null,
    entry.allowanceStatement ?? null,
    entry.currency ?? null,
    entry.targetsAustralia ?? null,
    entry.modelMatches ?? null,
    entry.featurePublic ?? null,
    entry.evidenceStatement ?? null,
    entry.comparisonEvidence ?? null,
    entry.usedBefore,
  ];

  return createHash("sha256")
    .update(
      JSON.stringify([
        "marketing-guard-facts-v2",
        facts.channelId,
        facts.channel,
        facts.locale,
        [...facts.claims]
          .map(claim)
          .sort((left, right) =>
            JSON.stringify(left) < JSON.stringify(right) ? -1 : 1,
          ),
        [...facts.assets]
          .map((entry) => [entry.assetId, entry.known, entry.usedBefore])
          .sort((left, right) =>
            JSON.stringify(left) < JSON.stringify(right) ? -1 : 1,
          ),
        facts.claimRegistryVersion,
        facts.assetRegistryVersion,
        facts.factSnapshotDigest,
      ]),
      "utf8",
    )
    .digest("hex");
}
