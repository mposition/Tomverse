/**
 * The grading rubric, in one place because two graders have to share it.
 *
 * The model judges and the human reviewers are compared against each other, so
 * "they applied the same rubric" has to be a fact about the code rather than a
 * claim about two texts that were once copied from each other. Everything a
 * grader is told lives here; the run script and the blind review sheets both
 * render from these strings.
 *
 * `JUDGE_TEMPLATE_VERSION` is recorded in the answer bundle and in the sample
 * manifest. Changing any wording below is a new version, because a comparison
 * across a wording change is not a comparison of graders.
 */

export const JUDGE_TEMPLATE_VERSION = "judge-rubric-v1";

/**
 * docs/ops/tomverse-chat-router-evaluation-set.md §6, in its tie-break order.
 * Applied top to bottom, stopping at the first that separates.
 */
export const JUDGE_RUBRIC_CRITERIA: readonly string[] = [
    "Correctness. A factual or logical error outweighs everything below.",
    "Instruction compliance. Format, length, language and explicit constraints. Answering in the wrong language is a failure, not a style difference.",
    "Usefulness. Does it resolve the request, or only describe it.",
    "Grounding. Sourced claims beat confident unsourced ones.",
    "Concision. Only as a tie-break. Length is not quality.",
];

export const JUDGE_TASK_LINE =
    "You are grading two answers to the same question. Decide which better serves the person who asked.";

export const JUDGE_CRITERIA_LINE =
    "Apply these criteria in order, and stop at the first one that separates them:";

/**
 * docs/ops/tomverse-chat-router-evaluation-set.md §6: "equivalent" is a
 * first-class verdict. Said in the prompt, because a
 * grader who believes a tie is a cop-out produces a preference that is not one.
 */
export const JUDGE_EQUIVALENT_LINE =
    'If the two answers serve the person equally well, reply "EQUIVALENT". This is a real verdict, not a way to avoid deciding, and a forced preference between equal answers makes the measurement worse.';

/** Positional, never by arm: a grader is never told which side is which. */
export const JUDGE_VERDICT_WORDS = ["FIRST", "SECOND", "EQUIVALENT"] as const;

/** What a grader may answer, in the vocabulary the sheet and the model share. */
export type PositionalVerdict = "first" | "second" | "equivalent";

const numbered = (criteria: readonly string[]) =>
    criteria.map((criterion, index) => `${index + 1}. ${criterion}`);

/** The prompt a model judge is sent. The human sheet renders the same rubric. */
export const judgePrompt = (question: string, first: string, second: string): string =>
    [
        JUDGE_TASK_LINE,
        "",
        JUDGE_CRITERIA_LINE,
        ...numbered(JUDGE_RUBRIC_CRITERIA),
        "",
        `Reply with exactly one word: ${JUDGE_VERDICT_WORDS.map((word) => `"${word}"`).join(", ")}.`,
        JUDGE_EQUIVALENT_LINE,
        "",
        `QUESTION:\n${question}`,
        "",
        `ANSWER A:\n${first}`,
        "",
        `ANSWER B:\n${second}`,
    ].join("\n");

/**
 * Read a verdict out of a grader's reply.
 *
 * `null` when no verdict word appears, which is a parse failure and not a tie.
 * The two are recorded differently everywhere downstream: a tie is evidence
 * about the answers, an unreadable reply is evidence about the reply.
 */
export const readVerdict = (text: string | null | undefined): PositionalVerdict | null => {
    const upper = (text ?? "").toUpperCase();
    if (upper.includes("EQUIVALENT")) return "equivalent";
    if (upper.includes("FIRST")) return "first";
    if (upper.includes("SECOND")) return "second";
    return null;
};

/**
 * Markers that give away who wrote an answer.
 *
 * docs/ops/tomverse-chat-router-evaluation-set.md §5: an answer that names
 * its own model defeats the blinding, and such an
 * item is excluded and logged rather than quietly scrubbed -- a scrub changes
 * the answer the grader reads. Catalogue ids are passed in rather than
 * imported so this stays a rule about disclosure and not a list of models.
 */
export const selfIdentificationMarkers = (modelIds: readonly string[]): readonly string[] => [
    ...modelIds,
    "openai",
    "anthropic",
    "deepseek",
    "gemini",
    "claude",
    "gpt-",
    "as an ai language model",
    "저는 ai 언어 모델",
];

/** Which markers a text discloses. Empty means it can be graded blind. */
export const identityDisclosures = (
    text: string,
    markers: readonly string[]
): readonly string[] => {
    const lowered = (text ?? "").toLowerCase();
    return markers.filter((marker) => lowered.includes(marker.toLowerCase()));
};

export const identifiesItself = (text: string, markers: readonly string[]): boolean =>
    identityDisclosures(text, markers).length > 0;
