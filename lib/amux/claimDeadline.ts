import "server-only";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";

// Admission, body parsing, authoritative snapshot, claim/refusal and their
// commit fences share one database-clock deadline. The Rust claim request
// budget separately reserves bounded connect and network response time.
export const AMUX_CLAIM_ROUTE_BUDGET_MS = 12_000;

/** Anchor the route's absolute deadline before reading authenticated input. */
export const anchorAmuxClaimDeadline = async (): Promise<void> => {
  await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.claimRouteClock, async () => {});
};
