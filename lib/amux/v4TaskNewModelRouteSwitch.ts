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
