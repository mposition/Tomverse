/**
 * The generator's internal reports (S3 plan, S3f): a brief, or the market
 * facts A3 found. Their shape, their signature, the key a report is stored
 * under and the source rule a market fact must meet. Pure -- no database, no
 * environment.
 *
 * The generator is not trusted (docs/policy/marketing-automation.md §4). It
 * reads competitors' pages, and a page is data, never instructions (§3): what
 * reaches the app is structured facts, and only facts whose source is one of
 * the official hosts a person approved for that competitor are kept. The
 * generator's idea of which host is official is a proposal, never a source.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { MARKETING_REPORT_PAYLOAD_SCHEMAS } from "@/lib/marketingAutomationSchema";
import {
  MARKETING_COMPETITOR_MAX_CANDIDATES,
  marketingCompetitorCandidateSchema,
  type MarketingCompetitorSourceHosts,
} from "@/lib/marketingCompetitorCore";

/** The largest body read; the route abandons the stream at the first byte over. */
export const MARKETING_INTEL_REPORT_MAX_BODY_BYTES = 128 * 1024;

/** The two report kinds the generator's secret may write, and no other. */
export const MARKETING_GENERATOR_REPORT_KINDS = ["brief", "market_intel"] as const;
export type MarketingGeneratorReportKind = (typeof MARKETING_GENERATOR_REPORT_KINDS)[number];

/** The audit action of a recorded report (docs/policy/marketing-automation.md §6). */
export const MARKETING_GENERATOR_REPORT_ACTION = "marketing_report.generator_recorded";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const instant = z.string().datetime({ offset: false });
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * The two payloads as types. The schema module declares its payload schemas as
 * plain `z.ZodType` and is watched whole by the webhook fingerprint, so the
 * types are written here and the runtime check is still the schema module's.
 */
type BriefPayload = {
  topicIds: string[];
  claimIds: string[];
  sourceDigests: string[];
};
type MarketIntelPayload = {
  facts: Array<{
    competitorId: string;
    factType: string;
    value: unknown;
    sourceUrl: string;
    checkedAt: string;
  }>;
  unrepresentableFactCount: number;
};
const briefPayload = MARKETING_REPORT_PAYLOAD_SCHEMAS.brief as z.ZodType<BriefPayload>;
const marketIntelPayload = MARKETING_REPORT_PAYLOAD_SCHEMAS.market_intel as z.ZodType<MarketIntelPayload>;

const base = {
  generatorRunId: id,
  reportId: id,
  periodStart: instant,
  periodEnd: instant,
  /**
   * When the service stops waiting, signed with the rest. As for drafts, the
   * database refuses to start a new record that could outlast it and to record
   * one after it; a lost answer is read back by resending the same report.
   */
  deadlineAt: instant,
  provenance: hex64,
};

export const marketingGeneratorReportSchema = z
  .discriminatedUnion("kind", [
    z.object({ ...base, kind: z.literal("brief"), payload: briefPayload }).strict(),
    z
      .object({
        ...base,
        kind: z.literal("market_intel"),
        payload: marketIntelPayload,
        /**
         * Competitors A3 found that the registry may not have, for a person to
         * decide on in Admin (operator decision 2026-10-17). Signed with the
         * rest, stored as proposals, and never a source until approved. Beside
         * the payload rather than in it: the payload schema is the schema
         * module's, which the webhook fingerprint watches.
         */
        competitorCandidates: z.array(marketingCompetitorCandidateSchema).max(MARKETING_COMPETITOR_MAX_CANDIDATES).optional(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (Date.parse(value.periodStart) > Date.parse(value.periodEnd)) {
      context.addIssue({ code: "custom", message: "A report period ends no earlier than it starts" });
    }
    if (value.kind === "market_intel" && value.competitorCandidates) {
      const ids = value.competitorCandidates.map((candidate) => candidate.competitorId);
      if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: "custom", message: "A report proposes each competitor once" });
      }
    }
  });

export type MarketingGeneratorReport = z.infer<typeof marketingGeneratorReportSchema>;

/** A market fact as the schema has it. */
type MarketIntelFact = MarketIntelPayload["facts"][number];

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, inner]) => [key, canonical(inner)]),
    );
  }
  return value;
};

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Everything but the signature, in the order nobody has to agree on. */
const reportBytes = (report: Omit<MarketingGeneratorReport, "provenance">): string =>
  JSON.stringify(
    canonical({
      domain: "marketing-generator-report-submission-v1",
      generatorRunId: report.generatorRunId,
      reportId: report.reportId,
      kind: report.kind,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      deadlineAt: report.deadlineAt,
      payload: report.payload,
      // Absent for a brief and for a report that proposes nothing, so their
      // bytes are what they were before candidates existed.
      competitorCandidates:
        report.kind === "market_intel"
          ? (report as { readonly competitorCandidates?: unknown }).competitorCandidates
          : undefined,
    }),
  );

/** HMAC-SHA256 under the submit secret over the report's canonical bytes. */
export const marketingGeneratorReportProvenance = (
  secret: string,
  report: Omit<MarketingGeneratorReport, "provenance">,
): string => createHmac("sha256", secret).update(reportBytes(report), "utf8").digest("hex");

export const marketingGeneratorReportProvenanceMatches = (
  secret: string,
  report: MarketingGeneratorReport,
): boolean => {
  const expected = Buffer.from(marketingGeneratorReportProvenance(secret, report), "hex");
  const given = Buffer.from(report.provenance, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
};

/** SHA-256 of the bytes the signature covers: what "the same report" means. */
export const marketingGeneratorReportDigest = (report: Omit<MarketingGeneratorReport, "provenance">): string =>
  sha256(reportBytes(report));

/**
 * The key a report is recorded under, derived by the app: a kind, a run and
 * the run's own report id. The generator cannot name another report's key.
 */
export const marketingGeneratorReportKey = (input: {
  readonly kind: MarketingGeneratorReportKind;
  readonly generatorRunId: string;
  readonly reportId: string;
}): string =>
  sha256(
    JSON.stringify(
      canonical({
        domain: "marketing-generator-report-v1",
        kind: input.kind,
        generatorRunId: input.generatorRunId,
        reportId: input.reportId,
      }),
    ),
  );

/** A digest of the signature, for the audit row: the signature itself is not kept. */
export const marketingGeneratorReportProvenanceDigest = (provenance: string): string =>
  sha256(`marketing-generator-report-provenance-v1:${provenance}`);

/**
 * Whether a market fact cites one of the official hosts a person approved for
 * its competitor (`readApprovedMarketingCompetitorHosts`). There is no default:
 * a caller that has not read the registry has no hosts to allow.
 *
 * Hosts are matched exactly, lower case, with no subdomain wildcard: a page on
 * `blog.example.com` is a different host from `example.com`, and an approval
 * that means both names both.
 */
export function marketIntelSourceAllowed(
  fact: Pick<MarketIntelFact, "competitorId" | "sourceUrl">,
  hosts: MarketingCompetitorSourceHosts,
): boolean {
  if (!Object.hasOwn(hosts, fact.competitorId)) return false;
  let host: string;
  try {
    const url = new URL(fact.sourceUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    host = url.hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts[fact.competitorId].some((allowed) => allowed.toLowerCase() === host);
}

/**
 * The payload the app stores: for market facts, only those with an approved
 * source, the rest counted as unrepresentable -- so "nothing was found" and
 * "what was found could not be kept" stay different answers. A brief is stored as sent.
 */
export function marketingGeneratorReportStoredPayload(
  report: MarketingGeneratorReport,
  hosts: MarketingCompetitorSourceHosts,
): { readonly payload: MarketingGeneratorReport["payload"]; readonly droppedFactCount: number } {
  if (report.kind === "brief") return { payload: report.payload, droppedFactCount: 0 };
  const kept = report.payload.facts.filter((fact) => marketIntelSourceAllowed(fact, hosts));
  const dropped = report.payload.facts.length - kept.length;
  return {
    payload: {
      facts: kept,
      unrepresentableFactCount: report.payload.unrepresentableFactCount + dropped,
    },
    droppedFactCount: dropped,
  };
}
