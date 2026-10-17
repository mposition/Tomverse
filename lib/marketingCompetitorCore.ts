/**
 * The competitor registry's shapes and rules, pure (S3 plan, S3f; operator
 * decision 2026-10-17). The database enforces the same rules
 * (prisma/migrations/20261017120000_marketing_competitor_registry); these let
 * a caller refuse a bad request before it reaches a transaction, and give the
 * generator's report route one schema for the candidates A3 proposes.
 */

import { z } from "zod";

/** The audit actions a registry change is recorded under. */
export const MARKETING_COMPETITOR_ACTIONS = {
  proposed: "marketing_competitor.proposed",
  approved: "marketing_competitor.approved",
  rejected: "marketing_competitor.rejected",
  retired: "marketing_competitor.retired",
} as const;

export const MARKETING_COMPETITOR_STATUSES = ["proposed", "approved", "rejected", "retired"] as const;
export type MarketingCompetitorStatus = (typeof MARKETING_COMPETITOR_STATUSES)[number];

/** Who put a row in the registry: A3, a person in Admin, or the first migration. */
export const MARKETING_COMPETITOR_PROPOSERS = ["generator", "operator", "seed"] as const;

/** Candidates one generator report may propose. */
export const MARKETING_COMPETITOR_MAX_CANDIDATES = 5;

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u;

export const marketingCompetitorIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
export const marketingCompetitorHostSchema = z
  .string()
  .max(253)
  .transform((host) => host.trim().toLowerCase())
  .refine((host) => HOST.test(host), "an official host is a lower-case host name with a dot");
export const marketingCompetitorHostsSchema = z
  .array(marketingCompetitorHostSchema)
  .min(1)
  .max(10)
  .transform((hosts) => [...new Set(hosts)].sort());
export const marketingCompetitorDisplayNameSchema = z.string().trim().min(1).max(80);

/**
 * A competitor A3 proposes: who, which hosts it believes are official, where
 * it saw them, and why it thinks the competitor matters. All of it is data: a
 * person reads it in Admin, and none of it is trusted until they approve.
 */
export const marketingCompetitorCandidateSchema = z
  .object({
    competitorId: marketingCompetitorIdSchema,
    displayName: marketingCompetitorDisplayNameSchema,
    officialHosts: marketingCompetitorHostsSchema,
    evidenceUrls: z
      .array(z.string().max(500).refine((url) => url.startsWith("https://"), "evidence is an https URL"))
      .max(5),
    rationale: z.string().trim().min(1).max(400),
  })
  .strict();
export type MarketingCompetitorCandidate = z.infer<typeof marketingCompetitorCandidateSchema>;

/** Approved competitor id -> its official hosts: the only sources a market fact may cite. */
export type MarketingCompetitorSourceHosts = Readonly<Record<string, readonly string[]>>;
