import { createHash } from "node:crypto";

/**
 * A v22 worker's question to the owner (operator decision 2026-10-30).
 *
 * A v22 run is one CLI invocation with a ten-minute deadline, so it cannot
 * wait for an answer. A run that needs an owner decision ends with one
 * question line instead of guessing. The Task does not go to review: it
 * waits, blocked, until the question is answered (through the Decision Maker
 * and the operator's confirmation, or by the operator directly), and is then
 * assigned again to the same worker with the question and the answer.
 *
 * Pure: the line's grammar, the per-Task limit, the prompt text the worker
 * reads, and the resume section of the next delivery. No I/O.
 */

export const AMUX_V22_OWNER_QUESTION_MARKER = "AMUX_OWNER_QUESTION:";

/** Questions one Task may ask. The next one blocks the Task for a person. */
export const AMUX_V22_OWNER_QUESTION_LIMIT = 3;

export const AMUX_V22_OWNER_QUESTION_MAX_CHARS = 2_000;
export const AMUX_V22_OWNER_UNBLOCKS_MAX_CHARS = 1_000;
export const AMUX_V22_OWNER_OPTION_LABEL_MAX_CHARS = 300;
export const AMUX_V22_OWNER_OPTIONS_MAX = 6;
export const AMUX_V22_OWNER_ANSWER_MAX_CHARS = 8_000;
/** An answer is also bounded in UTF-8 bytes: it always goes whole into the
 * resumed prompt, never cut. */
export const AMUX_V22_OWNER_ANSWER_MAX_BYTES = 12 * 1_024;

/** The v22 sidecar refuses a prompt over 32 KiB; the resume section keeps
 * the whole prompt under this so a long previous patch is left out instead. */
export const AMUX_V22_RESUME_PROMPT_MAX_BYTES = 30 * 1_024;

export const AMUX_V22_OWNER_QUESTION_STATES =
  ["open", "answered", "resumed", "cancelled"] as const;
export type AmuxV22OwnerQuestionState =
  (typeof AMUX_V22_OWNER_QUESTION_STATES)[number];

export const AMUX_V22_OWNER_ANSWER_SOURCES = ["operator", "dm_confirmed"] as const;
export type AmuxV22OwnerAnswerSource =
  (typeof AMUX_V22_OWNER_ANSWER_SOURCES)[number];

export type AmuxV22OwnerQuestion = {
  question: string;
  unblocks: string;
  options: Array<{ id: string; label: string }>;
};

const OPTION_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const boundedText = (value: unknown, max: number) =>
  typeof value === "string" && value.trim().length > 0 &&
  value.length <= max && !CONTROL.test(value) ? value.trim() : null;

/**
 * The question a result ends with, or null. Only the last non-empty line
 * counts, so a question quoted earlier in the text (a brief, a log) never
 * parks a finished Task. A malformed line is no question: the result is
 * reviewed as it is.
 */
export function parseAmuxV22OwnerQuestion(resultText: string):
  AmuxV22OwnerQuestion | null {
  const lines = resultText.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines.at(-1);
  if (!last?.startsWith(AMUX_V22_OWNER_QUESTION_MARKER)) return null;
  let raw: unknown;
  try { raw = JSON.parse(last.slice(AMUX_V22_OWNER_QUESTION_MARKER.length)); }
  catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const question = boundedText(record.question,
    AMUX_V22_OWNER_QUESTION_MAX_CHARS);
  const unblocks = boundedText(record.unblocks,
    AMUX_V22_OWNER_UNBLOCKS_MAX_CHARS);
  if (!question || !unblocks) return null;
  const rawOptions = record.options ?? [];
  if (!Array.isArray(rawOptions) ||
      rawOptions.length > AMUX_V22_OWNER_OPTIONS_MAX) return null;
  const options: AmuxV22OwnerQuestion["options"] = [];
  for (const item of rawOptions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const option = item as Record<string, unknown>;
    const label = boundedText(option.label,
      AMUX_V22_OWNER_OPTION_LABEL_MAX_CHARS);
    if (typeof option.id !== "string" || !OPTION_ID.test(option.id) ||
        !label || options.some((seen) => seen.id === option.id)) return null;
    options.push({ id: option.id, label });
  }
  return { question, unblocks, options };
}

/** The digest the question row keeps instead of the text (the text stays in
 * the encrypted result body). */
export function amuxV22OwnerQuestionSha256(question: AmuxV22OwnerQuestion) {
  return createHash("sha256").update(JSON.stringify([question.question,
    question.unblocks, question.options.map((option) =>
      [option.id, option.label])]), "utf8").digest("hex");
}

/** An operator's or a confirmed Decision Maker answer, trimmed, or null. */
export function normalizeAmuxV22OwnerAnswer(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\r\n/g, "\n").trim();
  return text.length > 0 && text.length <= AMUX_V22_OWNER_ANSWER_MAX_CHARS &&
    Buffer.byteLength(text, "utf8") <= AMUX_V22_OWNER_ANSWER_MAX_BYTES &&
    !CONTROL.test(text.replace(/[\n\t]/g, " ")) ? text : null;
}

/** Where a v22 settlement sends a Task whose run ended with a question. */
export function amuxV22OwnerQuestionSettlement(sequence: number) {
  return sequence <= AMUX_V22_OWNER_QUESTION_LIMIT ?
    { questionState: "open" as const, reason: "owner_question" as const } :
    { questionState: "cancelled" as const,
      reason: "owner_question_limit" as const };
}

/** Read by every v22 worker, after the authority notice. */
export const AMUX_V22_OWNER_QUESTION_RULES = [
  "Owner questions:",
  "- If you cannot finish without a decision only the owner can make (product behaviour, scope, a choice between real alternatives), do not guess and do not stop with a partial result.",
  "- Instead, finish the run with your work so far and make the very last line of your final message exactly:",
  `  ${AMUX_V22_OWNER_QUESTION_MARKER} {"question":"<one concrete question ending with ?>","unblocks":"<what the answer lets you finish>","options":[{"id":"a","label":"<option>"}]}`,
  "- options may be empty; option ids are lowercase letters, digits, - or _. Ask one question at a time.",
  "- The Task then waits for the answer and comes back to you with the question, the answer and your previous change. It is not finished until its goal is met.",
].join("\n");

const answerLines = (answer: string, source: AmuxV22OwnerAnswerSource) => [
  `The owner answered (${source === "operator" ?
    "operator" : "Decision Maker proposal confirmed by the operator"}):`,
  answer,
].join("\n");

const RESUME_HEAD = "Resuming this Task after an owner question.";
const NO_QUESTION_TEXT = "Your previous run asked the owner a question; its " +
  "text is not repeated here.";

/** The fewest bytes a resume section can take: the answer whole and the
 * line that says what it answers. An answer whose section cannot fit beside
 * the brief is refused when it is given, never cut later. */
export function amuxV22ResumeMinimumBytes(answer: string,
  source: AmuxV22OwnerAnswerSource) {
  return Buffer.byteLength([RESUME_HEAD, NO_QUESTION_TEXT,
    answerLines(answer, source), ""].join("\n"), "utf8");
}

/**
 * The section a resumed delivery starts with: what was asked, what the owner
 * answered, and the previous change. The answer always goes whole. To stay
 * under the prompt bound the section leaves out, in this order, the previous
 * change, the options, what the answer unblocks, and the question text; if
 * even the answer alone does not fit, it is null and the delivery is refused
 * rather than resumed without the decision.
 */
export function buildAmuxV22ResumeSection(input: {
  question: AmuxV22OwnerQuestion | null;
  answer: string;
  answerSource: AmuxV22OwnerAnswerSource;
  previousPatch: string | null;
  promptBytesWithoutSection: number;
}): string | null {
  const budget = AMUX_V22_RESUME_PROMPT_MAX_BYTES - input.promptBytesWithoutSection - 2;
  const answer = answerLines(input.answer, input.answerSource);
  const question = input.question;
  const options = question?.options.length ?
    "Options you gave:\n" + question.options.map((option) =>
      `- ${option.id}: ${option.label}`).join("\n") : null;
  const patch = input.previousPatch ? "Your previous run's change, made on " +
    "that run's base commit. Apply it with `git apply --3way` before you " +
    "continue and resolve whatever does not apply:\n" + input.previousPatch : null;
  const dropped = input.previousPatch ? "Your previous run's change is too " +
    "long to include. Make it again, following the answer." : null;
  const compose = (parts: Array<string | null>) =>
    [...parts.filter((part): part is string => part !== null), ""].join("\n");
  const asked = question ? `Your previous run asked: ${question.question}` :
    NO_QUESTION_TEXT;
  const unblocks = question ? `It said the answer unblocks: ${question.unblocks}` : null;
  for (const parts of [
    [RESUME_HEAD, asked, unblocks, options, answer, patch],
    [RESUME_HEAD, asked, unblocks, options, answer, dropped],
    [RESUME_HEAD, asked, unblocks, answer, dropped],
    [RESUME_HEAD, asked, answer, dropped],
    [RESUME_HEAD, NO_QUESTION_TEXT, answer, dropped],
    [RESUME_HEAD, NO_QUESTION_TEXT, answer],
  ]) {
    const section = compose(parts);
    if (Buffer.byteLength(section, "utf8") <= budget) return section;
  }
  return null;
}

/**
 * What a v22 settlement does with a run that ended with an owner question
 * (the question row recorded with its result), or null for any other run.
 * Such a run is not finished: it is never reviewed, published or graded on
 * its partial change. The Task waits blocked; only a question over the limit
 * opens a human escalation, because an open one waits for its answer.
 */
export function amuxV22OwnerQuestionSettlementPlan(
  question: { state: string } | null) {
  if (!question) return null;
  const open = question.state === "open";
  return { toStatus: "blocked" as const,
    reason: open ? "owner_question" as const : "owner_question_limit" as const,
    openEscalation: !open };
}
