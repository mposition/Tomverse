const SUCCESS = new Set(["idle", "discovered", "disabled",
  "catalog_unapproved", "more_unexamined"]);
const REPORTED = new Set([...SUCCESS, "price_unavailable", "unavailable",
  "refused", "cursor_rejected"]);

/** Never let candidate IDs, prices, or arbitrary response fields reach logs. */
export function amuxV19MaxQueueStatus(result) {
  const kind = REPORTED.has(result?.kind) ? result.kind : "unavailable";
  return Object.freeze({ line: `AMUX_V19_MAX_SESSION_QUEUE_${kind}\n`,
    exitCode: SUCCESS.has(kind) ? 0 : 1 });
}
