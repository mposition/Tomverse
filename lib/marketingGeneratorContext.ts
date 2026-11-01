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

import { launchHomepageContent } from "@/components/marketing/launchHomepageContent";
import { infoPages } from "@/components/marketing/marketingInfoContent";
import { getBillingPlansWithFieldSources } from "@/lib/billingConfig";
import { MARKETING_ANALYSIS_ENABLED_KEY, marketingAnalysisEnabledFromValue } from "@/lib/marketingAnalysisCore";
import {
  MARKETING_REPORT_PAYLOAD_SCHEMAS,
  type MarketingReportKind,
} from "@/lib/marketingAutomationSchema";
import type { MarketingAssetRegistry } from "@/lib/marketingAssets";
import {
  readKnownMarketingCompetitorIds,
  readMarketingCompetitorsForGenerator,
} from "@/lib/marketingCompetitorStore";
import {
  generatorProjection,
  MARKETING_CLAIMS,
  type MarketingClaim,
  type MarketingClaimProjection,
} from "@/lib/marketingClaims";
import { resolveMarketingPageEvidence } from "@/lib/marketingEvidencePages";
import { readApprovedMarketingAssetKinds } from "@/lib/marketingAssetStore";
import { readMarketingAssetRegistry } from "@/lib/marketingFactResolution";
import {
  MARKETING_LLM_SETTINGS_KEY,
  parseMarketingLlmSettings,
  type MarketingLlmPricePin,
} from "@/lib/marketingLlmBudgetCore";
import { marketingLlmCatalogPinsIn } from "@/lib/marketingLlmModelCatalog";
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
  readonly claims: readonly MarketingGeneratorClaim[];
  readonly assets: readonly MarketingGeneratorAsset[];
  readonly brief: MarketingGeneratorReport | null;
  readonly marketIntel: MarketingGeneratorReport | null;
  readonly competitors: MarketingGeneratorCompetitors;
  /**
   * The model the operator selected in the Admin Console and its price pin
   * from the chat catalog, or nulls when none is selected, the setting cannot
   * be read or the catalog no longer prices it. The worker builds its requests
   * from this pin; the ledger derives the same pin and refuses any other.
   */
  readonly llm: { readonly model: string | null; readonly pin: MarketingLlmPricePin | null };
  /**
   * Tomverse's own public copy and plans, for the analysis call to read
   * (operator decision 2026-11-01). Our own pages and stored plan values: no
   * competitor text, no URL.
   */
  readonly ownProduct: { readonly pages: Readonly<Record<string, unknown>>; readonly plans: readonly MarketingGeneratorPlan[] };
  /** Whether the Admin switch lets this run spend on the analysis and brief. Off when unreadable. */
  readonly analysis: { readonly enabled: boolean };
};

/**
 * A claim as the generator may use it: the projection (no evidence, no fact
 * source) and what a post that makes it has to say. For a page claim that is
 * the page's sentence in each locale -- the Guard requires the post to carry it
 * word for word and re-reads the page when it judges the post, so the model is
 * told the words rather than left to reproduce them. For a price claim it is
 * the stored plan's values the claim names. A model that knows the words is
 * still judged against the page and the stored row, not against this.
 */
export type MarketingGeneratorClaim = MarketingClaimProjection & {
  readonly statements: Readonly<Record<string, string>>;
  readonly values: Readonly<Record<string, string | number>> | null;
};

/**
 * A plan as the analysis reads it. `pricesStored` says whether an operator
 * saved its price and currency; when not, the values are the code's built-in
 * defaults (lib/billingPlanDefaults.ts), which the analysis is told not to
 * treat as what the site charges.
 */
export type MarketingGeneratorPlan = {
  readonly id: string;
  readonly pricesStored: boolean;
  readonly name: string;
  readonly monthlyPriceCents: number;
  readonly annualPriceCents: number;
  readonly currency: string;
  readonly dailyMessageLimit: number;
  readonly monthlyMessageLimit: number;
  readonly maxModels: number;
  readonly allowAttachments: boolean;
  readonly allowSharing: boolean;
  readonly allowDownloads: boolean;
};

/** A plan's values and which of them an operator saved (the rest are compiled defaults). */
export type MarketingGeneratorPlanFacts = {
  readonly values: Readonly<Record<string, unknown>>;
  readonly storedFields: ReadonlySet<string>;
};

/**
 * The registry's claims with what each says, for the generator. A price
 * claim's values are given only when every field it names is stored: the
 * Guard refuses a price resting on a compiled default, so a default handed to
 * A5 could only become a draft that is refused (review 2026-11-01).
 */
export function generatorClaimContext(
  claims: readonly MarketingClaim[],
  plans: ReadonlyMap<string, MarketingGeneratorPlanFacts>,
): MarketingGeneratorClaim[] {
  const projections = generatorProjection(claims);
  return claims.map((claim, index) => {
    const statements: Record<string, string> = {};
    if (claim.evidence?.kind === "page") {
      for (const locale of claim.locales) {
        const resolved = resolveMarketingPageEvidence({
          pageRoute: claim.evidence.pageRoute,
          localeKey: claim.evidence.localeKey,
          locale,
        });
        if (resolved.ok) statements[locale] = resolved.text;
      }
    }
    let values: Record<string, string | number> | null = null;
    if (claim.factSource?.kind === "billing_plan") {
      const plan = plans.get(claim.factSource.planId);
      if (plan && claim.factSource.fields.every((field) => plan.storedFields.has(field))) {
        values = {};
        for (const field of claim.factSource.fields) {
          const value = plan.values[field];
          if (typeof value === "string" || typeof value === "number") values[field] = value;
        }
      }
    }
    return { ...projections[index], statements, values };
  });
}

/** The homepage, About and FAQ copy in English: what Tomverse says about itself. */
const ownPages = (): Record<string, unknown> => {
  const home = launchHomepageContent.en;
  return {
    home: { hero: home.hero, adaptive: home.adaptive, review: home.review, tools: home.tools, plans: home.plans, guest: home.guest },
    about: infoPages.about.en,
    faq: infoPages.faq.en,
  };
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

/** An asset as the generator may see it: what to name, where, in which locales, and what it shows. */
export type MarketingGeneratorAsset = {
  readonly id: string;
  readonly allowedChannels: readonly string[];
  readonly altLocales: readonly string[];
  readonly claimIds: readonly string[];
  readonly validUntil: string;
  /** `video` or `image` for a stored asset; null for a hand-kept one, which names no kind. */
  readonly kind: "image" | "video" | null;
  /** The alt text per locale: what the asset shows, so a post can be about it. */
  readonly alt: Readonly<Record<string, string>>;
};

/**
 * The registry's assets that one of these accounts' platforms may carry, as
 * the generator may see them, with the alt text a person approved as the
 * description of what each shows (owner direction 2026-10-31: a video post is
 * written about its video). No provenance or disclosure: the Guard judges an
 * asset and the post that carries it from the registry itself, so nothing the
 * generator is told here can stand in for that judgement.
 */
export function generatorAssetProjection(
  registry: MarketingAssetRegistry | null,
  channels: readonly string[],
  kinds: ReadonlyMap<string, "image" | "video"> = new Map(),
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
      kind: kinds.get(asset.id) ?? null,
      alt: { ...asset.alt },
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export type MarketingGeneratorReport = {
  readonly reportId: string;
  readonly periodEnd: string;
  readonly payload: unknown;
};

type ContextReader = Pick<
  MarketingTransaction,
  | "marketingChannel"
  | "marketingReport"
  | "marketingCompetitor"
  | "appSetting"
  | "modelRegistryEntry"
  | "billingPlan"
  | "$queryRaw"
>;

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

const llmContext = async (db: ContextReader, model: string | null): Promise<MarketingGeneratorContext["llm"]> => {
  // Through the caller's transaction, so the pin is read in its snapshot.
  const pin = model === null ? undefined : (await marketingLlmCatalogPinsIn(db)).find((candidate) => candidate.model === model);
  return pin ? { model, pin } : { model: null, pin: null };
};

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
  const [brief, marketIntel, tracked, knownIds, llmSetting, analysisSetting, plans] = await Promise.all([
    latestReport(db, "brief"),
    latestReport(db, "market_intel"),
    readMarketingCompetitorsForGenerator(db),
    readKnownMarketingCompetitorIds(db),
    db.appSetting.findUnique({ where: { key: MARKETING_LLM_SETTINGS_KEY }, select: { value: true } }),
    db.appSetting.findUnique({ where: { key: MARKETING_ANALYSIS_ENABLED_KEY }, select: { value: true } }),
    getBillingPlansWithFieldSources(db),
  ]);
  const active = plans.filter((entry) => entry.plan.isActive);
  const activePlans: MarketingGeneratorPlan[] = active.map(({ plan, sources }) => ({
    id: plan.id,
    pricesStored: sources.monthlyPriceCents === "stored" && sources.currency === "stored",
    name: plan.name,
    monthlyPriceCents: plan.monthlyPriceCents,
    annualPriceCents: plan.annualPriceCents,
    currency: plan.currency,
    dailyMessageLimit: plan.dailyMessageLimit,
    monthlyMessageLimit: plan.monthlyMessageLimit,
    maxModels: plan.maxModels,
    allowAttachments: plan.allowAttachments,
    allowSharing: plan.allowSharing,
    allowDownloads: plan.allowDownloads,
  }));
  return {
    channels: channels.map((row) => ({
      id: row.id,
      channel: row.channel,
      accountSlug: row.accountSlug,
      defaultLocale: row.defaultLocale,
      allowedLocales: [...row.allowedLocales],
    })),
    claims: generatorClaimContext(
      MARKETING_CLAIMS,
      new Map(
        active.map(({ plan, sources }) => [
          plan.id,
          {
            values: plan,
            storedFields: new Set(Object.keys(sources).filter((field) => sources[field as keyof typeof sources] === "stored")),
          },
        ]),
      ),
    ),
    assets: generatorAssetProjection(
      await readMarketingAssetRegistry(db),
      channels.map((row) => row.channel),
      await readApprovedMarketingAssetKinds(db),
    ),
    brief,
    marketIntel,
    competitors: { tracked, knownIds },
    llm: await llmContext(db, parseMarketingLlmSettings(llmSetting?.value)?.model ?? null),
    ownProduct: { pages: ownPages(), plans: activePlans },
    analysis: { enabled: marketingAnalysisEnabledFromValue(analysisSetting?.value) },
  };
}
