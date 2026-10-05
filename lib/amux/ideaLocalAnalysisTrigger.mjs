const VERIFIED_TERMINAL = new Set([
  "idle", "draft_ready", "provider_failed", "disabled", "catalog_unapproved",
  // Queue polling is metadata-only. No claim or provider call can precede it.
  "unavailable", "refused",
]);

/** A durable marker is claimed before queue access. Unknown claim/result
 * outcomes and process crashes leave it in place; an operator must reconcile
 * the app receipt before clearing it. */
export async function runAmuxV4LocalAnalysisTrigger(run, state) {
  if (typeof run !== "function" || !state ||
      typeof state.claim !== "function" ||
      typeof state.release !== "function") return { kind: "refused" };
  if (!(await state.claim())) return { kind: "halted" };
  let result;
  try { result = await run(); }
  catch { return { kind: "outcome_unknown" }; }
  if (VERIFIED_TERMINAL.has(result?.kind)) await state.release();
  return result && typeof result.kind === "string" ? result :
    { kind: "outcome_unknown" };
}
