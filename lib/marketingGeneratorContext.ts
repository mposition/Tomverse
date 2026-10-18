/**
 * What the marketing generator is told before it writes (S3 plan, S3b).
 *
 * Read-only, and only what a draft can be built from: the accounts a draft may
 * be for, the claims as the generator may see them, and the latest internal
 * brief and market facts -- structured values, never the pages they came from
 * -- and the competitor registry as A3 tracks it: who, and on which hosts.
 * No URL, no evidence, no credential, no post. The assets a draft may name are
 * listed by id, channels and the locales that have alt text -- not the alt
 * text, which the platform is given and the model does not write (S3a2).
 */

import "server-only";

import {
  MARKETING_REPORT_PAYLOAD_SCHEMAS,
  type MarketingReportKind,
} from "@/lib/marketingAutomationSchema";
import type { MarketingAssetRegistry } from "@/lib/marketingAssets";
import {
  readKnownMarketingCompetitorIds,
  readMarketingCompetitorsForGenerator,
} from "@/lib/marketingCompetitorStore";
import { generatorProjection, type MarketingClaimProjection } from "@/lib/marketingClaims";
import { readMarketingAssetRegistry } from "@/lib/marketingFactResolution";
import type { MarketingTransaction } from "@/lib/marketingStore";

/**
 * Whether the generator may be given context at all.
 *
 * The kill switch stops everything but reading the record
 * (docs/policy/marketing-automation.md §6.1), and the generator reading the
 * accounts and claims is not reading the record -- it is the first step of
 * writing. Same rule as the access resolver: an unreadable switch stops, and
 * any non-empty value is on.
 */
export const marketingGeneratorContextAllowed = (killSwitchValue: {
  readonly ok: boolean;
  readonly value?: string | undefined;
}): boolean =>
  killSwitchValue.ok &&
  !(typeof killSwitchValue.value === "string" && killSwitchValue.value.trim().length > 0);

/** The largest answer, so a report that grew cannot grow the prompt with it. */
export const MARKETING_GENERATOR_CONTEXT_MAX_BYTES = 128 * 1024;

export type MarketingGeneratorContext = {
  readonly channels: ReadonlyArray<{
    readonly id: string;
    readonly channel: string;
    readonly accountSlug: string;
    readonly defaultLocale: string;
    readonly allowedLocales: readonly string[];
  }>;
  readonly claims: readonly MarketingClaimProjection[];
  readonly assets: readonly MarketingGeneratorAsset[];
  readonly brief: MarketingGeneratorReport | null;
  readonly marketIntel: MarketingGeneratorReport | null;
  readonly competitors: MarketingGeneratorCompetitors;
};

/**
 * The registry as A3 needs it (operator decision 2026-10-17). `tracked` is the
 * approved competitors and the hosts a person approved for each: what to look
 * at, and the only hosts a fact may cite. `knownIds` is every id the registry
 * holds in any status, so a candidate is something new rather than a proposal
 * a person has already answered. The tracked pages are the one place a URL
 * appears in this context: A3 reads them, and A5 is given none of this
 * (lib/marketingGeneratorDraftingCore.ts picks its fields).
 */
export type MarketingGeneratorCompetitors = {
  readonly tracked: ReadonlyArray<{
    readonly competitorId: string;
    readonly displayName: string;
    readonly officialHosts: readonly string[];
    /** The pages a person approved for A3 to read: the context's only URLs. */
    readonly trackedPages: readonly string[];
  }>;
  readonly knownIds: readonly string[];
};

/** An asset as the generator may see it: what to name, where, in which locales. */
export type MarketingGeneratorAsset = {
  readonly id: string;
  readonly allowedChannels: readonly string[];
  readonly altLocales: readonly string[];
  readonly claimIds: readonly string[];
  readonly validUntil: string;
};

/**
 * The registry's assets that one of these accounts' platforms may carry, as
 * the generator may see them. No provenance, disclosure or alt prose: the
 * Guard judges an asset from the registry itself, so nothing the generator is
 * told here can stand in for that judgement.
 */
export function generatorAssetProjection(
  registry: MarketingAssetRegistry | null,
  channels: readonly string[],
): MarketingGeneratorAsset[] {
  if (!registry) return [];
  const platforms = new Set(channels);
  return registry.assets
    .filter((asset) => asset.allowedChannels.some((channel) => platforms.has(channel)))
    .map((asset) => ({
      id: asset.id,
      allowedChannels: asset.allowedChannels.filter((channel) => platforms.has(channel)).sort(),
      altLocales: Object.keys(asset.alt).sort(),
      claimIds: [...asset.claimIds],
      validUntil: asset.validUntil,
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export type MarketingGeneratorReport = {
  readonly reportId: string;
  readonly periodEnd: string;
  readonly payload: unknown;
};

type ContextReader = Pick<MarketingTransaction, "marketingChannel" | "marketingReport" | "marketingCompetitor">;

/**
 * Market facts without the page each came from. The model writes no URL
 * (docs/policy/marketing-automation.md §7.3), so it is not shown one: the
 * value, the competitor, the kind of fact and the day it was checked are what a
 * draft can use, and the source stays with the report for a person.
 */
const withoutSourceUrls = (payload: unknown): unknown => {
  const value = payload as { facts: Array<Record<string, unknown>>; unrepresentableFactCount: number };
  return {
    facts: value.facts.map((fact) => ({
      competitorId: fact.competitorId,
      factType: fact.factType,
      value: fact.value,
      checkedAt: fact.checkedAt,
    })),
    unrepresentableFactCount: value.unrepresentableFactCount,
  };
};

/** The newest report of a kind whose payload still parses; a row that does not is skipped, not sent. */
async function latestReport(
  db: ContextReader,
  kind: Extract<MarketingReportKind, "brief" | "market_intel">,
): Promise<MarketingGeneratorReport | null> {
  const rows = await db.marketingReport.findMany({
    where: { kind },
    orderBy: [{ periodEnd: "desc" }, { createdAt: "desc" }],
    take: 3,
    select: { id: true, periodEnd: true, payload: true },
  });
  for (const row of rows) {
    const parsed = MARKETING_REPORT_PAYLOAD_SCHEMAS[kind].safeParse(row.payload);
    if (parsed.success) {
      return {
        reportId: row.id,
        periodEnd: row.periodEnd.toISOString(),
        payload: kind === "market_intel" ? withoutSourceUrls(parsed.data) : parsed.data,
      };
    }
  }
  return null;
}

export async function readMarketingGeneratorContext(
  db: ContextReader,
): Promise<MarketingGeneratorContext> {
  // Approval mode only: S3 drafts go to a person, and an account that is
  // waiting to connect, paused or disconnected is not one a draft is for.
  const channels = await db.marketingChannel.findMany({
    where: { status: "approval_mode" },
    orderBy: { id: "asc" },
    select: {
      id: true,
      channel: true,
      accountSlug: true,
      defaultLocale: true,
      allowedLocales: true,
    },
  });
  const [brief, marketIntel, tracked, knownIds] = await Promise.all([
    latestReport(db, "brief"),
    latestReport(db, "market_intel"),
    readMarketingCompetitorsForGenerator(db),
    readKnownMarketingCompetitorIds(db),
  ]);
  return {
    channels: channels.map((row) => ({
      id: row.id,
      channel: row.channel,
      accountSlug: row.accountSlug,
      defaultLocale: row.defaultLocale,
      allowedLocales: [...row.allowedLocales],
    })),
    claims: generatorProjection(),
    assets: generatorAssetProjection(
      await readMarketingAssetRegistry(),
      channels.map((row) => row.channel),
    ),
    brief,
    marketIntel,
    competitors: { tracked, knownIds },
  };
}
