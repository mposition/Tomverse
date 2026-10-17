/**
 * Server-owned inputs to the marketing Guard that are not derivable from a
 * draft or a fact registry.
 *
 * Contract: docs/policy/marketing-automation.md §7.2 and §7.4, and the S1
 * plan's alert-delivery amendment. The price alert is read from its delivery
 * path (S3d: the operational alert has a recipient). There are no approved
 * readers for the three prose categories, so each of those stays closed.
 * Adding a reader is a change here, not a boolean at a Guard call site.
 */

import "server-only";

import {
  sealMarketingGuardContext,
  type MarketingGuardContext,
} from "@/lib/marketingGuardCore";
import { marketingPriceAlertReady } from "@/lib/marketingPriceAlertCore";

/** Resolve the complete context. A caller supplies no answers. */
export function resolveMarketingGuardContext(): MarketingGuardContext {
  return sealMarketingGuardContext({
    priceFallbackAlertReady: marketingPriceAlertReady(),
    incidentOrSecurity: "unreadable",
    testimonial: "unreadable",
    legalOrPolicy: "unreadable",
  });
}
