/**
 * Owner decision 2026-11-14: a worker on a model the Task's approved cost
 * receipt did not name may run the Task without reconfirmation when its own
 * cost stays within the approved ceiling and the token bounds did not grow
 * (checkV4TaskApprovedCeiling). Default off; the owner enables it in
 * production. Readiness, claim and execution start all read this one switch so
 * a Task that reads ready is also one a worker may claim and start.
 */
export const AMUX_V4_NEW_MODEL_ROUTE_ENV = "TOMVERSE_AMUX_V4_NEW_MODEL_ROUTE_WITHIN_CEILING";

export const amuxV4NewModelRouteWithinCeiling = (value: string | undefined) => ({
  newModelRouteWithinCeiling: value === "enabled",
});

/**
 * Owner decision 2026-11-15: such a worker may run an already-approved Task
 * even when its own cost is over the approved ceiling, as long as the role,
 * grade and every token and attempt bound are unchanged. The overrun is
 * recorded, never refused (amuxApprovedCeilingOverrun,
 * `v22_approved_ceiling_overrun`). Default off. On 2026-11-14 antigravity-impl
 * (Gemini 4 Argon, $5.90 x 2) was never assigned an advanced Task approved at
 * $8.20 for that reason.
 */
export const AMUX_V4_NEW_MODEL_ROUTE_OVER_CEILING_ENV =
  "TOMVERSE_AMUX_V4_NEW_MODEL_ROUTE_OVER_CEILING";

export const amuxV4NewModelRouteOverCeiling = (value: string | undefined) => ({
  newModelRouteOverCeiling: value === "enabled",
});

/**
 * The route options readiness, claim and execution start each pass to
 * v4TaskReceiptForApprovedRoutes and checkV4TaskApprovedCeiling, so the three
 * reach one conclusion on the same Task. An owner-approved recovery (the
 * read-only API retry, which spends real API money, among them) keeps every
 * cost condition: the over-ceiling switch never applies to it.
 */
export const amuxV4NewModelRouteOptions = (
  env: Readonly<Record<string, string | undefined>>,
  ownerApprovedRecovery: boolean,
) => ({
  ...amuxV4NewModelRouteWithinCeiling(env[AMUX_V4_NEW_MODEL_ROUTE_ENV]),
  newModelRouteOverCeiling: !ownerApprovedRecovery &&
    amuxV4NewModelRouteOverCeiling(env[AMUX_V4_NEW_MODEL_ROUTE_OVER_CEILING_ENV])
      .newModelRouteOverCeiling,
});
