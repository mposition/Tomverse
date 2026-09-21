/**
 * Server-owned inputs to the marketing Guard that are not derivable from a
 * draft or a fact registry.
 *
 * Contract: docs/policy/marketing-automation.md §7.2 and §7.4, and the S1
 * plan's alert-delivery amendment. S1 has no alert delivery and no approved
 * readers for the three prose categories, so each answer is pinned closed.
 * Adding a reader is an S2/S3 change here, not a boolean at a Guard call site.
 */

import "server-only";

import {
  sealMarketingGuardContext,
  type MarketingGuardContext,
} from "@/lib/marketingGuardCore";

/** Resolve the complete context. A caller supplies no answers. */
export function resolveMarketingGuardContext(): MarketingGuardContext {
  return sealMarketingGuardContext({
    priceFallbackAlertReady: false,
    incidentOrSecurity: "unreadable",
    testimonial: "unreadable",
    legalOrPolicy: "unreadable",
  });
}
