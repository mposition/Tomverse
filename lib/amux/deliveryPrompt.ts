import { boardPromotionExecutionBriefDigest } from "./boardPromotionCore.ts";

const TITLE_BYTE_CEILING = 4 * 1_024;
const DESCRIPTION_BYTE_CEILING = 64 * 1_024;
const PROMPT_BYTE_CEILING = 96 * 1_024;

export type ApprovedExecutionBrief =
  | { state: "absent" }
  | { state: "verified"; brief: string; digest: string }
  | { state: "unverified" };

/**
 * The stored digest is the promotion digest of the exact brief bytes.
 * One side of the pair, a blank brief, or a different digest is not an
 * approved instruction.
 */
export const classifyApprovedExecutionBrief = (
  brief: string | null,
  digest: string | null,
): ApprovedExecutionBrief => {
  if (brief === null && digest === null) return { state: "absent" };
  if (brief === null || digest === null || !/\S/.test(brief)) {
    return { state: "unverified" };
  }
  const computed = boardPromotionExecutionBriefDigest(brief);
  if (computed !== digest) return { state: "unverified" };
  return { state: "verified", brief, digest };
};

/**
 * How the worker closes its local card. Tomverse reads only that card's
 * status (policy version 15): done or verified settles the attempt to review,
 * discarded, cancelled or quarantined settles it to blocked, and anything else
 * is still in progress. Without these lines the first claim-only run left its
 * card in backlog "waiting on CI" with the pull request open and green, and
 * the attempt stayed live until its lease expired (2026-09-29).
 */
export const AMUX_DELIVERY_COMPLETION_RULES = [
  "How to finish:",
  "- When the pull request is open and its required checks pass, set this card to done. Put the pull request URL in the card.",
  "- If you cannot finish, set this card to discarded and say why in the card.",
  "- Do not leave this card in backlog or waiting. Tomverse treats any other status as still running.",
  "- Do not merge the pull request. A person reviews and merges it.",
] as const;

export const buildAmuxDeliveryPrompt = (input: {
  taskId: string;
  title: string;
  description: string | null;
  kind: string;
  priority: string;
  worker: string;
  attemptId: string;
  attemptNumber: number;
  taskRevision: number;
  executionBrief: string | null;
  executionBriefDigest: string | null;
  previousAttempt: {
    outcome: string | null;
    toStatus: string | null;
  } | null;
}) => {
  const approved = classifyApprovedExecutionBrief(
    input.executionBrief,
    input.executionBriefDigest,
  );
  if (approved.state === "unverified") {
    throw new Error("AMUX delivery brief is unverified");
  }
  if (
    Buffer.byteLength(input.title, "utf8") > TITLE_BYTE_CEILING ||
    Buffer.byteLength(input.description ?? "", "utf8") > DESCRIPTION_BYTE_CEILING ||
    (approved.state === "verified" &&
      Buffer.byteLength(approved.brief, "utf8") > DESCRIPTION_BYTE_CEILING)
  ) {
    throw new Error("AMUX delivery source exceeds byte ceiling");
  }

  const description = input.description?.trim() || "(no description)";
  const reportedOutcome = input.previousAttempt?.outcome;
  const previousOutcome =
    reportedOutcome === "succeeded" ||
    reportedOutcome === "failed" ||
    reportedOutcome === "blocked" ||
    reportedOutcome === "expired"
      ? reportedOutcome
      : "unknown";
  const reportedStatus = input.previousAttempt?.toStatus;
  const previousStatus =
    reportedStatus === "todo" ||
    reportedStatus === "review" ||
    reportedStatus === "done" ||
    reportedStatus === "blocked" ||
    reportedStatus === "cancelled"
      ? reportedStatus
      : "unknown";
  const briefText = approved.state === "verified" ? approved.brief : "(none)";
  const briefDigest = approved.state === "verified" ? approved.digest : "none";

  const prompt = [
    "[Tomverse AMUX work]",
    `Task: ${input.taskId}`,
    `Title: ${input.title}`,
    `Kind: ${input.kind}`,
    `Priority: ${input.priority}`,
    `Worker: ${input.worker}`,
    `Execution attempt: ${input.attemptId}`,
    `Attempt number: ${input.attemptNumber}`,
    `Task revision: ${input.taskRevision}`,
    `Approved execution brief digest: ${briefDigest}`,
    ...(input.previousAttempt
      ? [
          `Previous outcome: ${previousOutcome}`,
          `Previous status: ${previousStatus}`,
        ]
      : []),
    "",
    ...AMUX_DELIVERY_COMPLETION_RULES,
    "",
    "Approved execution brief:",
    briefText,
    "",
    "Card description:",
    description,
  ].join("\n");
  if (Buffer.byteLength(prompt, "utf8") > PROMPT_BYTE_CEILING) {
    throw new Error("AMUX delivery envelope exceeds byte ceiling");
  }
  return prompt;
};
