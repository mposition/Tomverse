import type { PrismaClient } from "@prisma/client";
import {
  MARKETING_REPORT_KINDS,
  parseMarketingReportPayload,
  type MarketingReportKind,
} from "@/lib/marketingAutomationSchema";

/**
 * Reading one stored marketing report for the Admin console.
 *
 * Read-only. The list the console already shows carries no payload, so this is
 * where an operator reads what a report says. The payload is parsed with the
 * schema its kind names (lib/marketingAutomationSchema.ts) and a row that does
 * not parse is reported as unreadable instead of being shown loosely: a page
 * that renders whatever is stored would show a row the writer's own checks
 * refuse.
 */

/** A report id is a cuid today; the pattern only keeps junk out of the query. */
export const MARKETING_REPORT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type MarketingReportDetail = {
  id: string;
  kind: MarketingReportKind;
  periodStart: string;
  periodEnd: string;
  sourceVersion: string;
  createdAt: string;
  /** Parsed against the schema of `kind`; the shape differs by kind. */
  payload: unknown;
  /** market_intel only: competitor id to display name. Empty for other kinds. */
  competitorNames: Record<string, string>;
};

export type MarketingReportReadResult =
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "found"; report: MarketingReportDetail };

/** The two tables this read touches, so a caller may pass the client or a transaction. */
export type MarketingReportReader = Pick<PrismaClient, "marketingReport" | "marketingCompetitor">;

const isReportKind = (value: string): value is MarketingReportKind =>
  (MARKETING_REPORT_KINDS as readonly string[]).includes(value);

/** The competitor ids a parsed market_intel payload names. */
function competitorIdsOf(payload: unknown): string[] {
  const facts = (payload as { facts?: Array<{ competitorId?: unknown }> }).facts;
  if (!Array.isArray(facts)) return [];
  const ids = new Set<string>();
  for (const fact of facts) {
    if (typeof fact.competitorId === "string") ids.add(fact.competitorId);
  }
  return [...ids];
}

export async function readMarketingReportForConsole(
  db: MarketingReportReader,
  reportId: string
): Promise<MarketingReportReadResult> {
  const row = await db.marketingReport.findUnique({
    where: { id: reportId },
    select: {
      id: true,
      kind: true,
      periodStart: true,
      periodEnd: true,
      sourceVersion: true,
      createdAt: true,
      payload: true,
    },
  });
  if (!row) return { kind: "missing" };
  if (!isReportKind(row.kind)) return { kind: "unreadable" };

  let payload: unknown;
  try {
    payload = parseMarketingReportPayload(row.kind, row.payload);
  } catch {
    return { kind: "unreadable" };
  }

  const competitorNames: Record<string, string> = {};
  if (row.kind === "market_intel") {
    const ids = competitorIdsOf(payload);
    if (ids.length > 0) {
      const competitors = await db.marketingCompetitor.findMany({
        where: { id: { in: ids } },
        select: { id: true, displayName: true },
      });
      for (const competitor of competitors) competitorNames[competitor.id] = competitor.displayName;
    }
  }

  return {
    kind: "found",
    report: {
      id: row.id,
      kind: row.kind,
      periodStart: row.periodStart.toISOString(),
      periodEnd: row.periodEnd.toISOString(),
      sourceVersion: row.sourceVersion,
      createdAt: row.createdAt.toISOString(),
      payload,
      competitorNames,
    },
  };
}
