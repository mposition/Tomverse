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
 * before is read from `MarketingPost` for the named account. A caller names
 * the account and locale whose question is being asked; it never supplies the
 * answer.
 */

import "server-only";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { getBillingPlansWithFieldSources } from "@/lib/billingConfig";
import { getBillingPriceCatalogWithMeta } from "@/lib/billingPriceCatalog";
import {
  loadMarketingAssetRegistry,
  MARKETING_ASSET_REGISTRY_PATH,
  resolveMarketingAsset,
  type LoadedAssetRegistry,
} from "@/lib/marketingAssets";
import { resolveMarketingClaimGate } from "@/lib/marketingClaimGates";
import type { MarketingGuardFacts } from "@/lib/marketingFacts";
import { sealMarketingFacts } from "@/lib/marketingGuardCore";
import {
  MARKETING_CLAIM_REGISTRY_VERSION,
  marketingClaimById,
  resolveMarketingClaim,
} from "@/lib/marketingClaims";
import {
  MARKETING_LOCALES,
  type MarketingLocale,
} from "@/lib/marketingAutomationSchema";
import { resolveMarketingPageEvidence } from "@/lib/marketingEvidencePages";
import {
  catalogueClaimSourceDecision,
  modelClaimDecision,
  priceClaimSourceDecision,
} from "@/lib/marketingFactSources";
import { getRuntimeModel } from "@/lib/modelRegistry";
import type { PrismaClient } from "@prisma/client";

/** The usage table this file reads through the caller's transaction/client. */
/**
 * Whether a string is one of the four locales this system knows.
 *
 * Small enough to inline, kept as a named predicate because the call site is
 * the difference between checking a value and asserting it away.
 */
const isMarketingLocale = (value: string): value is MarketingLocale =>
  (MARKETING_LOCALES as readonly string[]).includes(value);

export type MarketingFactDatabase = Pick<PrismaClient, "marketingPost">;

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
  /** The platform whose asset allowlist and disclosure rules apply. */
  readonly channel: string;
  readonly locale: string;
  /** The digest of the fact snapshot the post will store, or `null`. */
  readonly factSnapshotDigest: string | null;
};

/** What a claim's gate is, from its production reader rather than a caller. */
async function readGates(
  gateKeys: readonly string[],
): Promise<Map<string, boolean | null>> {
  const gates = new Map<string, boolean | null>();
  await Promise.all(
    [...new Set(gateKeys)].map(async (key) => {
      gates.set(key, await resolveMarketingClaimGate(key));
    }),
  );

  return gates;
}

const readAssetRegistry = async (): Promise<LoadedAssetRegistry | null> => {
  try {
    const raw = JSON.parse(
      await readFile(resolve(process.cwd(), MARKETING_ASSET_REGISTRY_PATH), "utf8"),
    ) as unknown;
    return loadMarketingAssetRegistry(raw);
  } catch {
    // A missing, unreadable or invalid registry makes every asset unknown.
    return null;
  }
};

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
 * either. The gate, usage, price, model and asset reads are also not one
 * transactional snapshot. That is acceptable only while every S1 feature is
 * off and `createMarketingPost()` refuses autonomous creation outright. The
 * S2 route must move the clock and all publish-relevant reads into the write
 * transaction before enabling a feature; this comment is the hand-off marker.
 */
export async function resolveMarketingFacts(
  database: MarketingFactDatabase,
  rawRequest: MarketingFactRequest,
): Promise<MarketingGuardFacts> {
  // The ids name the lookups and the scope names where those answers apply.
  // Snapshot both before the first await so an accessor cannot make the
  // resolver read channel A and then seal the answers as channel B.
  const request: MarketingFactRequest = {
    claimIds: [...rawRequest.claimIds].map(String),
    assetIds: [...rawRequest.assetIds].map(String),
    channelId: String(rawRequest.channelId),
    channel: String(rawRequest.channel),
    locale: String(rawRequest.locale),
    factSnapshotDigest:
      rawRequest.factSnapshotDigest === null
        ? null
        : String(rawRequest.factSnapshotDigest),
  };
  const on = new Date();
  const registryClaims = request.claimIds.map((id) => marketingClaimById(id));
  const gateKeys = registryClaims
    .map((claim) => claim?.gate)
    .filter((gate): gate is string => typeof gate === "string");

  const needsPlans = registryClaims.some(
    (claim) => claim?.factSource?.kind === "billing_plan",
  );
  const needsCatalogue = registryClaims.some(
    (claim) => claim?.factSource?.kind === "localized_catalogue",
  );

  const [gates, usage, plans, catalogue, assetRegistry] = await Promise.all([
    readGates(gateKeys),
    readUsage(database, request.channelId),
    needsPlans ? getBillingPlansWithFieldSources() : Promise.resolve([]),
    needsCatalogue ? getBillingPriceCatalogWithMeta() : Promise.resolve(null),
    request.assetIds.length > 0 ? readAssetRegistry() : Promise.resolve(null),
  ]);

  const claims = await Promise.all(request.claimIds.map(async (claimId) => {
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
    const fact = {
      claimId,
      type: claim.type,
      known: true,
      statesCreditAllowance: claim.planMeaning === "credit_allowance",
      usedBefore: usage.claims.has(claimId),
    };

    if (claim.type === "pricing" || claim.type === "plan") {
      const factSource = claim.factSource;
      if (factSource?.kind === "billing_plan") {
        const plan = plans.find((entry) => entry.plan.id === factSource.planId);
        const decision = plan
          ? priceClaimSourceDecision(
              factSource.fields.map((field) => ({
                field,
                source: plan.sources[field],
              })),
            )
          : { ok: false as const };
        return {
          ...fact,
          priceSourcesAllStored: decision.ok,
          currency: plan?.plan.currency,
          targetsAustralia: factSource.targetsAustralia,
        };
      }
      if (factSource?.kind === "localized_catalogue") {
        const decision = catalogue
          ? catalogueClaimSourceDecision(catalogue.source)
          : { ok: false as const };
        return {
          ...fact,
          priceSourcesAllStored: decision.ok,
          currency: factSource.currency,
          targetsAustralia: factSource.targetsAustralia,
        };
      }
      return { ...fact, priceSourcesAllStored: false };
    }

    if (claim.type === "model") {
      const factSource = claim.factSource;
      if (factSource?.kind !== "model_registry") {
        return { ...fact, modelMatches: false };
      }
      const model = (await getRuntimeModel(factSource.modelId)) ?? null;
      return {
        ...fact,
        modelMatches: modelClaimDecision({
          model,
          claimedMinimumPlan: factSource.minimumPlan ?? undefined,
        }).ok,
      };
    }

    if (claim.type === "feature" || claim.type === "availability") {
      if (claim.evidence?.kind !== "page") {
        return { ...fact, featurePublic: false };
      }
      // Checked rather than asserted. `request.locale` is a `string` by
      // construction (`String(rawRequest.locale)`), and the resolver wants one
      // of the four. A locale outside them has no page to be evidence, which
      // is the answer below; `as never` reached the same place by telling the
      // compiler not to look.
      if (!isMarketingLocale(request.locale)) {
        return { ...fact, featurePublic: false };
      }
      const evidence = resolveMarketingPageEvidence({
        pageRoute: claim.evidence.pageRoute,
        localeKey: claim.evidence.localeKey,
        locale: request.locale,
      });
      return evidence.ok
        ? { ...fact, featurePublic: true, evidenceStatement: evidence.text }
        : { ...fact, featurePublic: false };
    }

    if (claim.type === "comparison") {
      return {
        ...fact,
        comparisonEvidence:
          claim.evidence?.kind === "external" &&
          claim.evidence.url.length > 0 &&
          claim.evidence.scope.length > 0,
      };
    }

    return fact;
  }));

  const assets = request.assetIds.map((assetId) => {
    const resolution = assetRegistry
      ? resolveMarketingAsset({
          id: assetId,
          channel: request.channel,
          locale: request.locale,
          on,
          registry: assetRegistry,
        })
      : { ok: false as const };
    return {
      assetId,
      known: resolution.ok,
      usedBefore: usage.assets.has(assetId),
    };
  });

  return sealMarketingFacts({
    channelId: request.channelId,
    channel: request.channel,
    locale: request.locale,
    claims,
    assets,
    claimRegistryVersion: MARKETING_CLAIM_REGISTRY_VERSION,
    assetRegistryVersion: assetRegistry?.version ?? 0,
    factSnapshotDigest: request.factSnapshotDigest,
  });
}
