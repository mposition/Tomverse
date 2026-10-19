import { discoverAmuxV19MaxSessionAnalysisOnce } from
  "./ideaLocalSessionAnalysisQueueDiscovery.mjs";
import { amuxV19QueueCursorState } from
  "./ideaLocalSessionQueueCursorState.mjs";

/** One read-only Max timer tick. The local cursor is only a pagination hint;
 * no claim, checkout or paid CLI call occurs in this step. */
export async function runAmuxV19MaxSessionQueueEntryOnce(input) {
  const state = amuxV19QueueCursorState(input.stateDirectory);
  let after;
  try { after = await state.read(); }
  catch (error) {
    if (error.code !== "v19_queue_cursor_corrupt") throw error;
    await state.clear();
    return { kind: "unavailable" };
  }
  const result = await discoverAmuxV19MaxSessionAnalysisOnce({
    ...input, after });
  if (result.kind === "cursor_rejected") {
    if (after !== null) await state.clear();
    return { kind: "unavailable" };
  }
  if (result.kind === "more_unexamined") await state.save(result.after);
  else if (["discovered", "idle", "catalog_unapproved", "disabled",
      "price_unavailable"].includes(result.kind)) await state.clear();
  return result.kind === "discovered"
    ? { kind: "discovered", candidate: result.candidate,
      price: result.price }
    : { kind: result.kind };
}
