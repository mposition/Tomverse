import { amuxAnalysisAnswerJson } from "./ideaAnalysisChunkCore.ts";

/**
 * A session analysis has one source unit, the operator idea, and no owner to
 * ask, so the page bookkeeping the v4 schema asks the model to fill in carries
 * nothing the app does not already know or cannot read from the answer's
 * content. A slip in it must not cost a whole plan. The app therefore writes
 * those fields itself and the chunk parser still judges every unit and the
 * result: a named remainder or a declared "more" is never dropped, it becomes
 * the next page. The original answer stays sealed as the result evidence.
 */
export const AMUX_SESSION_PAGE_NOTE = `This session analysis has exactly one source unit, the operator idea, so there is never a next source unit: use continuationKind input only together with an ownerQuestion. When more cards remain, use coverageStatus more and continuationKind output, and name them in remainingScope. When none remain, use coverageStatus complete with continuationKind and remainingScope null. A continuation page that finds nothing left to propose closes the plan with outcome propose, coverageStatus complete and an empty units array; do not invent a card to fill it.`;

const UNNAMED_REMAINDER = "The previous page declared more work without naming it.";

const filled = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/** The owner question an answer ends on, if any. A question beside a real
 * proposal is not one: with no owner present the proposal stands on its stated
 * assumptions (v19 item 4). */
export function amuxSessionAnswerQuestion(answer: Record<string, unknown>): string | null {
  const question = filled(answer.ownerQuestion);
  return question !== null && (answer.outcome === "needs_information" ||
    answer.coverageStatus === "needs_owner_input" ||
    (Array.isArray(answer.units) && answer.units.length === 0)) ? question : null;
}

const OUTCOMES: readonly unknown[] = ["propose", "needs_information", "reject"];
const STATUSES: readonly unknown[] = ["complete", "more", "needs_owner_input"];

/** The answer with its page bookkeeping derived from its content. Anything the
 * app cannot read a decision from is returned as it came, for the parser to
 * refuse with its own rule. */
export function normalizeAmuxSessionAnswer(raw: string, expected: {
  schemaVersion: number; previewId: string; chunkIndex: number; continuing: boolean;
}): string {
  let parsed: unknown;
  try { parsed = amuxAnalysisAnswerJson(raw); } catch { return raw; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
  const answer = parsed as Record<string, unknown>;
  const { outcome, coverageStatus, units } = answer;
  if (!OUTCOMES.includes(outcome) || !STATUSES.includes(coverageStatus) ||
      !Array.isArray(units)) return raw;
  const question = amuxSessionAnswerQuestion(answer);
  const remainder = filled(answer.remainingScope);
  const page = (fields: { outcome: string; coverageStatus: string;
    continuationKind: string | null; ownerQuestion: string | null;
    remainingScope: string | null }) => JSON.stringify({
    schemaVersion: expected.schemaVersion, previewId: expected.previewId,
    chunkIndex: expected.chunkIndex,
    coveredScope: filled(answer.coveredScope) ?? answer.coveredScope,
    units, ...fields });

  if (question !== null) {
    // A later page must disclose what the question leaves unfinished.
    const open = remainder ?? (expected.continuing ? UNNAMED_REMAINDER : null);
    return page({ outcome: "needs_information", coverageStatus: "needs_owner_input",
      continuationKind: open === null ? null : "input", ownerQuestion: question,
      remainingScope: open });
  }
  const stops = outcome === "reject" && units.length === 0;
  // A rejection after an output page means nothing was left: it closes the
  // plan. A rejection that still lists units stays one for the parser to refuse.
  const decided = outcome !== "reject" || (stops && expected.continuing)
    ? "propose" : "reject";
  return !stops && (coverageStatus === "more" || remainder !== null)
    ? page({ outcome: decided, coverageStatus: "more", continuationKind: "output",
      ownerQuestion: null, remainingScope: remainder ?? UNNAMED_REMAINDER })
    : page({ outcome: decided, coverageStatus: "complete", continuationKind: null,
      ownerQuestion: null, remainingScope: null });
}

/** How many proposal units the answer holds, read the way the parser reads the
 * answer, so a fenced answer still gets one storage key per unit. */
export function amuxSessionAnswerUnitCount(raw: string): number {
  try {
    const parsed = amuxAnalysisAnswerJson(raw);
    const units = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).units : null;
    return Array.isArray(units) && units.length <= 40 ? units.length : 0;
  } catch { return 0; } // A non-JSON answer is a refused plan, not a failed write.
}
