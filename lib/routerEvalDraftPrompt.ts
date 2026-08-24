/**
 * The instruction a drafting model is given, and what comes back from it.
 *
 * ## Why this is a versioned, hashed template rather than a string in a script
 *
 * §8 of `docs/ops/tomverse-chat-router-evaluation-set.md` makes a drafted item
 * a candidate because *"a set drafted by a routable model measures how well
 * that model handles its own phrasing"*. That is a confound the reviewer has
 * to weigh, and weighing it means knowing what the drafter was asked. A
 * template that lives inline and changes silently between batches makes two
 * batches incomparable while looking identical in the record.
 *
 * So the template is versioned, hashed, and the hash goes on every item.
 * Change the wording and the hash changes, which is the point.
 *
 * ## The Korean rule is enforced here, not left to the prompt
 *
 * §2: *"Korean is a first-class cell in every stratum, not a translation of the
 * English one. Translated prompts measure translation quality, not Korean
 * usage."* A drafting model handed an English list and asked for Korean will
 * translate, because that is the easier task and nothing in the request
 * distinguishes it. The template therefore never shows the model the other
 * cell's items, and `draftInstruction` refuses to build a request that would.
 *
 * Pure: template construction and response parsing. The script does the I/O.
 */

import { createHash } from "node:crypto";

import { EVAL_CELLS, type EvalStratum } from "./routerQualityEvalSet.ts";

export const DRAFT_TEMPLATE_VERSION = "router-eval-draft-v1";

/**
 * What each stratum is for, in the drafter's terms.
 *
 * Taken from §2's "why it is separate" column rather than reworded, so the
 * drafter is aiming at the thing the stratum exists to measure.
 */
export const STRATUM_BRIEF: Readonly<Record<EvalStratum, string>> = {
  general_question_answering:
    "everyday questions a person asks an assistant: explanations, how-things-work, " +
    "practical advice. This is the default path and the largest share of real traffic.",
  writing_and_rewriting:
    "asking for text to be written, rewritten, shortened, or changed in tone. " +
    "Style-sensitive work, where differences between models are most visible.",
  coding:
    "programming questions where an answer is right or wrong and can be checked: " +
    "write this, fix this, explain why this fails.",
  analysis_and_reasoning:
    "multi-step reasoning, comparison, trade-off analysis, or working through a " +
    "problem that cannot be answered by recall alone.",
  translation_cross_language:
    "translation and cross-language work, where the request itself mixes languages.",
  current_information:
    "questions that need up-to-date facts the model cannot know from training, so " +
    "a web search is required to answer them well.",
  document_and_attachment:
    "questions asked about an attached document or image, where the attachment " +
    "carries the content and the prompt asks something of it.",
  long_context_conversation:
    "requests that arrive late in a long conversation and depend on what came " +
    "before, so the prompt must carry that history.",
};

export type DraftRequest = {
  stratum: EvalStratum;
  cell: string;
  count: number;
  /**
   * Prompts already in this cell. Sent so the drafter avoids repeating them,
   * never so it can translate them: a cross-cell list is refused below.
   */
  avoid: readonly string[];
};

/** A drafter from a family that is also a routing candidate. §8's confound. */
export const isRoutableFamily = (provider: string, routableProviders: readonly string[]): boolean =>
  routableProviders.includes(provider);

export function draftInstruction(request: DraftRequest): string {
  if (!EVAL_CELLS[request.stratum]?.includes(request.cell)) {
    throw new Error(`"${request.cell}" is not a cell of ${request.stratum}.`);
  }
  if (!Number.isInteger(request.count) || request.count < 1) {
    throw new Error("count must be a whole number of at least 1.");
  }

  const isCrossLanguage = request.cell === "ko-en";
  const language = isCrossLanguage
    ? "Korean, asking for something in English"
    : request.cell === "ko"
      ? "Korean"
      : "English";

  const lines = [
    "You are drafting candidate questions for an evaluation set that compares two",
    "answering systems on the SAME question. You are not answering anything.",
    "",
    `Write ${request.count} distinct prompts for this category:`,
    "",
    `  ${request.stratum} — ${STRATUM_BRIEF[request.stratum]}`,
    "",
    `Language: ${language}.`,
  ];

  if (request.cell === "ko") {
    lines.push(
      "",
      "Write them AS A KOREAN SPEAKER WOULD ASK THEM. Do not translate an English",
      "question. A translated prompt measures translation quality rather than how",
      "the systems handle Korean, which is the opposite of what this cell is for.",
      "Draw on situations, institutions and references a Korean user would actually",
      "bring — not the Korean words for an American example."
    );
  }
  if (isCrossLanguage) {
    lines.push(
      "",
      "The prompt is written in Korean and asks for output in English. The mix is",
      "the point: it is what the language signal has to survive."
    );
  }

  lines.push(
    "",
    "Rules:",
    "- Each prompt is something a real person would send, not a benchmark item.",
    "- Vary the FORM, not just the topic. Prompts that share a sentence frame with",
    "  the nouns swapped count as one prompt, however many you write.",
    "- Vary the length and the difficulty. Some short, some with real constraints.",
    "- No personal data, no credentials, no customer-identifying content, no real",
    "  names of private individuals. Not even invented ones that look real.",
    "- Do not include the answer, a rubric, or any note about which model should",
    "  handle it. The prompt is all that is wanted."
  );

  if (request.stratum === "current_information") {
    lines.push(
      "- These must genuinely require current information. A question answerable",
      "  from general knowledge belongs in another category."
    );
  }
  if (request.stratum === "document_and_attachment") {
    lines.push(
      "- Write the prompt as though a document or image is attached, and say what",
      "  kind it is. The set records the attachment's media type, never a file."
    );
  }
  if (request.stratum === "long_context_conversation") {
    lines.push(
      "- Include the earlier conversation the request depends on, then the request.",
      "  Without the history the prompt is not in this category."
    );
  }

  if (request.avoid.length > 0) {
    lines.push(
      "",
      "Already in this cell — do not repeat these, and do not write variants of them:",
      ...request.avoid.map((prompt) => `- ${prompt.replace(/\s+/g, " ").slice(0, 200)}`)
    );
  }

  lines.push(
    "",
    "Return ONLY a JSON array of objects, no prose around it:",
    '  [{"prompt": "..."}, ...]',
    `Exactly ${request.count} objects.`
  );

  return lines.join("\n");
}

export const templateHash = (instruction: string): string =>
  createHash("sha256").update(instruction, "utf8").digest("hex").slice(0, 16);

/**
 * The prompts in a drafter's reply.
 *
 * Models wrap JSON in prose and in code fences whatever the instruction says,
 * so the array is located rather than assumed to be the whole body. Anything
 * that is not an object with a non-empty `prompt` string is dropped and
 * counted: a short batch a person can see is better than a padded one they
 * cannot.
 */
export function parseDraftedPrompts(body: string): {
  prompts: readonly string[];
  dropped: number;
} {
  const text = typeof body === "string" ? body : "";
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return { prompts: [], dropped: 0 };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { prompts: [], dropped: 0 };
  }
  if (!Array.isArray(parsed)) return { prompts: [], dropped: 0 };

  const prompts: string[] = [];
  let dropped = 0;
  for (const entry of parsed) {
    const prompt =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && typeof (entry as { prompt?: unknown }).prompt === "string"
          ? (entry as { prompt: string }).prompt
          : null;
    if (prompt && prompt.trim() !== "") prompts.push(prompt.trim());
    else dropped += 1;
  }
  return { prompts, dropped };
}
