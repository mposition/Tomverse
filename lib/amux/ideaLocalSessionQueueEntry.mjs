import { discoverAmuxV19SessionAnalysisOnce } from
  "./ideaLocalSessionAnalysisQueueDiscovery.mjs";
import { amuxV19QueueCursorState } from
  "./ideaLocalSessionQueueCursorState.mjs";
import { readAmuxV19SessionReferencePin } from
  "./ideaLocalSessionReferencePinRead.mjs";

/** One timer tick. The cursor survives process exits only when this bounded
 * read-only pass has more pages; no queue identity enters the journal. */
export async function runAmuxV19SessionQueueEntryOnce(input) {
  const state = amuxV19QueueCursorState(input.stateDirectory);
  let after;
  try { after = await state.read(); }
  catch (error) {
    if (error.code !== "v19_queue_cursor_corrupt") throw error;
    await state.clear();
    return { kind: "unavailable" };
  }
  const result = await discoverAmuxV19SessionAnalysisOnce({ ...input, after,
    preflightCandidate: (candidate) => readAmuxV19SessionReferencePin({
      origin: input.origin, agentSecret: input.agentSecret,
      reservationId: candidate.reservationId,
      ideaId: candidate.ideaId, referenceOrdinal: 0,
      fetchImpl: input.fetchImpl ?? fetch,
    }),
  });
  if (result.kind === "cursor_rejected") {
    if (after !== null) await state.clear();
    return { kind: "unavailable" };
  }
  if (result.kind === "more_unexamined") await state.save(result.after);
  else if (["discovered", "idle", "catalog_unapproved", "disabled",
      "pin_unavailable"].includes(
      result.kind))
    await state.clear();
  return result.kind === "discovered"
    ? { kind: "discovered", candidate: result.candidate, pin: result.pin }
    : { kind: result.kind };
}
