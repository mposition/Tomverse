import "server-only";

import { amuxDmOwnerSettlementRemakeRequestId } from "./dmOwnerSettlementCore.ts";
import { AMUX_SESSION_INTAKE_READBACK_ENV, amuxSessionIntakeReadbackEnabled } from
  "./ideaSessionIntakeReadbackCore.ts";
import {
  AMUX_SESSION_INTAKE_ENV, amuxIdeaSessionPrewriteStatus, amuxSessionIntakeWritePermitted,
  inspectAmuxIdeaSessionSubmission,
} from "./ideaSessionSubmissionCore.ts";
import {
  AmuxIdeaSessionSubmissionError, readAmuxIdeaSessionSubmissionRequest, submitAmuxIdeaFromSession,
} from "./ideaSessionSubmissionService.ts";
import { AMUX_V4_IDEA_READBACK_ENV, AMUX_V4_IDEA_SUBMISSION_ENV } from "./ideaSubmissionCore.ts";

/**
 * The new idea a remake files (owner decision 2026-11-13), through the same
 * session intake the Admin idea form and a coding session use
 * (submitAmuxIdeaFromSession): analysed, carded and run like any other, its
 * analysis inside the operating scope's own budget. It names this repository,
 * as an idea the owner sends from another Admin screen does (ideaSendPath.ts),
 * and its encrypted source labels say the Decision Maker wrote it.
 *
 * Filed before the cards close, so a closed card always has its idea: the
 * request id is derived from the settlement and the text, a lost answer is
 * read back and never filed twice, and an outcome nobody knows is left for
 * the next tick's read-back. If a person settles the card in between, the idea
 * stays filed and the settlement names it as cancelled.
 */

const REPOSITORY = "mposition/Tomverse";

export type AmuxDmOwnerSettlementRemakeFiling =
  | { ideaId: string } | { refused: string } | { pending: true };

export async function fileAmuxDmOwnerSettlementRemakeIdea(input: {
  settlementId: string; ideaText: string;
}): Promise<AmuxDmOwnerSettlementRemakeFiling> {
  if (!amuxSessionIntakeWritePermitted(process.env[AMUX_SESSION_INTAKE_ENV],
      process.env[AMUX_V4_IDEA_SUBMISSION_ENV]) ||
      !amuxSessionIntakeReadbackEnabled(process.env[AMUX_SESSION_INTAKE_READBACK_ENV],
        process.env[AMUX_V4_IDEA_READBACK_ENV])) return { refused: "intake_disabled" };
  const requestId = amuxDmOwnerSettlementRemakeRequestId(input.settlementId, input.ideaText);
  const seen = await readAmuxIdeaSessionSubmissionRequest(requestId);
  if (seen.status === "committed") return { ideaId: seen.ideaId };
  if (seen.status === "partial") return { pending: true };
  const inspected = inspectAmuxIdeaSessionSubmission({ version: 1, requestId,
    input: { version: 1, idea: input.ideaText, repositories: [REPOSITORY], pullRequests: [] },
    source: { toolName: "tomverse-amux-decision-maker", modelProvider: "decision-maker",
      sessionDisplay: "Decision Maker remake of a stopped card" } });
  if (!inspected.ok) return { refused: "idea_refused" };
  try {
    return { ideaId: (await submitAmuxIdeaFromSession({ inspected })).ideaId };
  } catch (error) {
    if (error instanceof AmuxIdeaSessionSubmissionError) {
      if (error.code === "request_already_seen" && error.readBack === "committed" && error.ideaId)
        return { ideaId: error.ideaId };
      if (amuxIdeaSessionPrewriteStatus(error.code) !== undefined) return { refused: "idea_refused" };
    }
    // Unknown: the next tick reads the request back before anything is filed again.
    return { pending: true };
  }
}
