/**
 * What the marketing generator is told before it writes (S3 plan, S3b).
 *
 * Read-only, and only what a draft can be built from: the accounts a draft may
 * be for, the claims as the generator may see them, and the latest internal
 * brief and market facts -- structured values, never the pages they came from.
 * No URL, no evidence, no credential, no post. Assets join when S3a2 lets a
 * draft rest on one; until then a draft that names an asset is refused anyway.
 */

import "server-only";

import {
  MARKETING_REPORT_PAYLOAD_SCHEMAS,
  type MarketingReportKind,
} from "@/lib/marketingAutomationSchema";
import { generatorProjection, type MarketingClaimProjection } from "@/lib/marketingClaims";
import type { MarketingTransaction } from "@/lib/marketingStore";

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
  readonly brief: MarketingGeneratorReport | null;
  readonly marketIntel: MarketingGeneratorReport | null;
};

export type MarketingGeneratorReport = {
  readonly reportId: string;
  readonly periodEnd: string;
  readonly payload: unknown;
};

type ContextReader = Pick<MarketingTransaction, "marketingChannel" | "marketingReport">;

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
  const [brief, marketIntel] = await Promise.all([
    latestReport(db, "brief"),
    latestReport(db, "market_intel"),
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
    brief,
    marketIntel,
  };
}
