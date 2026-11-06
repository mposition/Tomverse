import { createHash } from "node:crypto";

import type { IdeaInput } from "./ideaInputCore.ts";
import { inspectAmuxIdeaSessionSubmission, type AmuxIdeaSessionSource } from
  "./ideaSessionSubmissionCore.ts";

/** The owner's resubmit, audited on the old idea before it is closed. */
export const AMUX_IDEA_RESUBMIT_ACTION = "amux.idea.session_resubmitted";

/** Labels of a resubmitted idea: the owner's click in its Admin detail. */
export const AMUX_IDEA_RESUBMIT_SOURCE: AmuxIdeaSessionSource = Object.freeze({
  toolName: "tomverse-admin", modelProvider: "operator", sessionDisplay: "Admin resubmit" });

/**
 * The request id of an idea's one resubmission: a UUID v4 derived from the
 * old idea's id, so a second click, a second tab or a lost response is the
 * same request and the intake takes it once. Anyone holding the old id can
 * find the new idea by it; the old idea's own request id is never reused.
 */
export function amuxIdeaResubmitRequestId(previousIdeaId: string): string {
  const bytes = createHash("sha256").update(`amux-idea-resubmit:${previousIdeaId}`)
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The resubmission the intake receives: the same idea and references under
 * the resubmit labels. Today's content rules apply, as for any new idea. */
export function inspectAmuxIdeaResubmission(requestId: string, input: IdeaInput) {
  return inspectAmuxIdeaSessionSubmission({ version: 1, requestId,
    input: { version: 1, idea: input.idea, repositories: [...input.repositories],
      pullRequests: input.pullRequests.map((pull) => ({ ...pull })) },
    source: { ...AMUX_IDEA_RESUBMIT_SOURCE } });
}

export type AmuxIdeaResubmitRefusal = "not_found" | "not_resubmittable" | "raw_purged";

export type AmuxIdeaResubmitOutcome =
  | { result: "resubmitted"; ideaId: string; requestId: string; previousClosed: boolean }
  | { result: AmuxIdeaResubmitRefusal }
  | { result: "refused"; code: string }
  | { result: "outcome_unknown" };

type ReadBack = { status: "absent" } | { status: "partial" | "committed"; ideaId: string };

export type AmuxIdeaResubmitSteps = {
  /** The intake's read of a request id. */
  readBack: (requestId: string) => Promise<ReadBack>;
  /** The old idea's sealed input, when it can still be resubmitted. */
  readInput: (previousIdeaId: string) => Promise<
    { ok: true; input: IdeaInput } | { ok: false; reason: AmuxIdeaResubmitRefusal }>;
  /** One intake write; a refusal before anything was written is returned, any
   * other failure throws and is read back. */
  submit: (requestId: string, input: IdeaInput) => Promise<
    { ideaId: string } | { refused: string }>;
  /** The owner close of the old idea; true when it is closed. */
  close: (previousIdeaId: string, ideaId: string) => Promise<boolean>;
};

/**
 * Read back, then read the old idea, submit, and only after the new idea is
 * known to be committed close the old one. A write whose outcome is unknown is
 * read back by its request id and never sent again from here; a repeat click
 * finds the committed idea by the same id and only finishes the close.
 */
export async function runAmuxIdeaResubmit(steps: AmuxIdeaResubmitSteps,
  previousIdeaId: string): Promise<AmuxIdeaResubmitOutcome> {
  const requestId = amuxIdeaResubmitRequestId(previousIdeaId);
  let seen = await steps.readBack(requestId);
  if (seen.status === "absent") {
    const read = await steps.readInput(previousIdeaId);
    if (!read.ok) return { result: read.reason };
    try {
      const submitted = await steps.submit(requestId, read.input);
      if ("refused" in submitted) return { result: "refused", code: submitted.refused };
      seen = { status: "committed", ideaId: submitted.ideaId };
    } catch {
      // Absence after a failed write is not proof that nothing committed.
      try { seen = await steps.readBack(requestId); } catch { seen = { status: "absent" }; }
      if (seen.status === "absent") return { result: "outcome_unknown" };
    }
  }
  if (seen.status !== "committed") return { result: "outcome_unknown" };
  let previousClosed = false;
  try { previousClosed = await steps.close(previousIdeaId, seen.ideaId); }
  catch { previousClosed = false; }
  return { result: "resubmitted", ideaId: seen.ideaId, requestId, previousClosed };
}
