/**
 * The analysis plan names its units by local id (`c0:card-1`), and the
 * analysis prompt tells the model to name the Task an investigation hands its
 * result to by that id (ideaAnalysisPromptCore.ts). The id means something
 * only inside the plan: once the cards are registered, a criterion that says
 * "import c0:card-1's exported constants" reaches the worker, the code review
 * and the Decision Maker with nothing that says which card that is. AMUX-CRAWL-003
 * and AMUX-PUBLIC-004 (2026-11-22) both stalled on it: the Decision Maker
 * answered that "the c0:card-2 list" was not in its workspace.
 *
 * Every reader that hands a card's text on resolves the ids to the registered
 * cards' numbers here. The sealed body is not rewritten -- its digest binds
 * the approved text -- and a card registered later is picked up on the next
 * read. An id with no registered card is left as written.
 *
 * Pure.
 */

/** A card's local id as the analysis chunk parser admits it (ideaAnalysisChunkCore.ts). */
const PLAN_CARD_REF = /(?<![A-Za-z0-9_:-])c(?:0|[1-9][0-9]*):card-(?:0|[1-9][0-9]{0,3})(?![A-Za-z0-9_-])/g;

/** Local id -> what a reader calls the registered card (its number, else its Task ID). */
export type AmuxPlanCardRefs = ReadonlyMap<string, string>;

export const EMPTY_AMUX_PLAN_CARD_REFS: AmuxPlanCardRefs = new Map();

/** Whether a text names any plan card by local id. */
export const mentionsAmuxPlanCardRef = (text: string) => {
  PLAN_CARD_REF.lastIndex = 0;
  return PLAN_CARD_REF.test(text);
};

/** The text with every local card id that names a registered card replaced by that card's number. */
export function resolveAmuxPlanCardRefs(text: string, refs: AmuxPlanCardRefs): string {
  if (refs.size === 0) return text;
  return text.replace(PLAN_CARD_REF, (ref) => refs.get(ref) ?? ref);
}

/** As `resolveAmuxPlanCardRefs`, over a list of texts. */
export const resolveAmuxPlanCardRefList = (texts: readonly string[], refs: AmuxPlanCardRefs) =>
  texts.map((text) => resolveAmuxPlanCardRefs(text, refs));

/** The map a reader uses, from the registration rows of one idea. */
export function amuxPlanCardRefsOf(rows: ReadonlyArray<{ localRef: string | null;
  displayKey: string | null; workItemId: string | null }>): AmuxPlanCardRefs {
  const refs = new Map<string, string>();
  for (const row of rows) {
    if (!row.localRef || !row.workItemId) continue;
    refs.set(row.localRef, row.displayKey ?? row.workItemId);
  }
  return refs;
}
