/**
 * A T2 draft put to the Decision Maker for advice (operator, 2026-11-11: the
 * owner queue must show what the reviewers -- the Decision Maker included --
 * said before a person decides). A T2 patch is one the agent may not publish
 * (docs/policy/engineering-agent.md §7); a person approves or rejects it in Admin. The relay files the
 * draft as a typed-ask card on the same tick as a v22 result review, and the
 * Decision Maker's answer is shown beside the draft. It is advice: nothing
 * reads it to approve, reject or apply anything.
 *
 * Owner decision 2026-11-15: the Decision Maker reads the patch whole, in its
 * workspace (evidence/PATCH.diff, the commit the patch was made on as repo/,
 * and that commit with the patch applied as repo-patched/;
 * lib/amux/decisionMakerWorkspaceCore.ts). The card lists the files and points
 * there; nothing is cut to fit a card.
 *
 * Pure: the switch, and the card's words.
 */

import { repositoryPathRefusal } from "./amux/decisionMakerCore.ts";
import { dmCardEvidenceContext } from "./amux/decisionMakerWorkspaceCore.ts";
import { engineeringAgentPatchFiles } from "./engineeringAgentOwnerItemContextCore.ts";

/**
 * Filing a card starts a Decision Maker turn. On unless exactly `disabled`
 * (owner decision 2026-11-15: the switches that make the Decision Maker work
 * default on, and are kill switches).
 */
export const ENGINEERING_AGENT_T2_DM_REVIEW_ENV = "TOMVERSE_ENGINEERING_AGENT_T2_DM_REVIEW";

export const engineeringAgentT2DmReviewEnabled = (env: Record<string, string | undefined> = process.env) =>
  env[ENGINEERING_AGENT_T2_DM_REVIEW_ENV]?.trim() !== "disabled";

/** The session name the relay files the card under: no worker session asks it. */
export const ENGINEERING_AGENT_T2_DM_WORKER = "engineering-t2-review";
/** As the v22 result review: `claude` routes to `decision-maker-openai`. */
export const ENGINEERING_AGENT_T2_DM_PROVIDER = "claude";

/** One fixed sentence per reason the draft waits. None may hit the routing
 * term list on its own (tests/engineeringAgentT2DmReview.test.mjs). */
export const ENGINEERING_AGENT_T2_DM_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  tier_two: "its change reaches files the agent may not change on its own",
  tier_pending: "its tier was not judged yet",
  tier_evidence_unavailable: "the evidence for its tier could not be read",
  patch_unavailable: "its patch could not be read again for the tier",
  publication_not_authorized: "opening its pull request was not allowed",
  publication_state_changed: "its card changed before its pull request could open",
  publish_refused: "opening its pull request was refused",
});
const OTHER_REASON = "it was kept for a person";

/** The repository paths a patch touches, as a card's context paths (hints for the workspace). */
export const patchContextPaths = (patch: string): string[] =>
  [...new Set(engineeringAgentPatchFiles(patch).map((file) => file.path))].filter((path) => repositoryPathRefusal(path) === null);

/**
 * The card the relay files, in the shape of a v22 question's pending entry,
 * or null when there is no patch to show. The question lists the draft's
 * files; the patch itself is in the workspace, whole (or, with the workspace
 * switched off, in the card's context, whole).
 */
export function engineeringAgentT2DmCard(input: {
  workItemId: string;
  cardLabel: string;
  reason: string | null;
  patchBody: string | null;
  /** Whether the Decision Maker has a workspace; the switch decides by default. */
  workspace?: boolean;
}) {
  if (!input.patchBody) return null;
  const files = engineeringAgentPatchFiles(input.patchBody);
  if (files.length === 0) return null;
  const question = [
    "An engineering agent patch waits for the owner. The agent may not open a pull request for it on its own; a person approves it to apply by hand, or rejects it.",
    `Card: ${input.cardLabel}`,
    `Why it waits: ${(input.reason && ENGINEERING_AGENT_T2_DM_REASON_TEXT[input.reason]) || OTHER_REASON}.`,
    `Files (${files.length}):`,
    ...files.map((file) => `- ${file.path} (+${file.added} -${file.removed})`),
    "Your answer is advice shown beside the patch; it applies nothing.",
    "Should a person apply this patch by hand, or reject it? Say why in one or two sentences.",
  ].join("\n");
  return {
    question_id: input.workItemId,
    worker: ENGINEERING_AGENT_T2_DM_WORKER,
    provider: ENGINEERING_AGENT_T2_DM_PROVIDER,
    title: `Patch review: ${input.cardLabel}`,
    question,
    context: dmCardEvidenceContext([{ name: "PATCH.diff", heading: "The patch", text: input.patchBody }], input.workspace),
    context_paths: patchContextPaths(input.patchBody),
    unblocks: "The owner reads this advice beside the patch before deciding it; the answer changes nothing by itself.",
    options: [
      { id: "apply", label: "A person should apply it by hand" },
      { id: "reject", label: "Reject it" },
    ],
  };
}
