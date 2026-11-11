/**
 * A T2 draft put to the Decision Maker for advice (operator, 2026-11-11: the
 * owner queue must show what the reviewers -- the Decision Maker included --
 * said before a person decides). A T2 patch is one the agent may not publish
 * (docs/policy/engineering-agent.md §7); a person approves or rejects it in Admin. The relay files the
 * draft as a typed-ask card on the same tick as a v22 result review, and the
 * Decision Maker's answer is shown beside the draft. It is advice: nothing
 * reads it to approve, reject or apply anything.
 *
 * Pure: the switch, and the card's words.
 */

import { engineeringAgentPatchFiles } from "./engineeringAgentOwnerItemContextCore.ts";

/** Default off. Filing a card starts a Decision Maker turn. */
export const ENGINEERING_AGENT_T2_DM_REVIEW_ENV = "TOMVERSE_ENGINEERING_AGENT_T2_DM_REVIEW";

export const engineeringAgentT2DmReviewEnabled = (env: Record<string, string | undefined> = process.env) =>
  env[ENGINEERING_AGENT_T2_DM_REVIEW_ENV] === "enabled";

/** The session name the relay files the card under: no worker session asks it. */
export const ENGINEERING_AGENT_T2_DM_WORKER = "engineering-t2-review";
/** As the v22 result review: `claude` routes to `decision-maker-openai`. */
export const ENGINEERING_AGENT_T2_DM_PROVIDER = "claude";
/** The relay's typed-ask question limit, as every other card's. */
export const ENGINEERING_AGENT_T2_DM_QUESTION_MAX = 2_000;
const TITLE_MAX = 200;

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

/** Splits a patch into its per-file sections, whole. */
function patchSections(patch: string): string[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const sections: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ") || sections.length === 0) sections.push([]);
    sections[sections.length - 1].push(line);
  }
  return sections.map((section) => section.join("\n").trimEnd()).filter((section) => section.startsWith("diff --git "));
}

/**
 * The card the relay files, in the shape of a v22 question's pending entry,
 * or null when there is no patch to show. The draft's files are always listed;
 * each file's diff follows whole while the card has room, and the card says
 * how many were left out, so the advice never reads as a judgment of the
 * whole patch when it saw part of it.
 */
export function engineeringAgentT2DmCard(input: {
  workItemId: string;
  cardLabel: string;
  reason: string | null;
  patchBody: string | null;
}) {
  if (!input.patchBody) return null;
  const files = engineeringAgentPatchFiles(input.patchBody);
  if (files.length === 0) return null;
  const head = [
    "An engineering agent patch waits for the owner. The agent may not open a pull request for it on its own; a person approves it to apply by hand, or rejects it.",
    `Card: ${input.cardLabel}`,
    `Why it waits: ${(input.reason && ENGINEERING_AGENT_T2_DM_REASON_TEXT[input.reason]) || OTHER_REASON}.`,
    `Files (${files.length}):`,
    ...files.map((file) => `- ${file.path} (+${file.added} -${file.removed})`),
  ];
  const tail = [
    "Your answer is advice shown beside the patch; it applies nothing.",
    "Should a person apply this patch by hand, or reject it? Say why in one or two sentences.",
  ];
  const fixed = [...head, ...tail].join("\n");
  if (fixed.length > ENGINEERING_AGENT_T2_DM_QUESTION_MAX) return null;
  const shown: string[] = [];
  let left = ENGINEERING_AGENT_T2_DM_QUESTION_MAX - fixed.length - 80;
  const sections = patchSections(input.patchBody);
  for (const section of sections) {
    if (section.length + 1 > left) break;
    shown.push(section);
    left -= section.length + 1;
  }
  const omitted = sections.length - shown.length;
  const body = [
    ...head,
    shown.length > 0 ? "Patch:" : "The patch does not fit this card; judge it from the file list.",
    ...shown,
    ...(shown.length > 0 && omitted > 0 ? [`(${omitted} more file diffs are not shown.)`] : []),
    ...tail,
  ].join("\n");
  if (body.length > ENGINEERING_AGENT_T2_DM_QUESTION_MAX) return null;
  return {
    question_id: input.workItemId,
    worker: ENGINEERING_AGENT_T2_DM_WORKER,
    provider: ENGINEERING_AGENT_T2_DM_PROVIDER,
    title: `Patch review: ${input.cardLabel}`.slice(0, TITLE_MAX),
    question: body,
    unblocks: "The owner reads this advice beside the patch before deciding it; the answer changes nothing by itself.",
    options: [
      { id: "apply", label: "A person should apply it by hand" },
      { id: "reject", label: "Reject it" },
    ],
  };
}
